import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Clock } from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
  type CompilationPlan,
  type ConcernRecord,
  type EndocrineNightVerdict,
  type HormoneState,
  type PersonaConfig,
  type PulseEvaluation,
  PulseEvaluationSchema,
  type SubconsciousHandover,
} from "../core/schemas.ts";
import {
  type ResolvedEndocrineProfile,
  resolvePersonaProfile,
} from "../endocrine/archetypes.ts";
import {
  applyEndocrineCalibrationGates,
  type EndocrineTurnOutcome,
} from "../endocrine/evaluator.ts";
import {
  buildSubconsciousHandover,
  settleNightlyConcerns,
} from "../endocrine/handover.ts";
import {
  createInitialHormoneState,
  stepHormones,
} from "../endocrine/hormones.ts";
import {
  appendHotJournalEntry,
  synthesizeBedtimeReflection,
} from "../frontstage/journal.ts";
import { performFrontstageTurn } from "../frontstage/performer.ts";
import { createSilentWorkerTool } from "../frontstage/silent-worker.ts";
import {
  type NightlyCompileResult,
  reconcileSynchronicLinksToInactiveFiles,
  runNightlyCompiler,
} from "../hippocampus/compiler.ts";
import {
  type DecayArchiveReport,
  reconsolidateRecalledMemories,
  runDailyMemoryDecayAndArchive,
  syncMemoryMetaFromFiles,
} from "../hippocampus/decay.ts";
import {
  type LintReport,
  runMemoryLinter,
} from "../hippocampus/linter.ts";
import {
  type RecallResult,
  recallMemories,
} from "../hippocampus/recall.ts";
import type { OrganModelRouter } from "../llm/router.ts";
import type {
  ChatMessage,
  SandwichRequest,
  ZodTool,
} from "../llm/types.ts";
import { recordUserMessageReceived } from "../reflex/guard.ts";

export interface EchoreEngineOptions {
  clock: Clock;
  db: EchoreDatabase;
  memoryDir: string;
  persona: PersonaConfig;
  router: OrganModelRouter;
  frontstageTools?: ZodTool[];
  workerTools?: ZodTool[];
}

export interface ReactiveTurnOptions {
  perceptionSlice?: string;
  secretPrepNote?: string;
  /** 可选注入情绪官脉冲评估结果（或由 endocrine 路由模型自动评估） */
  pulseOverride?: Partial<PulseEvaluation>;
}

export interface ReactiveTurnOutput {
  userEventId: string;
  assistantEventId: string;
  reply: string;
  handover: SubconsciousHandover;
  recalled: RecallResult;
  hormoneState: HormoneState;
  endocrineOutcome: EndocrineTurnOutcome;
  journalEntry: string;
  sandwichRequest: SandwichRequest;
}

export interface SleepCycleOptions {
  /** 可选直接指定前台睡前自省冷叙事文本（不传则由 frontstage 模型汇总当日热记事生成） */
  overrideReflectionText?: string;
  /** 可选直接注入记忆官编译计划（不传则由 compiler 模型根据今日日志生成） */
  compilationPlanOverride?: CompilationPlan;
  /** 本轮衰减跨越天数（默认 1 天） */
  elapsedDecayDays?: number;
  /** 是否在 L1~L6 体检通过后对独立记忆仓执行 git commit（默认 true） */
  autoGitCommit?: boolean;
}

export interface SleepCycleOutput {
  dateStr: string;
  coldReflection: string;
  verdict: EndocrineNightVerdict;
  compileResult: NightlyCompileResult;
  decayReport: DecayArchiveReport;
  lintReport: LintReport;
  gitCommitHash: string | null;
}

function commitStandaloneMemoryRepo(
  memoryDir: string,
  dateStr: string,
): string | null {
  const resolvedMem = path.resolve(memoryDir);
  const resolvedCwd = path.resolve(process.cwd());
  // 安全护栏：绝不在源码主仓目录内直接初始化或污染宿主 git 历史
  if (
    resolvedMem === resolvedCwd ||
    resolvedMem.startsWith(`${resolvedCwd}${path.sep}`)
  ) {
    return null;
  }

  const gitDir = path.join(resolvedMem, ".git");
  if (!fs.existsSync(gitDir)) {
    const initRes = spawnSync("git", ["init"], {
      cwd: resolvedMem,
      encoding: "utf8",
    });
    if (initRes.status !== 0) return null;
    spawnSync("git", ["config", "user.name", "Echore Hippocampus"], {
      cwd: resolvedMem,
    });
    spawnSync("git", ["config", "user.email", "hippocampus@echore.local"], {
      cwd: resolvedMem,
    });
  }

  spawnSync("git", ["add", "-A"], { cwd: resolvedMem });
  const statusRes = spawnSync("git", ["status", "--porcelain"], {
    cwd: resolvedMem,
    encoding: "utf8",
  });
  if (!statusRes.stdout || !statusRes.stdout.trim()) {
    const headRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: resolvedMem,
      encoding: "utf8",
    });
    return headRes.status === 0 ? headRes.stdout.trim() : null;
  }

  const commitRes = spawnSync(
    "git",
    ["commit", "-m", `chore(memory): nightly sleep consolidation ${dateStr}`],
    {
      cwd: resolvedMem,
      encoding: "utf8",
    },
  );
  if (commitRes.status !== 0) return null;

  const revRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: resolvedMem,
    encoding: "utf8",
  });
  return revRes.status === 0 ? revRes.stdout.trim() : null;
}

/**
 * Echore 主循环总控（M1 串通【环 1：实时交互环 Reactive Loop】）
 */
export class EchoreEngine {
  readonly clock: Clock;
  readonly db: EchoreDatabase;
  readonly memoryDir: string;
  readonly profile: ResolvedEndocrineProfile;
  readonly router: OrganModelRouter;
  private readonly frontstageTools: ZodTool[];
  private readonly appendOnlyHistory: ChatMessage[] = [];

  constructor(options: EchoreEngineOptions) {
    this.clock = options.clock;
    this.db = options.db;
    this.memoryDir = options.memoryDir;
    this.profile = resolvePersonaProfile(options.persona);
    this.router = options.router;

    const silentWorkerTool = createSilentWorkerTool(
      this.router,
      options.workerTools ?? [],
    );
    this.frontstageTools = [
      silentWorkerTool,
      ...(options.frontstageTools ?? []),
    ];

    // Ensure hormone state is initialized with resolved persona baseline if brand new
    const existingLogs = this.db.getRecentEventLogs(1);
    if (existingLogs.length === 0) {
      const initHormones = createInitialHormoneState(
        this.profile,
        this.clock.now(),
      );
      this.db.saveHormoneState(initHormones);
    }
  }

  getHistory(): readonly ChatMessage[] {
    return this.appendOnlyHistory;
  }

  private loadRapportMarkdown(): string {
    const rapportPath = path.join(this.memoryDir, "implicit", "rapport.md");
    if (!fs.existsSync(rapportPath)) return "";
    return fs.readFileSync(rapportPath, "utf8");
  }

  private async evaluatePulseWithOrgan(params: {
    userMessage: string;
    rapportMarkdown: string;
    recentHistory: readonly ChatMessage[];
    activeConcerns: readonly ConcernRecord[];
    override?: Partial<PulseEvaluation>;
  }): Promise<PulseEvaluation> {
    const {
      userMessage,
      rapportMarkdown,
      recentHistory,
      activeConcerns,
      override,
    } = params;

    if (override) {
      return PulseEvaluationSchema.parse({
        event_summary: override.event_summary ?? userMessage.slice(0, 60),
        confidence: override.confidence ?? 0.9,
        ...override,
      });
    }

    const route = this.router.getRoute("endocrine");
    const system = [
      "你是 Echore 的后台情绪官（内分泌脉冲评估器）。",
      "请结合「常驻默契滤网（rapport.md）」、「最近对话上下文」与「当前活跃牵挂注」评估用户最新话语的情绪脉冲，只输出合法的 JSON 对象。",
      "JSON 字段规范：",
      "- event_summary (string): 本轮互动简述",
      "- confidence (number, 0~1): 语义判断置信度（似嗔似笑或语境模糊时给 < 0.75）",
      "- is_conflict (boolean): 是否构成真实冒犯/冲突",
      "- is_reconciliation (boolean): 用户是否在真诚道歉、解释清楚或哄好已有牵挂",
      "- is_warm (boolean), is_novel (boolean), matched_rapport_joke (boolean)",
      "- triggered_scar_zone (string, optional): 若触碰结痂雷区则填写雷区标签",
      "- cortisol_delta (-1~1), oxytocin_delta (-1~1), dopamine_delta (-1~1)",
      "- new_concern (optional): { id?: string, tier: 'minor_worry' | 'conflict' | 'scar', summary: string, floor_cort?: number }（当产生新的日常惦记或实质冲突时必填）",
      "- reconciled_concern_ids (string[]): 被本轮和解消除的活跃牵挂 ID 列表",
      "- ambiguity_probe_hint (string, optional): 置信度 < 0.75 时递给前台的试探基调提示",
    ].join("\n");

    const recentTurnsText =
      recentHistory.length > 0
        ? recentHistory
            .slice(-6)
            .map((m) => `${m.role === "user" ? "用户" : "我"}: ${m.content}`)
            .join("\n")
        : "（暂无前序对话）";

    const activeConcernsText =
      activeConcerns.length > 0
        ? activeConcerns
            .map(
              (c) =>
                `- id: ${c.id} | tier: ${c.tier} | status: ${c.status} | summary: ${c.summary}`,
            )
            .join("\n")
        : "（当前无活跃牵挂）";

    const resp = await route.provider.generate({
      model: route.model,
      maxTokens: 512,
      system,
      messages: [
        {
          role: "user",
          content: [
            `[默契滤网]\n${rapportMarkdown || "（无）"}`,
            `[当前活跃牵挂注]\n${activeConcernsText}`,
            `[最近对话上下文]\n${recentTurnsText}`,
            `[用户最新话语]\n${userMessage}`,
          ].join("\n\n"),
        },
      ],
    });

    try {
      const jsonMatch = resp.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = PulseEvaluationSchema.parse(JSON.parse(jsonMatch[0]));
        // 若情绪官 LLM 判定为高置信度冲突但漏填 new_concern，自动基于 event_summary 补齐牵挂规格以防被孤儿门误杀
        if (
          parsed.is_conflict &&
          parsed.confidence >= 0.75 &&
          parsed.cortisol_delta > 0.1 &&
          !parsed.new_concern &&
          activeConcerns.length === 0 &&
          parsed.event_summary.trim()
        ) {
          parsed.new_concern = {
            tier: "conflict",
            summary: parsed.event_summary.trim(),
          };
        }
        return parsed;
      }
    } catch {
      // Fallback to neutral calm pulse if endocrine LLM output is non-JSON
    }

    return PulseEvaluationSchema.parse({
      event_summary: `日常对话：${userMessage.slice(0, 40)}`,
      confidence: 0.9,
      is_warm: true,
      oxytocin_delta: 0.03,
      dopamine_delta: 0.02,
    });
  }

  /**
   * 【环 1：实时交互环 Reactive Loop】
   * 1. 落盘 SQLite Event Log (log-*) + 重置反射层主动未回退避锁
   * 2. [记忆官] 三桶五路召回 Top 10 + 原话引文预水合
   * 3. [情绪官] 推进激素实时衰减 + 挂载 rapport.md 过出厂前四道调准 → 生成零数字《潜意识心境交接单》
   * 4. [前台] 三明治顺序组装上下文 → 对话回复（支持轻工具与无声替身 Subagent）
   * 5. 追加当日 journal/YYYY-MM-DD.md 第一人称热记事
   */
  async onUserMessage(
    userMessage: string,
    options: ReactiveTurnOptions = {},
  ): Promise<ReactiveTurnOutput> {
    const now = this.clock.now();
    const nowIso = this.clock.nowIso();

    // Step 1: 落盘 SQLite Event Log & 更新反射层
    const userEvent = this.db.appendEventLog({
      role: "user",
      speaker: "user",
      content: userMessage,
      timestamp: nowIso,
    });

    const nextReflex = recordUserMessageReceived(
      this.db.getReflexState(),
      nowIso,
    );
    this.db.saveReflexState(nextReflex);

    const activeConcernsBefore = this.db.listActiveConcerns();
    const rapportMarkdown = this.loadRapportMarkdown();

    // Step 2: [记忆官] 三桶五路召回 + 原话引文预水合
    const recalled = recallMemories({
      memoryDir: this.memoryDir,
      db: this.db,
      query: userMessage,
      now,
      activeConcerns: activeConcernsBefore,
    });

    // Step 3: [情绪官] 推进实时激素衰减 + 出厂前四道调准 + 生成零数字交接单
    const steppedHormones = stepHormones({
      state: this.db.getHormoneState(),
      profile: this.profile,
      now,
      activeConcerns: activeConcernsBefore,
    });

    const rawPulse = await this.evaluatePulseWithOrgan({
      userMessage,
      rapportMarkdown,
      recentHistory: this.appendOnlyHistory,
      activeConcerns: activeConcernsBefore,
      override: options.pulseOverride,
    });

    const endocrineOutcome = applyEndocrineCalibrationGates(
      {
        userMessage,
        sourceEventId: userEvent.id,
        rapportContent: rapportMarkdown,
        hormoneState: steppedHormones,
        profile: this.profile,
        activeConcerns: activeConcernsBefore,
        now,
        rawPulse,
      },
      this.db,
    );

    // §4.3 再巩固正反馈（正向互动 +0.05，负面冲突/未落定牵挂只增 access_count 绝不上调 strength）
    const isNegativeOrConflictTurn =
      rawPulse.is_conflict ||
      endocrineOutcome.hormoneState.cortisol > steppedHormones.cortisol;
    reconsolidateRecalledMemories({
      db: this.db,
      memoryDir: this.memoryDir,
      recalledItems: recalled.items,
      isNegativeOrConflictTurn,
      now,
    });

    const handover = buildSubconsciousHandover({
      hormoneState: endocrineOutcome.hormoneState,
      profile: this.profile,
      activeConcerns: endocrineOutcome.activeConcerns,
      db: this.db,
      now,
      ambiguityProbeHint: endocrineOutcome.ambiguityProbeHint,
      fastReliefApplied: endocrineOutcome.fastReliefApplied,
    });

    // Step 4: [前台] 三明治缓存组装 + 第一人称实时对话演奏
    const performance = await performFrontstageTurn({
      router: this.router,
      profile: this.profile,
      rawRapportMarkdown: rapportMarkdown,
      tools: this.frontstageTools,
      appendOnlyHistory: this.appendOnlyHistory,
      handover,
      recallResult: recalled,
      perceptionSlice: options.perceptionSlice,
      secretPrepNote: options.secretPrepNote,
      latestUserMessage: userMessage,
    });

    // Append to append-only conversation history (never rewrite old turns)
    this.appendOnlyHistory.push({
      role: "user",
      content: userMessage,
    });
    this.appendOnlyHistory.push({
      role: "assistant",
      content: performance.replyText,
    });

    const assistantEvent = this.db.appendEventLog({
      role: "assistant",
      speaker: this.profile.name,
      content: performance.replyText,
      timestamp: this.clock.nowIso(),
    });

    // Step 5: 追加当日 journal/YYYY-MM-DD.md 第一人称热记事
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const mm = String(now.getUTCMinutes()).padStart(2, "0");
    const journalEntry = appendHotJournalEntry({
      memoryDir: this.memoryDir,
      dateStr: this.clock.todayStr(),
      timeStr: `${hh}:${mm}`,
      tag: "交互",
      firstPersonText: `今天和他就“${userMessage.slice(0, 30)}”聊了几句，我回他：“${performance.replyText.slice(0, 60)}”`,
    });

    return {
      userEventId: userEvent.id,
      assistantEventId: assistantEvent.id,
      reply: performance.replyText,
      handover,
      recalled,
      hormoneState: endocrineOutcome.hormoneState,
      endocrineOutcome,
      journalEntry,
      sandwichRequest: performance.sandwichRequest,
    };
  }

  /**
   * 【环 3：昼夜新陈代谢环 Circadian Sleep Loop】（§1.2 & §6.4）
   * Step 1 [前台] 汇总当日交互与独居热记事，撰写第一人称睡前自省冷叙事（保住自传产权）
   * Step 2 [情绪官] 肝脏结算：出具《情绪结转裁决单》(T1 满 7 天淡化 / T2 满 5 天转冷战封顶 / T3 满 21 天留疤 / 日内和解落定)
   * Step 3 [记忆官] 唯一编译器：更新 people/ events/ concerns/ rapport.md，维护 supersedes 取代链并保留前台原叙
   * Step 4 [系统] 分品类定步长衰减 + status:已沉底 归档 + 跑通 L1~L6 体检 + 自动 git commit
   */
  async runSleepCycle(
    options: SleepCycleOptions = {},
  ): Promise<SleepCycleOutput> {
    const now = this.clock.now();
    const dateStr = this.clock.todayStr();

    const currentHormones = stepHormones({
      state: this.db.getHormoneState(),
      profile: this.profile,
      now,
      activeConcerns: this.db.listActiveConcerns(),
    });
    this.db.saveHormoneState(currentHormones);

    const currentHandover = buildSubconsciousHandover({
      hormoneState: currentHormones,
      profile: this.profile,
      activeConcerns: this.db.listActiveConcerns(),
      db: this.db,
      now,
    });

    // Step 1: [前台] 撰写第一人称睡前自省冷叙事
    const coldReflection = await synthesizeBedtimeReflection({
      router: this.router,
      profile: this.profile,
      memoryDir: this.memoryDir,
      dateStr,
      now,
      handover: currentHandover,
      overrideReflectionText: options.overrideReflectionText,
    });

    // Step 2: [情绪官] 夜间肝脏结算，出具《情绪结转裁决单》
    const verdict = settleNightlyConcerns({
      db: this.db,
      profile: this.profile,
      now,
    });

    // Step 3: [记忆官] 唯一 Markdown 编译器落盘结构化断言与 rapport.md
    const compileResult = await runNightlyCompiler({
      memoryDir: this.memoryDir,
      db: this.db,
      router: this.router,
      now,
      dateStr,
      verdict,
      coldReflection,
      planOverride: options.compilationPlanOverride,
    });

    // Step 4: [系统] 分品类定步长衰减 + status:已沉底 归档 + L1~L6 终检 + git commit
    const decayReport = runDailyMemoryDecayAndArchive({
      memoryDir: this.memoryDir,
      db: this.db,
      now,
      elapsedDays: options.elapsedDecayDays ?? 1,
    });

    if (decayReport.archivedIds.length > 0) {
      reconcileSynchronicLinksToInactiveFiles({
        memoryDir: this.memoryDir,
      });
      syncMemoryMetaFromFiles({
        memoryDir: this.memoryDir,
        db: this.db,
        now,
      });
    }

    const lintReport = runMemoryLinter({
      memoryDir: this.memoryDir,
      db: this.db,
      now,
    });

    if (!lintReport.passed) {
      const details = lintReport.issues
        .map((i) => `[${i.rule}] ${i.file}: ${i.message}`)
        .join("; ");
      throw new Error(
        `[MemoryCILinterFailed] 夜间冷写未通过 L1~L6 机检守卫，拒绝提交: ${details}`,
      );
    }

    const gitCommitHash =
      options.autoGitCommit !== false
        ? commitStandaloneMemoryRepo(this.memoryDir, dateStr)
        : null;

    return {
      dateStr,
      coldReflection,
      verdict,
      compileResult,
      decayReport,
      lintReport,
      gitCommitHash,
    };
  }
}
