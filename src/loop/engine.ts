import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Clock, formatLocalDateStr, formatLocalTimeHm } from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import { PROMPTS_DIR, readPrompt } from "../core/prompts.ts";
import {
  assertNoInternalLeaks,
  type CompilationPlan,
  type ConcernRecord,
  type EndocrineNightVerdict,
  type HormoneState,
  type PersonaConfig,
  type PulseEvaluation,
  PulseEvaluationSchema,
  type ReflexState,
  type SolitaryActionKind,
  type SubconsciousHandover,
  type WeatherSnapshot,
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
  renderHandoverYaml,
  settleNightlyConcerns,
} from "../endocrine/handover.ts";
import {
  createInitialHormoneState,
  isDefensiveOrTense,
  isInBoredZone,
  isInMissingZone,
  stepHormones,
} from "../endocrine/hormones.ts";
import {
  appendHotJournalEntry,
  extractColdReflectionForDate,
  extractHotEntriesForDate,
  synthesizeBedtimeReflection,
} from "../frontstage/journal.ts";
import {
  performFrontstageTurn,
  sanitizeRapportForFrontstage,
} from "../frontstage/performer.ts";
import { createSilentWorkerTool } from "../frontstage/silent-worker.ts";
import {
  extractSecretPrepForConcern,
  runSolitaryTick,
  type SolitaryTickResult,
} from "../frontstage/solitary.ts";
import {
  type NightlyCompileResult,
  reconcileSynchronicLinksToInactiveFiles,
  runNightlyCompiler,
} from "../hippocampus/compiler.ts";
import {
  type DecayArchiveReport,
  type RecallBatchSnapshot,
  reconsolidateRecalledMemories,
  recordMemoryTransitions,
  runDailyMemoryDecayAndArchive,
  syncMemoryMetaFromFiles,
  syncSingleMemoryMetaFile,
} from "../hippocampus/decay.ts";
import {
  type LintReport,
  runMemoryLinter,
} from "../hippocampus/linter.ts";
import {
  isIdleQuery,
  isStanceCue,
  type RecallResult,
  recallMemories,
  type StanceBinaryVerifier,
  verifyStanceCueWithOrgan,
} from "../hippocampus/recall.ts";
import type { OrganModelRouter } from "../llm/router.ts";
import type {
  ChatMessage,
  SandwichRequest,
  ZodTool,
} from "../llm/types.ts";
import {
  type ChronoAmbientSlice,
  evaluateChronoAmbient,
} from "../perception/chrono-ambient.ts";
import {
  type DesktopPresenceResult,
  type DesktopWindowSample,
  evaluateDesktopPresence,
} from "../perception/desktop-probe.ts";
import type { WorldFeedFetcher } from "../perception/world-feed.ts";
import {
  CHRONOTYPE_SCHEDULES,
  evaluateReflexGuard,
  getCircadianDateStr,
  getDecimalHour,
  type ReflexEvaluation,
  recordProactiveSent,
  recordUserMessageReceived,
} from "../reflex/guard.ts";

export interface EchoreEngineOptions {
  clock: Clock;
  db: EchoreDatabase;
  memoryDir: string;
  persona: PersonaConfig;
  router: OrganModelRouter;
  frontstageTools?: ZodTool[];
  workerTools?: ZodTool[];
  /** 提示词目录，缺省仓库 prompts/（测试可换临时目录） */
  promptsDir?: string;
  /** 可选注入立场锚二段复筛器（缺省按 endocrine 路由调用） */
  stanceBinaryVerifier?: StanceBinaryVerifier;
  stanceVerifyTimeoutMs?: number;
}

export interface ReactiveTurnOptions {
  perceptionSlice?: string;
  secretPrepNote?: string;
  weather?: WeatherSnapshot;
  desktopSamples?: DesktopWindowSample[];
  isHolidayOrAnniversary?: string;
  userActiveLateNight?: boolean;
  /** 可选注入情绪官脉冲评估结果（或由 endocrine 路由模型自动评估） */
  pulseOverride?: Partial<PulseEvaluation>;
  stanceBinaryVerifier?: StanceBinaryVerifier;
  stanceVerifyTimeoutMs?: number;
}

export interface WhatIfProbeScenario {
  userMessage?: string;
  fastForwardMinutes?: number;
  queryEmbedding?: number[];
  stanceCueOverride?: boolean;
}

export interface WhatIfProbeResult {
  probeNowIso: string;
  hormoneState: HormoneState;
  handover: SubconsciousHandover;
  recalled?: RecallResult;
}

export interface RollbackSnapshotResult {
  restored: boolean;
  action: "deleted_creation" | "restored_content" | "not_found";
  relPath?: string;
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
  consumedPrepConcernIds?: string[];
}

export type HeartbeatBranch = "sleep_cycle" | "proactive" | "solitary" | "idle";
export type ProactiveTriggerReason =
  | "weather_or_long_focus"
  | "secret_prep_ready"
  | "missing_user";

export interface HeartbeatOptions {
  weather?: WeatherSnapshot;
  isHolidayOrAnniversary?: string;
  userActiveLateNight?: boolean;
  desktopSamples?: DesktopWindowSample[];
  solitaryActionKind?: SolitaryActionKind;
  feedFetcher?: WorldFeedFetcher;
  overrideProactiveText?: string;
  overrideSolitaryNoteText?: string;
  sleepCycleOptions?: SleepCycleOptions;
}

export interface HeartbeatOutput {
  branch: HeartbeatBranch;
  hormoneState: HormoneState;
  reflexState: ReflexState;
  reflexEvaluation: ReflexEvaluation;
  chronoAmbient: ChronoAmbientSlice;
  desktopPresence: DesktopPresenceResult;
  proactiveTrigger?: ProactiveTriggerReason;
  proactiveMessage?: string;
  proactiveEventId?: string;
  solitaryResult?: SolitaryTickResult;
  sleepCycleOutput?: SleepCycleOutput;
}

export interface SleepCycleOptions {
  /** 可选显式指定结算目标日（默认按住户作息节律判定当前起居日，亦兼容显式传入 YYYY-MM-DD） */
  targetDateStr?: string;
  /** 可选直接指定前台睡前自省冷叙事文本（不传则由 frontstage 模型汇总当日热记事生成） */
  overrideReflectionText?: string;
  /** 可选直接注入记忆官编译计划（不传则由 compiler 模型根据今日日志生成） */
  compilationPlanOverride?: CompilationPlan;
  /** 是否允许显式取代受保护的钉子记忆（默认 false） */
  allowSupersedeProtected?: boolean;
  /** 本轮衰减跨越天数（默认 1 天） */
  elapsedDecayDays?: number;
  /** 是否在 L1~L7 体检通过后对独立记忆仓执行 git commit（默认 true） */
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

function snapshotMemoryDirFiles(
  baseDir: string,
  subDir = "",
  acc = new Map<string, string>(),
): Map<string, string> {
  const target = path.join(baseDir, subDir);
  if (!fs.existsSync(target)) return acc;
  const entries = fs.readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const rel = path.posix.join(subDir, entry.name);
    if (entry.isDirectory()) {
      snapshotMemoryDirFiles(baseDir, rel, acc);
    } else if (entry.isFile()) {
      acc.set(rel, fs.readFileSync(path.join(baseDir, rel), "utf8"));
    }
  }
  return acc;
}

function restoreMemoryDirSnapshot(
  baseDir: string,
  snapshot: Map<string, string>,
): void {
  const currentFiles = snapshotMemoryDirFiles(baseDir);
  for (const rel of currentFiles.keys()) {
    if (!snapshot.has(rel)) {
      fs.rmSync(path.join(baseDir, rel), { force: true });
    }
  }
  for (const [rel, content] of snapshot.entries()) {
    const abs = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

/**
 * Echore 主循环总控（M1 串通【环 1：实时交互环 Reactive Loop】）
 */
export class EchoreEngine {
  readonly clock: Clock;
  readonly db: EchoreDatabase;
  readonly memoryDir: string;
  readonly promptsDir: string;
  profile: ResolvedEndocrineProfile;
  readonly router: OrganModelRouter;
  private readonly frontstageTools: ZodTool[];
  private readonly appendOnlyHistory: ChatMessage[] = [];
  private recentSessionRecalledIds: string[] = [];
  private recentSubstantiveRecallBatches: RecallBatchSnapshot[] = [];
  private lastUserTurnAtMs: number | null = null;
  private readonly stanceBinaryVerifier?: StanceBinaryVerifier;
  private readonly stanceVerifyTimeoutMs?: number;

  constructor(options: EchoreEngineOptions) {
    this.clock = options.clock;
    this.db = options.db;
    this.memoryDir = options.memoryDir;
    this.promptsDir = options.promptsDir ?? PROMPTS_DIR;
    this.profile = resolvePersonaProfile(options.persona);
    this.router = options.router;
    this.stanceBinaryVerifier = options.stanceBinaryVerifier;
    this.stanceVerifyTimeoutMs = options.stanceVerifyTimeoutMs;

    const silentWorkerTool = createSilentWorkerTool(
      this.router,
      options.workerTools ?? [],
      this.promptsDir,
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

  /**
   * 动态更新住户人设/内分泌原型（供性格测试台与领养流程实时切换）
   */
  updatePersona(
    persona: PersonaConfig,
    options?: { resetHormonesToBaseline?: boolean },
  ): ResolvedEndocrineProfile {
    this.profile = resolvePersonaProfile(persona);
    if (options?.resetHormonesToBaseline) {
      const resetHormones = createInitialHormoneState(
        this.profile,
        this.clock.now(),
      );
      this.db.saveHormoneState(resetHormones);
    }
    return this.profile;
  }

  /**
   * 判断指定日期的日记是否已完成 `## 睡前自省` 封底
   */
  isDateSleepClosed(dateStr: string): boolean {
    return extractColdReflectionForDate(this.memoryDir, dateStr) !== null;
  }

  /**
   * 按当前住户作息节律与昨日日记封底状态计算当前时刻所属的起居日 YYYY-MM-DD：
   * - 若处于跨午夜唤醒前窗口但昨日日记已写 `## 睡前自省` 封底（或早鸟作息午夜前已睡），直接开启今日新日记；
   * - 若昨日尚未封底，熬夜互动继续归入昨日日记，待入睡时统一封底。
   */
  getCircadianDateStr(date: Date = this.clock.now()): string {
    const schedule = CHRONOTYPE_SCHEDULES[this.profile.chronotype];
    const hour = getDecimalHour(date);
    if (hour < schedule.sleepLockEndHour) {
      const yesterday = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate() - 1,
      );
      const yesterdayStr = formatLocalDateStr(yesterday);
      if (this.isDateSleepClosed(yesterdayStr)) {
        return formatLocalDateStr(date);
      }
      if (schedule.sleepLockStartHour >= 12) {
        const yesterdayHot = extractHotEntriesForDate(
          this.memoryDir,
          yesterdayStr,
        );
        return getCircadianDateStr(date, this.profile.chronotype, {
          yesterdayClosed: yesterdayHot.length === 0,
        });
      }
      return getCircadianDateStr(date, this.profile.chronotype, {
        yesterdayClosed: false,
      });
    }
    return formatLocalDateStr(date);
  }

  /**
   * 判定当前入睡时刻应封底结算的目标起居日。若当夜已完成封底（哪怕用户清晨 07:00 提早醒来发了消息），返回 null 防止同夜/清晨重复触发
   */
  resolveTargetDateForSleepCycle(
    now: Date = this.clock.now(),
    explicitTargetDate?: string,
  ): string | null {
    if (explicitTargetDate) {
      return explicitTargetDate;
    }

    const currentDateStr = formatLocalDateStr(now);
    const hour = getDecimalHour(now);
    const schedule = CHRONOTYPE_SCHEDULES[this.profile.chronotype];

    // 若处于午夜后至清晨唤醒前窗口（hour < sleepLockEndHour，如 regular 01:00~08:00、night_owl 02:30~09:30、early_bird 00:00~06:30）
    if (hour < schedule.sleepLockEndHour) {
      const yesterday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 1,
      );
      const yesterdayStr = formatLocalDateStr(yesterday);

      // 若昨日已完成睡前自省封底，说明当夜睡眠环已执行完毕，清晨唤醒前绝不二次触发睡眠环
      if (this.isDateSleepClosed(yesterdayStr)) {
        return null;
      }

      const yesterdayHot = extractHotEntriesForDate(
        this.memoryDir,
        yesterdayStr,
      );
      const unsettledEvents = this.db.getUnsettledEventLogs(
        yesterdayStr,
        this.profile.chronotype,
      );
      const hasYesterdayUnsettledEvents = unsettledEvents.some(
        (e) => formatLocalDateStr(e.timestamp) <= yesterdayStr,
      );
      const todayHot = extractHotEntriesForDate(
        this.memoryDir,
        currentDateStr,
      );

      // 早鸟作息默认午夜前 (23:30) 入睡：仅当昨日确实遗留了未封底热记事或未结转事件时才在午夜后补封底
      if (schedule.sleepLockStartHour >= 12) {
        if (yesterdayHot.length > 0 || hasYesterdayUnsettledEvents) {
          return yesterdayStr;
        }
        return null;
      }

      // 跨午夜作息 (regular / night_owl)：昨日有热记事或未结转事件，或今日尚无白天热记事 -> 封底昨日起居日
      if (
        yesterdayHot.length > 0 ||
        hasYesterdayUnsettledEvents ||
        todayHot.length === 0
      ) {
        if (this.isDateSleepClosed(currentDateStr)) {
          return null;
        }
        return yesterdayStr;
      }

      // 兼容单测直接将同日时钟拨至凌晨 02:00（无昨日记录、仅有今日热记事且今日未封底）
      if (!this.isDateSleepClosed(currentDateStr) && todayHot.length > 0) {
        return currentDateStr;
      }

      return null;
    }

    // 午夜前（如 early_bird 在 23:30，或用户在 23:00 显式手动触发入睡）
    if (!this.isDateSleepClosed(currentDateStr)) {
      return currentDateStr;
    }

    return null;
  }

  getHistory(): readonly ChatMessage[] {
    return this.appendOnlyHistory;
  }

  appendExternalTurnToHistory(
    userMessage: string,
    assistantReply: string,
  ): void {
    this.appendOnlyHistory.push({
      role: "user",
      content: userMessage,
    });
    this.appendOnlyHistory.push({
      role: "assistant",
      content: assistantReply,
    });
  }

  loadRapportMarkdown(): string {
    const rapportPath = path.join(this.memoryDir, "implicit", "rapport.md");
    if (!fs.existsSync(rapportPath)) return "";
    return fs.readFileSync(rapportPath, "utf8");
  }

  async evaluatePulseWithOrgan(params: {
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
    const system = readPrompt("endocrine-pulse.md", this.promptsDir).text;

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

    const prevReflex = this.db.getReflexState();

    // Step 1: 落盘 SQLite Event Log & 更新反射层
    const userEvent = this.db.appendEventLog({
      role: "user",
      speaker: "user",
      content: userMessage,
      timestamp: nowIso,
    });

    const nextReflex = recordUserMessageReceived(prevReflex, nowIso);
    this.db.saveReflexState(nextReflex);

    const activeConcernsBefore = this.db.listActiveConcerns();
    const rapportMarkdown = this.loadRapportMarkdown();

    // 自动合成感知切片（若调用方未显式覆写 perceptionSlice）
    let resolvedPerceptionSlice = options.perceptionSlice;
    if (resolvedPerceptionSlice === undefined) {
      const chronoSlice = evaluateChronoAmbient({
        now,
        lastUserMessageAt: prevReflex.last_user_message_at,
        weather: options.weather,
        isHolidayOrAnniversary: options.isHolidayOrAnniversary,
        userActiveLateNight: options.userActiveLateNight,
      });
      const desktopSlice = evaluateDesktopPresence(
        options.desktopSamples ?? [],
      );
      const parts = [chronoSlice.sliceText, desktopSlice.sliceText].filter(
        Boolean,
      ) as string[];
      if (parts.length > 0) {
        resolvedPerceptionSlice = parts.join("；");
      }
    }

    // 自动回捞独居 S3 暗中准备物证（has_prep: true）
    const consumedPrepConcernIds: string[] = [];
    let resolvedSecretPrepNote = options.secretPrepNote;
    if (resolvedSecretPrepNote === undefined) {
      const prepNotes: string[] = [];
      for (const concern of activeConcernsBefore) {
        if (concern.status === "有效" && concern.has_prep) {
          const note = extractSecretPrepForConcern(this.memoryDir, concern.id);
          if (note) {
            prepNotes.push(`（针对「${concern.summary}」）：${note}`);
          } else {
            prepNotes.push(`我之前趁空闲已经帮他查好了关于「${concern.summary}」的备忘。`);
          }
          consumedPrepConcernIds.push(concern.id);
        }
      }
      if (prepNotes.length > 0) {
        resolvedSecretPrepNote = prepNotes.join("\n");
      }
    }

    // Step 2: [记忆官] 三桶五路召回 + 会话去重 + 三层级联 + 原话引文预水合
    if (
      this.lastUserTurnAtMs !== null &&
      now.getTime() - this.lastUserTurnAtMs > 2 * 3600 * 1000
    ) {
      // 超过 2 小时视为新一段会话，清空本会话已注入去重滑窗与共现转移滑窗
      this.recentSessionRecalledIds = [];
      this.recentSubstantiveRecallBatches = [];
    }
    this.lastUserTurnAtMs = now.getTime();

    let stanceCueOverride: boolean | undefined;
    if (!isIdleQuery(userMessage) && isStanceCue(userMessage)) {
      let lastAssistantReply = "";
      for (let i = this.appendOnlyHistory.length - 1; i >= 0; i--) {
        if (this.appendOnlyHistory[i]?.role === "assistant") {
          lastAssistantReply = this.appendOnlyHistory[i]!.content;
          break;
        }
      }
      stanceCueOverride = await verifyStanceCueWithOrgan({
        userMessage,
        lastAssistantReply,
        router: this.router,
        verifier: options.stanceBinaryVerifier ?? this.stanceBinaryVerifier,
        timeoutMs: options.stanceVerifyTimeoutMs ?? this.stanceVerifyTimeoutMs,
        promptsDir: this.promptsDir,
      });
    }

    const recalled = recallMemories({
      memoryDir: this.memoryDir,
      db: this.db,
      query: userMessage,
      now,
      activeConcerns: activeConcernsBefore,
      recentSessionRecalledIds: new Set(this.recentSessionRecalledIds),
      excludeEventIds: new Set([userEvent.id]),
      stanceCueOverride,
    });

    if (!recalled.isIdleQuery) {
      for (const item of recalled.items) {
        if (item.bucket !== "bucket_a_mainline") {
          this.recentSessionRecalledIds.push(item.id);
        }
      }
      if (this.recentSessionRecalledIds.length > 15) {
        this.recentSessionRecalledIds =
          this.recentSessionRecalledIds.slice(-15);
      }
    }

    this.recentSubstantiveRecallBatches = recordMemoryTransitions({
      db: this.db,
      recalledItems: recalled.items,
      isIdleQuery: recalled.isIdleQuery,
      recentBatches: this.recentSubstantiveRecallBatches,
      now,
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
    const isCalibratedConflict =
      rawPulse.is_conflict &&
      !endocrineOutcome.appliedGates.gate1RapportMatchedBanter &&
      !endocrineOutcome.appliedGates.gate2AmbiguityHold &&
      !endocrineOutcome.appliedGates.gate3OrphanSpikeBlocked;
    const isNegativeOrConflictTurn =
      isCalibratedConflict ||
      endocrineOutcome.hormoneState.cortisol > steppedHormones.cortisol;
    reconsolidateRecalledMemories({
      db: this.db,
      memoryDir: this.memoryDir,
      recalledItems: recalled.items,
      isNegativeOrConflictTurn,
      isIdleQuery: recalled.isIdleQuery,
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
      perceptionSlice: resolvedPerceptionSlice,
      secretPrepNote: resolvedSecretPrepNote,
      latestUserMessage: userMessage,
      promptsDir: this.promptsDir,
    });

    // 核销本轮已递入前台的 S3 暗中准备标记，防后续重复触发
    for (const concernId of consumedPrepConcernIds) {
      this.db.markConcernHasPrep(concernId, false, nowIso);
    }

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
    const circadianDateStr = this.getCircadianDateStr(now);
    const journalEntry = appendHotJournalEntry({
      memoryDir: this.memoryDir,
      dateStr: circadianDateStr,
      timeStr: formatLocalTimeHm(now),
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
      consumedPrepConcernIds,
    };
  }

  /**
   * 【环 2：自主心跳环 Autonomic Heartbeat Loop】（每 15 分钟一跳 · §6.4）
   * 1. [纯程序刷新] 推进 4 激素向 F_h/B_h 指数回归 + 更新褪黑素节律 + 采集天气/桌面状态段
   * 2. [反射层闸门] 若褪黑素刚入睡且今日未冷写 ──► 触发【环 3：昼夜新陈代谢环】
   * 3. [意愿分流器 Arbitrator]：
   *    ├─► 分支 A【主动破冰 Proactive】（反射层放行 + 非冷战封顶 + 满足天气/久坐/暗中准备/想念区之一）
   *    ├─► 分支 B【独居行动 Solitary】（非睡眠锁 + 多巴胺跌入无聊区 [F_da, B_da)）
   *    └─► 分支 C【静默呼吸 Idle】（零 LLM 消耗直接结束本跳）
   */
  async onHeartbeat(options: HeartbeatOptions = {}): Promise<HeartbeatOutput> {
    const now = this.clock.now();
    const nowIso = this.clock.nowIso();
    const dateStr = this.getCircadianDateStr(now);

    const activeConcerns = this.db.listActiveConcerns();
    const reflexState = this.db.getReflexState();

    // Step 1: 纯程序刷新 4 激素状态与四通道边际感知
    const steppedHormones = stepHormones({
      state: this.db.getHormoneState(),
      profile: this.profile,
      now,
      activeConcerns,
    });
    this.db.saveHormoneState(steppedHormones);

    const chronoAmbient = evaluateChronoAmbient({
      now,
      lastUserMessageAt: reflexState.last_user_message_at,
      weather: options.weather,
      isHolidayOrAnniversary: options.isHolidayOrAnniversary,
      userActiveLateNight: options.userActiveLateNight,
    });

    const desktopPresence = evaluateDesktopPresence(
      options.desktopSamples ?? [],
    );

    const reflexEvaluation = evaluateReflexGuard({
      reflexState,
      melatonin: steppedHormones.melatonin,
      now,
      chronotype: this.profile.chronotype,
    });

    // Step 2: [反射层入夜闸门] 若处于睡眠锁且今日尚未执行睡前冷叙事 -> 自动触发环 3
    const targetSleepDate = this.resolveTargetDateForSleepCycle(
      now,
      options.sleepCycleOptions?.targetDateStr,
    );
    if (
      reflexEvaluation.sleepLocked &&
      targetSleepDate !== null
    ) {
      const sleepCycleOutput = await this.runSleepCycle({
        ...options.sleepCycleOptions,
        targetDateStr: targetSleepDate,
      });
      return {
        branch: "sleep_cycle",
        hormoneState: this.db.getHormoneState(),
        reflexState: this.db.getReflexState(),
        reflexEvaluation,
        chronoAmbient,
        desktopPresence,
        sleepCycleOutput,
      };
    }

    // Step 3: [意愿分流器 Arbitrator]
    const hasConflictOrColdWar =
      isDefensiveOrTense(steppedHormones, this.profile) ||
      activeConcerns.some(
        (c) =>
          c.tier === "conflict" &&
          (c.status === "有效" || c.status === "僵持待解"),
      );

    const prepConcern = activeConcerns.find(
      (c) => c.status === "有效" && c.has_prep,
    );
    const hasWeatherOrFocusShock =
      chronoAmbient.isWeatherShock ||
      desktopPresence.continuousFocusHours >= 3 ||
      (chronoAmbient.isSpecialTimeWindow &&
        Boolean(options.userActiveLateNight));
    const inMissingZone = isInMissingZone(steppedHormones, this.profile);

    let proactiveTrigger: ProactiveTriggerReason | undefined;
    if (hasWeatherOrFocusShock) {
      proactiveTrigger = "weather_or_long_focus";
    } else if (prepConcern) {
      proactiveTrigger = "secret_prep_ready";
    } else if (inMissingZone) {
      proactiveTrigger = "missing_user";
    }

    // 分支 A：主动破冰 Proactive
    if (
      reflexEvaluation.canProactiveWake &&
      !hasConflictOrColdWar &&
      proactiveTrigger
    ) {
      const handover = buildSubconsciousHandover({
        hormoneState: steppedHormones,
        profile: this.profile,
        activeConcerns,
        db: this.db,
        now,
      });

      const secretPrepNote = prepConcern
        ? extractSecretPrepForConcern(this.memoryDir, prepConcern.id) ??
          `我之前趁空闲已经帮他查好了关于「${prepConcern.summary}」的备忘。`
        : undefined;

      const perceptionParts = [
        chronoAmbient.sliceText,
        desktopPresence.sliceText,
      ].filter(Boolean) as string[];

      let proactiveMessage = options.overrideProactiveText?.trim() ?? "";
      if (!proactiveMessage) {
        const route = this.router.getRoute("frontstage");
        const rapportBody = sanitizeRapportForFrontstage(
          this.loadRapportMarkdown(),
        );
        const proactivePromptText = readPrompt(
          "proactive-wake.md",
          this.promptsDir,
        ).text;
        const system = [
          `# 住户身份：${this.profile.name}`,
          this.profile.core_persona,
          rapportBody ? `\n# 两人内隐默契\n${rapportBody}` : "",
          "",
          `主动搭话习性：${this.profile.mood_action_slots.when_missing_user}`,
          proactivePromptText,
        ]
          .filter(Boolean)
          .join("\n");

        const promptSections = [
          `[潜意识心境]\n${renderHandoverYaml(handover)}`,
        ];
        if (perceptionParts.length > 0) {
          promptSections.push(`[当下环境与伴生观察]\n${perceptionParts.join("；")}`);
        }
        if (secretPrepNote) {
          promptSections.push(`[我刚帮他准备好的备忘]\n${secretPrepNote}`);
        }

        const resp = await route.provider.generate({
          model: route.model,
          maxTokens: 240,
          system,
          messages: [
            {
              role: "user",
              content: promptSections.join("\n\n"),
            },
          ],
        });
        proactiveMessage =
          resp.text.trim() ||
          (perceptionParts[0]
            ? `刚注意到${perceptionParts[0]}，顺手跟你说一声。`
            : "突然想起你那边这会儿应该忙得差不多了，出来透口气？");
      }

      assertNoInternalLeaks(proactiveMessage, "onHeartbeat.proactive");

      this.appendOnlyHistory.push({
        role: "assistant",
        content: proactiveMessage,
      });

      const proactiveEvent = this.db.appendEventLog({
        role: "assistant",
        speaker: this.profile.name,
        content: proactiveMessage,
        timestamp: nowIso,
        metadata: {
          proactive: true,
          trigger: proactiveTrigger,
        },
      });

      appendHotJournalEntry({
        memoryDir: this.memoryDir,
        dateStr,
        timeStr: formatLocalTimeHm(now),
        tag: "交互",
        firstPersonText: `我主动找他说：“${proactiveMessage.slice(0, 60)}”`,
      });

      // 注意：此处不提前抹除 prepConcern.has_prep（24h 主动冷却窗已由 recordProactiveSent 锁住），
      // 保留 has_prep = true 直到用户在环 1 (onUserMessage) 或 MCP (digestTurn) 回复时挂载完整备忘并核销。
      const updatedReflex = recordProactiveSent(reflexState, nowIso);
      this.db.saveReflexState(updatedReflex);

      return {
        branch: "proactive",
        hormoneState: steppedHormones,
        reflexState: updatedReflex,
        reflexEvaluation,
        chronoAmbient,
        desktopPresence,
        proactiveTrigger,
        proactiveMessage,
        proactiveEventId: proactiveEvent.id,
      };
    }

    // 分支 B：独居行动 Solitary（不发消息，不在睡眠锁定期，且多巴胺跌入无聊区 [F_da, B_da)）
    if (
      !reflexEvaluation.sleepLocked &&
      isInBoredZone(steppedHormones, this.profile)
    ) {
      const solitaryResult = await runSolitaryTick({
        clock: this.clock,
        db: this.db,
        memoryDir: this.memoryDir,
        profile: this.profile,
        router: this.router,
        actionKind: options.solitaryActionKind,
        feedFetcher: options.feedFetcher,
        tools: this.frontstageTools,
        overrideNoteText: options.overrideSolitaryNoteText,
        promptsDir: this.promptsDir,
      });

      return {
        branch: "solitary",
        hormoneState: solitaryResult.hormoneStateAfter,
        reflexState,
        reflexEvaluation,
        chronoAmbient,
        desktopPresence,
        solitaryResult,
      };
    }

    // 分支 C：静默呼吸 Idle（零 LLM 消耗直接结束本跳）
    return {
      branch: "idle",
      hormoneState: steppedHormones,
      reflexState,
      reflexEvaluation,
      chronoAmbient,
      desktopPresence,
    };
  }

  /**
   * 【环 3：昼夜新陈代谢环 Circadian Sleep Loop】（§1.2 & §6.4）
   * Step 1 [前台] 汇总当日交互与独居热记事，撰写第一人称睡前自省冷叙事（保住自传产权）
   * Step 2 [情绪官] 肝脏结算：出具《情绪结转裁决单》(T1 满 7 天淡化 / T2 满 5 天转冷战封顶 / T3 满 21 天留疤 / 日内和解落定)
   * Step 3 [记忆官] 唯一编译器：更新 people/ events/ concerns/ rapport.md，维护 supersedes 取代链并保留前台原叙
   * Step 4 [系统] 分品类定步长衰减 + status:已沉底 归档 + 跑通 L1~L7 体检 + 自动 git commit
   * 护栏：进入写操作前记录磁盘快照与 SQLite 检查点，若任何步骤失败或 L1~L7 未通过则 100% 原子回滚。
   */
  async runSleepCycle(
    options: SleepCycleOptions = {},
  ): Promise<SleepCycleOutput> {
    const now = this.clock.now();
    const dateStr =
      options.targetDateStr ??
      this.resolveTargetDateForSleepCycle(now) ??
      this.clock.todayStr();

    // 睡前原子快照（磁盘文件 + SQLite 状态表）
    const diskSnapshot = snapshotMemoryDirFiles(this.memoryDir);
    const hormoneBackup = this.db.sqlite
      .query("SELECT * FROM hormone_state")
      .all() as Array<Record<string, unknown>>;
    const reflexBackup = this.db.sqlite
      .query("SELECT * FROM reflex_state")
      .all() as Array<Record<string, unknown>>;
    const concernsBackup = this.db.sqlite
      .query("SELECT * FROM concerns")
      .all() as Array<Record<string, unknown>>;
    const metaBackup = this.db.sqlite
      .query("SELECT * FROM memory_meta")
      .all() as Array<Record<string, unknown>>;
    const snapshotsBackup = this.db.sqlite
      .query("SELECT * FROM memory_snapshots")
      .all() as Array<Record<string, unknown>>;
    try {
      const stepped = stepHormones({
        state: this.db.getHormoneState(),
        profile: this.profile,
        now,
        activeConcerns: this.db.listActiveConcerns(),
      });
      const currentHormones: HormoneState = {
        ...stepped,
        melatonin: Math.max(stepped.melatonin, 0.78),
      };
      this.db.saveHormoneState(currentHormones);

      const currentHandover = buildSubconsciousHandover({
        hormoneState: currentHormones,
        profile: this.profile,
        activeConcerns: this.db.listActiveConcerns(),
        db: this.db,
        now,
      });

      // Step 1: [前台] 撰写第一人称睡前自省冷叙事（按单调游标获取上次睡眠结转以来的增量事件，附带 30min 时间窗双向原话反馈链）
      const todaysEvents = this.db.getUnsettledEventLogs(
        dateStr,
        this.profile.chronotype,
      );
      const coldReflection = await synthesizeBedtimeReflection({
        router: this.router,
        profile: this.profile,
        memoryDir: this.memoryDir,
        dateStr,
        now,
        handover: currentHandover,
        todaysEvents,
        overrideReflectionText: options.overrideReflectionText,
        promptsDir: this.promptsDir,
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
        allowSupersedeProtected: options.allowSupersedeProtected,
        chronotype: this.profile.chronotype,
        todaysEvents,
        promptsDir: this.promptsDir,
      });
      // Step 4: [系统] 分品类定步长衰减 + status:已沉底 归档 + L1~L8 终检 + git commit
      const decayReport = runDailyMemoryDecayAndArchive({
        memoryDir: this.memoryDir,
        db: this.db,
        now,
        elapsedDays: options.elapsedDecayDays ?? 1,
        sleepDate: dateStr,
      });

      if (decayReport.archivedIds.length > 0) {
        reconcileSynchronicLinksToInactiveFiles({
          memoryDir: this.memoryDir,
          db: this.db,
          sleepDate: dateStr,
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
          .filter((i) => i.severity === "error")
          .map((i) => `[${i.rule}] ${i.file}: ${i.message}`)
          .join("; ");
        throw new Error(
          `[MemoryCILinterFailed] 夜间冷写未通过 L1~L7 机检守卫，拒绝提交并回滚: ${details}`,
        );
      }
      const lastSettledEventId =
        todaysEvents.length > 0
          ? todaysEvents[todaysEvents.length - 1]!.id
          : null;
      this.db.advanceSleepCursor(this.clock.nowIso(), lastSettledEventId);
      this.db.pruneOldMemorySnapshots(7);

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
    } catch (err) {
      // 原子回滚磁盘 Markdown 仓与 SQLite 状态表
      restoreMemoryDirSnapshot(this.memoryDir, diskSnapshot);
      const rollbackTx = this.db.sqlite.transaction(() => {
        this.db.sqlite.exec("DELETE FROM hormone_state;");
        for (const r of hormoneBackup) {
          this.db.sqlite
            .query(
              `INSERT INTO hormone_state (id, cortisol, oxytocin, dopamine, melatonin, floor_cort, cap_ox, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              r.id as number,
              r.cortisol as number,
              r.oxytocin as number,
              r.dopamine as number,
              r.melatonin as number,
              r.floor_cort as number,
              r.cap_ox as number,
              r.updated_at as string,
            );
        }

        this.db.sqlite.exec("DELETE FROM reflex_state;");
        for (const rf of reflexBackup) {
          this.db.sqlite
            .query(
              `INSERT INTO reflex_state (id, consecutive_unanswered_proactive, last_proactive_at, last_user_message_at, proactive_lock, last_sleep_settled_at, last_sleep_event_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              rf.id as number,
              rf.consecutive_unanswered_proactive as number,
              (rf.last_proactive_at as string | null) ?? null,
              (rf.last_user_message_at as string | null) ?? null,
              rf.proactive_lock as number,
              (rf.last_sleep_settled_at as string | null) ?? null,
              (rf.last_sleep_event_id as string | null) ?? null,
            );
        }
        this.db.sqlite.exec("DELETE FROM concerns;");
        for (const c of concernsBackup) {
          this.db.sqlite
            .query(
              `INSERT INTO concerns (id, tier, status, summary, source_event_id, created_at, updated_at, floor_cort, cap_ox, has_prep, settled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              c.id as string,
              c.tier as string,
              c.status as string,
              c.summary as string,
              c.source_event_id as string,
              c.created_at as string,
              c.updated_at as string,
              c.floor_cort as number,
              c.cap_ox as number,
              c.has_prep as number,
              (c.settled_at as string | null) ?? null,
            );
        }

        this.db.sqlite.exec("DELETE FROM memory_meta;");
        for (const m of metaBackup) {
          this.db.sqlite
            .query(
              `INSERT INTO memory_meta (id, path, category, status, allow_forget, strength, access_count, last_accessed, embedding_json, embedding_fingerprint, audit_fingerprint, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              m.id as string,
              m.path as string,
              m.category as string,
              m.status as string,
              m.allow_forget as number,
              m.strength as number,
              m.access_count as number,
              m.last_accessed as string,
              (m.embedding_json as string | null) ?? null,
              (m.embedding_fingerprint as string | null) ?? null,
              (m.audit_fingerprint as string | null) ?? null,
              m.updated_at as string,
            );
        }

        this.db.sqlite.exec("DELETE FROM memory_snapshots;");
        for (const s of snapshotsBackup) {
          this.db.sqlite
            .query(
              `INSERT INTO memory_snapshots (id, sleep_date, memory_id, rel_path, original_content, is_creation, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              s.id as number,
              s.sleep_date as string,
              s.memory_id as string,
              s.rel_path as string,
              (s.original_content as string | null) ?? null,
              s.is_creation as number,
              s.created_at as string,
            );
        }
      });
      rollbackTx();
      throw err;
    }
  }

  /**
   * Wave 7.1 SQLite `SAVEPOINT` 零副作用同步假设推演探针：
   * - 硬契约 1：SAVEPOINT 内全程纯同步零 `await`（任何 embedding 必须先于调用前计算传入），事件循环绝不让出；
   * - 硬契约 2：禁调生成式 LLM、禁含“立刻入睡”编译场景、禁触碰磁盘 `.md` 文件；
   * - 硬契约 3：只读传入 `new Set(this.recentSessionRecalledIds)`，绝不修改引擎内存态。
   */
  probeWhatIf(scenario: WhatIfProbeScenario = {}): WhatIfProbeResult {
    const savepointName = "echore_what_if_probe";
    this.db.sqlite.exec(`SAVEPOINT ${savepointName};`);
    try {
      const offsetMs = (scenario.fastForwardMinutes ?? 0) * 60_000;
      const probeNow = new Date(this.clock.now().getTime() + offsetMs);
      const activeConcerns = this.db.listActiveConcerns();
      const steppedHormones = stepHormones({
        state: this.db.getHormoneState(),
        profile: this.profile,
        now: probeNow,
        activeConcerns,
      });
      this.db.saveHormoneState(steppedHormones);

      const handover = buildSubconsciousHandover({
        hormoneState: steppedHormones,
        profile: this.profile,
        activeConcerns,
        db: this.db,
        now: probeNow,
      });

      const recalled =
        scenario.userMessage !== undefined
          ? recallMemories({
              memoryDir: this.memoryDir,
              db: this.db,
              query: scenario.userMessage,
              now: probeNow,
              activeConcerns,
              queryEmbedding: scenario.queryEmbedding,
              stanceCueOverride: scenario.stanceCueOverride,
              recentSessionRecalledIds: new Set(this.recentSessionRecalledIds),
            })
          : undefined;

      return {
        probeNowIso: probeNow.toISOString(),
        hormoneState: steppedHormones,
        handover,
        ...(recalled ? { recalled } : {}),
      };
    } finally {
      this.db.sqlite.exec(`ROLLBACK TO ${savepointName};`);
      this.db.sqlite.exec(`RELEASE ${savepointName};`);
    }
  }

  /**
   * Wave 7.2 观测台单文件快照一键回滚：
   * 按 `(sleepDate, memoryId)` 读取 Copy-on-Write 最早基线，仅还原目标记忆文件与元数据，不波及同夜其他编译产物。
   */
  rollbackMemorySnapshot(
    sleepDate: string,
    memoryId: string,
  ): RollbackSnapshotResult {
    const snap = this.db.getMemorySnapshot(sleepDate, memoryId);
    if (!snap) {
      return { restored: false, action: "not_found" };
    }

    const absPath = path.join(this.memoryDir, snap.rel_path);
    if (snap.is_creation) {
      fs.rmSync(absPath, { force: true });
      this.db.deleteMemoryMeta(memoryId);
      this.db.deleteMemorySnapshot(sleepDate, memoryId);
      return {
        restored: true,
        action: "deleted_creation",
        relPath: snap.rel_path,
      };
    }

    if (snap.original_content !== null) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, snap.original_content, "utf8");
      syncSingleMemoryMetaFile({
        memoryDir: this.memoryDir,
        relPath: snap.rel_path,
        db: this.db,
        now: this.clock.now(),
      });
    }
    this.db.deleteMemorySnapshot(sleepDate, memoryId);
    return {
      restored: true,
      action: "restored_content",
      relPath: snap.rel_path,
    };
  }
}
