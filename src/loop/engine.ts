import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Clock } from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
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
  evaluateReflexGuard,
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
    const dateStr = this.clock.todayStr();

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
    if (
      reflexEvaluation.sleepLocked &&
      extractColdReflectionForDate(this.memoryDir, dateStr) === null
    ) {
      const sleepCycleOutput = await this.runSleepCycle(
        options.sleepCycleOptions,
      );
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
        const system = [
          `# 住户身份：${this.profile.name}`,
          this.profile.core_persona,
          rapportBody ? `\n# 两人内隐默契\n${rapportBody}` : "",
          "",
          `主动搭话习性：${this.profile.mood_action_slots.when_missing_user}`,
          "请以第一人称“我”向对方发一条简短自然的主动搭话（1~2 句话），严禁暴露任何系统参数或数字。",
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

      const hh = String(now.getUTCHours()).padStart(2, "0");
      const mm = String(now.getUTCMinutes()).padStart(2, "0");
      appendHotJournalEntry({
        memoryDir: this.memoryDir,
        dateStr,
        timeStr: `${hh}:${mm}`,
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
   * Step 4 [系统] 分品类定步长衰减 + status:已沉底 归档 + 跑通 L1~L6 体检 + 自动 git commit
   */
  async runSleepCycle(
    options: SleepCycleOptions = {},
  ): Promise<SleepCycleOutput> {
    const now = this.clock.now();
    const dateStr = this.clock.todayStr();

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
