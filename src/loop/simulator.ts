import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../core/clock.ts";
import { EchoreDatabase } from "../core/db.ts";
import type { ConcernRecord, HormoneState } from "../core/schemas.ts";
import { OrganModelRouter } from "../llm/router.ts";
import type { LLMProvider } from "../llm/types.ts";
import {
  EchoreEngine,
  type HeartbeatBranch,
  type SleepCycleOutput,
} from "./engine.ts";

export interface FastForwardOptions {
  /** 每次心跳推进的分钟数（默认：<= 24h 为 15 分钟，跨多天仿真默认 60 分钟；上限 180 分钟以防跳过 7h 睡眠窗口） */
  stepMinutes?: number;
  /** 是否在夜间自动生成的环 3 睡眠周期中禁用 git commit（默认 false，测试可设 true） */
  disableGitCommit?: boolean;
  /** 可选透传给夜间环 3 的 SleepCycleOptions（不传则交由 compiler 岗位模型正常编译） */
  sleepCycleOptions?: Omit<
    import("./engine.ts").SleepCycleOptions,
    "autoGitCommit"
  >;
}

export interface SimulationHormonePoint {
  timestamp: string;
  cortisol: number;
  oxytocin: number;
  dopamine: number;
  melatonin: number;
  floor_cort: number;
  cap_ox: number;
  branch: HeartbeatBranch;
}

export interface SimulationReport {
  durationSpec: string;
  startTimeIso: string;
  endTimeIso: string;
  totalTicks: number;
  elapsedHours: number;
  daysCrossed: number;
  branchCounts: Record<HeartbeatBranch, number>;
  solitaryArtifacts: string[];
  proactiveMessages: string[];
  sleepCycles: SleepCycleOutput[];
  finalHormoneState: HormoneState;
  finalConcerns: ConcernRecord[];
  archivedMemoryIds: string[];
  hormoneTimeline: SimulationHormonePoint[];
  dashboardText: string;
}

/**
 * 解析时间快进表达式（如 "4h", "5d", "15d", "90m"）为总分钟数
 */
export function parseDurationToMinutes(spec: string | number): number {
  if (typeof spec === "number") {
    if (!Number.isFinite(spec) || spec <= 0) {
      throw new Error(`Invalid duration minutes: ${spec}`);
    }
    return Math.round(spec);
  }

  const trimmed = spec.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days)$/);
  if (!match) {
    throw new Error(
      `Unsupported duration format "${spec}". Expected e.g. "4h", "5d", "15d", "90m".`,
    );
  }

  const val = Number(match[1]);
  const unit = match[2]!;
  if (unit.startsWith("d")) {
    return Math.round(val * 24 * 60);
  }
  if (unit.startsWith("h")) {
    return Math.round(val * 60);
  }
  return Math.round(val);
}

/**
 * §7.1 & §7.3 时间快进仿真台（Time-Travel CLI & Simulator）
 * 支持虚拟时钟一键快进 4h / 5d / 15d，直观验收冷战催产素封顶、独居攒谈资与记忆沉底全过程。
 */
export class TimeTravelSimulator {
  readonly engine: EchoreEngine;

  constructor(engine: EchoreEngine) {
    this.engine = engine;
  }

  async fastForward(
    durationSpec: string | number,
    options: FastForwardOptions = {},
  ): Promise<SimulationReport> {
    const totalMinutes = parseDurationToMinutes(durationSpec);
    const defaultStep = totalMinutes > 24 * 60 ? 60 : 15;
    // 单步跨度上限设为 180 分钟（3h），确保绝不会一步跨过 7 小时的夜间睡眠锁窗口
    const stepMinutes = Math.min(
      180,
      Math.max(1, options.stepMinutes ?? defaultStep),
    );

    const startTimeIso = this.engine.clock.nowIso();
    const startDateStr = this.engine.clock.todayStr();
    const seenDates = new Set<string>([startDateStr]);

    const branchCounts: Record<HeartbeatBranch, number> = {
      idle: 0,
      solitary: 0,
      proactive: 0,
      sleep_cycle: 0,
    };

    const solitaryArtifacts: string[] = [];
    const proactiveMessages: string[] = [];
    const sleepCycles: SleepCycleOutput[] = [];
    const archivedSet = new Set<string>();
    const hormoneTimeline: SimulationHormonePoint[] = [];

    let remaining = totalMinutes;
    let totalTicks = 0;

    while (remaining > 0) {
      const step = Math.min(stepMinutes, remaining);
      this.engine.clock.advanceMinutes(step);
      remaining -= step;
      totalTicks += 1;

      seenDates.add(this.engine.clock.todayStr());

      const hb = await this.engine.onHeartbeat({
        sleepCycleOptions: {
          ...options.sleepCycleOptions,
          autoGitCommit: !options.disableGitCommit,
        },
      });

      branchCounts[hb.branch] += 1;

      if (hb.branch === "solitary" && hb.solitaryResult) {
        solitaryArtifacts.push(hb.solitaryResult.artifactRelPath);
      } else if (hb.branch === "proactive" && hb.proactiveMessage) {
        proactiveMessages.push(hb.proactiveMessage);
      } else if (hb.branch === "sleep_cycle" && hb.sleepCycleOutput) {
        sleepCycles.push(hb.sleepCycleOutput);
        for (const id of hb.sleepCycleOutput.decayReport.archivedIds) {
          archivedSet.add(id);
        }
      }

      if (
        hb.branch !== "idle" ||
        totalTicks === 1 ||
        remaining === 0 ||
        totalTicks % 24 === 0
      ) {
        hormoneTimeline.push({
          timestamp: this.engine.clock.nowIso(),
          cortisol: hb.hormoneState.cortisol,
          oxytocin: hb.hormoneState.oxytocin,
          dopamine: hb.hormoneState.dopamine,
          melatonin: hb.hormoneState.melatonin,
          floor_cort: hb.hormoneState.floor_cort,
          cap_ox: hb.hormoneState.cap_ox,
          branch: hb.branch,
        });
      }
    }

    const endTimeIso = this.engine.clock.nowIso();
    const finalHormoneState = this.engine.db.getHormoneState();
    const finalConcerns = this.engine.db.listAllConcerns();
    const archivedMemoryIds = [...archivedSet];
    const daysCrossed = Math.max(0, seenDates.size - 1);
    const elapsedHours = Number((totalMinutes / 60).toFixed(2));

    const dashboardText = this.formatDashboard({
      durationSpec: String(durationSpec),
      startTimeIso,
      endTimeIso,
      totalTicks,
      elapsedHours,
      daysCrossed,
      branchCounts,
      solitaryArtifacts,
      proactiveMessages,
      sleepCycles,
      finalHormoneState,
      finalConcerns,
      archivedMemoryIds,
    });

    return {
      durationSpec: String(durationSpec),
      startTimeIso,
      endTimeIso,
      totalTicks,
      elapsedHours,
      daysCrossed,
      branchCounts,
      solitaryArtifacts,
      proactiveMessages,
      sleepCycles,
      finalHormoneState,
      finalConcerns,
      archivedMemoryIds,
      hormoneTimeline,
      dashboardText,
    };
  }

  private formatDashboard(summary: {
    durationSpec: string;
    startTimeIso: string;
    endTimeIso: string;
    totalTicks: number;
    elapsedHours: number;
    daysCrossed: number;
    branchCounts: Record<HeartbeatBranch, number>;
    solitaryArtifacts: string[];
    proactiveMessages: string[];
    sleepCycles: SleepCycleOutput[];
    finalHormoneState: HormoneState;
    finalConcerns: ConcernRecord[];
    archivedMemoryIds: string[];
  }): string {
    const h = summary.finalHormoneState;
    const concernLines =
      summary.finalConcerns.length > 0
        ? summary.finalConcerns
            .map(
              (c) =>
                `  - [${c.id}] tier=${c.tier} | status=${c.status} | cap_ox=${c.cap_ox} | has_prep=${c.has_prep}`,
            )
            .join("\n")
        : "  （无牵挂记录）";

    return [
      `=== Echore 时间快进仿真台 (${summary.durationSpec}) ===`,
      `时间跨度: ${summary.startTimeIso} -> ${summary.endTimeIso} (${summary.elapsedHours}h / 跨 ${summary.daysCrossed} 昼夜 / 共 ${summary.totalTicks} 跳)`,
      `分支统计: 静默(idle)=${summary.branchCounts.idle} | 独居(solitary)=${summary.branchCounts.solitary} | 主动破冰(proactive)=${summary.branchCounts.proactive} | 睡眠代谢(sleep_cycle)=${summary.branchCounts.sleep_cycle}`,
      `终态激素: Cortisol=${h.cortisol} (Floor=${h.floor_cort}) | Oxytocin=${h.oxytocin} (Cap=${h.cap_ox}) | Dopamine=${h.dopamine} | Melatonin=${h.melatonin}`,
      `独居物证 (${summary.solitaryArtifacts.length}): ${summary.solitaryArtifacts.join(", ") || "无"}`,
      `沉底归档 (${summary.archivedMemoryIds.length}): ${summary.archivedMemoryIds.join(", ") || "无"}`,
      `牵挂演化:\n${concernLines}`,
    ].join("\n");
  }
}

/**
 * CLI 入口：`ECHORE_DATA_DIR=~/.echore/test bun run src/loop/simulator.ts 5d`
 */
if (import.meta.main) {
  const argSpec = process.argv[2] || "4h";
  const baseDir =
    process.env.ECHORE_DATA_DIR?.replace(/^~\//, `${os.homedir()}/`) ??
    path.join(os.homedir(), ".echore", "test");
  const simDir = path.join(baseDir, `sim-${Date.now()}`);
  const memoryDir = path.join(simDir, "memory");
  fs.mkdirSync(path.join(memoryDir, "people"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "events"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "concerns"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "implicit"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "journal"), { recursive: true });

  fs.writeFileSync(
    path.join(memoryDir, "people", "user.md"),
    [
      "---",
      "id: user",
      "type: 符号定义",
      "date: 2026-11-01",
      "status: 有效",
      "category: preference",
      "allow_forget: false",
      "---",
      "定义([[people/user]], 主互动伙伴)",
      "",
    ].join("\n"),
    "utf8",
  );

  const localProvider: LLMProvider = {
    providerName: "simulator-local",
    async generate() {
      return {
        text: "我趁着闲暇整理了一段随手笔记，顺便翻了翻书。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
    async generateSandwich() {
      return {
        text: "我在这儿呢，刚把手头的笔记收好。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
  };

  const clock = new VirtualClock(new Date(2026, 10, 10, 14, 0, 0));
  const db = new EchoreDatabase({
    dbPath: path.join(simDir, "echore.sqlite"),
    clock,
  });
  const router = new OrganModelRouter({ defaultProvider: localProvider });
  const engine = new EchoreEngine({
    clock,
    db,
    memoryDir,
    persona: {
      name: "林栖",
      archetype: "cat_aloof",
      chronotype: "regular",
    },
    router,
  });

  const sim = new TimeTravelSimulator(engine);
  const report = await sim.fastForward(argSpec, { disableGitCommit: true });
  console.log(report.dashboardText);
  db.close();
}
