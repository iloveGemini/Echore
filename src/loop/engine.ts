import fs from "node:fs";
import path from "node:path";
import type { Clock } from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
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
import { buildSubconsciousHandover } from "../endocrine/handover.ts";
import {
  createInitialHormoneState,
  stepHormones,
} from "../endocrine/hormones.ts";
import { appendHotJournalEntry } from "../frontstage/journal.ts";
import { performFrontstageTurn } from "../frontstage/performer.ts";
import { createSilentWorkerTool } from "../frontstage/silent-worker.ts";
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

  private async evaluatePulseWithOrgan(
    userMessage: string,
    rapportMarkdown: string,
    override?: Partial<PulseEvaluation>,
  ): Promise<PulseEvaluation> {
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
      "请结合常驻默契滤网（rapport.md）评估用户最新话语的情绪脉冲，只输出合法的 JSON 对象。",
      "字段包括：event_summary (string), confidence (0~1), is_conflict (boolean), is_reconciliation (boolean), is_warm (boolean), is_novel (boolean), matched_rapport_joke (boolean), cortisol_delta (-1~1), oxytocin_delta (-1~1), dopamine_delta (-1~1)。",
    ].join("\n");

    const resp = await route.provider.generate({
      model: route.model,
      maxTokens: 512,
      system,
      messages: [
        {
          role: "user",
          content: `[默契滤网]\n${rapportMarkdown}\n\n[用户最新话语]\n${userMessage}`,
        },
      ],
    });

    try {
      const jsonMatch = resp.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return PulseEvaluationSchema.parse(parsed);
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

    const rawPulse = await this.evaluatePulseWithOrgan(
      userMessage,
      rapportMarkdown,
      options.pulseOverride,
    );

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
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
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
}
