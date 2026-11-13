import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { formatLocalTimeHm } from "../core/clock.ts";
import {
  assertNoInternalLeaks,
  type PulseEvaluation,
  type SubconsciousHandover,
} from "../core/schemas.ts";
import { applyEndocrineCalibrationGates } from "../endocrine/evaluator.ts";
import {
  buildSubconsciousHandover,
  renderHandoverYaml,
} from "../endocrine/handover.ts";
import { stepHormones } from "../endocrine/hormones.ts";
import { appendHotJournalEntry } from "../frontstage/journal.ts";
import { sanitizeRapportForFrontstage } from "../frontstage/performer.ts";
import { extractSecretPrepForConcern } from "../frontstage/solitary.ts";
import { reconsolidateRecalledMemories } from "../hippocampus/decay.ts";
import {
  type RecallResult,
  recallMemories,
} from "../hippocampus/recall.ts";
import {
  defineZodTool,
  type ZodTool,
  zodObjectToJsonSchema,
} from "../llm/types.ts";
import { recordUserMessageReceived } from "../reflex/guard.ts";
import type { EchoreEngine } from "./engine.ts";

export interface WakeContextOutput {
  personaName: string;
  corePersona: string;
  rapportMarkdown: string;
  handover: SubconsciousHandover;
  handoverYaml: string;
  recentMemoriesBlock: string;
  secretPrepNotes: string[];
  formattedContext: string;
}

export interface DigestTurnInput {
  userMessage: string;
  assistantReply: string;
  pulseOverride?: Partial<PulseEvaluation>;
}

export interface DigestTurnOutput {
  handoverAfter: SubconsciousHandover;
  handoverYaml: string;
  fastReliefApplied: boolean;
  journalEntry: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * §6.5 出差模式（MCP Server 外壳 · Portable Soul）
 * 暴露 4 个严守第一人称主权的潜意识接口，绝不暴露底层激素浮点数或 log-* 主键。
 */
export class EchoreMcpServer {
  private readonly engine: EchoreEngine;
  readonly tools: ZodTool[];

  constructor(engine: EchoreEngine) {
    this.engine = engine;
    this.tools = this.createMcpTools();
  }

  /**
   * 1. `echore_wake_context`：拉取当前调准好的《潜意识心境交接单》+ `rapport.md` 常驻语感底座 + 近期主线记忆
   */
  wakeContext(params?: { topicHint?: string }): WakeContextOutput {
    const now = this.engine.clock.now();
    const activeConcerns = this.engine.db.listActiveConcerns();
    const steppedHormones = stepHormones({
      state: this.engine.db.getHormoneState(),
      profile: this.engine.profile,
      now,
      activeConcerns,
    });
    this.engine.db.saveHormoneState(steppedHormones);

    const handover = buildSubconsciousHandover({
      hormoneState: steppedHormones,
      profile: this.engine.profile,
      activeConcerns,
      db: this.engine.db,
      now,
    });
    const handoverYaml = renderHandoverYaml(handover);

    const rawRapport = this.readRawRapport();
    const rapportMarkdown = sanitizeRapportForFrontstage(rawRapport);

    const recallRes = recallMemories({
      memoryDir: this.engine.memoryDir,
      db: this.engine.db,
      query: params?.topicHint ?? "",
      now,
      activeConcerns,
      topK: 5,
    });

    const secretPrepNotes: string[] = [];
    for (const concern of activeConcerns) {
      if (concern.status === "有效" && concern.has_prep) {
        const note = extractSecretPrepForConcern(
          this.engine.memoryDir,
          concern.id,
        );
        if (note) {
          secretPrepNotes.push(`（针对「${concern.summary}」）：${note}`);
        }
      }
    }

    const sections = [
      `# 住户身份：${this.engine.profile.name}`,
      this.engine.profile.core_persona,
      rapportMarkdown ? `# 常驻内隐默契 (rapport)\n${rapportMarkdown}` : "",
      `# 潜意识心境交接单\n${handoverYaml}`,
      recallRes.formattedBlock
        ? `# 近期主线记忆与原话印象\n${recallRes.formattedBlock}`
        : "",
      secretPrepNotes.length > 0
        ? `# 我之前帮他暗中准备好的备忘\n${secretPrepNotes.join("\n")}`
        : "",
    ].filter(Boolean);

    const formattedContext = sections.join("\n\n");
    assertNoInternalLeaks(formattedContext, "mcp.echore_wake_context");

    return {
      personaName: this.engine.profile.name,
      corePersona: this.engine.profile.core_persona,
      rapportMarkdown,
      handover,
      handoverYaml,
      recentMemoriesBlock: recallRes.formattedBlock,
      secretPrepNotes,
      formattedContext,
    };
  }

  /**
   * 2. `echore_recall`：按外部当前话题触发三桶五路召回 + 原话引文预水合
   */
  recall(params: { query: string; limit?: number }): RecallResult {
    const now = this.engine.clock.now();
    const activeConcerns = this.engine.db.listActiveConcerns();
    const res = recallMemories({
      memoryDir: this.engine.memoryDir,
      db: this.engine.db,
      query: params.query,
      now,
      activeConcerns,
      topK: params.limit ?? 10,
    });
    assertNoInternalLeaks(res.formattedBlock, "mcp.echore_recall");
    return res;
  }

  /**
   * 3. `echore_digest_turn`：将外部刚聊完的一轮对话喂回本地 Echore，
   * 触发 SQLite Event Log 落盘 + 情绪官实时脉冲评估与日内快代谢
   */
  async digestTurn(input: DigestTurnInput): Promise<DigestTurnOutput> {
    const now = this.engine.clock.now();
    const nowIso = this.engine.clock.nowIso();

    const userEvent = this.engine.db.appendEventLog({
      role: "user",
      speaker: "user",
      content: input.userMessage,
      timestamp: nowIso,
      producer: "user",
      source: "mcp_digest",
      metadata: { source: "mcp_digest" },
    });

    this.engine.db.appendEventLog({
      role: "assistant",
      speaker: this.engine.profile.name,
      content: input.assistantReply,
      timestamp: nowIso,
      producer: "external",
      source: "mcp_digest",
      metadata: { source: "mcp_digest" },
    });

    const nextReflex = recordUserMessageReceived(
      this.engine.db.getReflexState(),
      nowIso,
    );
    this.engine.db.saveReflexState(nextReflex);

    const activeConcernsBefore = this.engine.db.listActiveConcerns();
    const rapportMarkdown = this.readRawRapport();

    const steppedHormones = stepHormones({
      state: this.engine.db.getHormoneState(),
      profile: this.engine.profile,
      now,
      activeConcerns: activeConcernsBefore,
    });

    const recalled = recallMemories({
      memoryDir: this.engine.memoryDir,
      db: this.engine.db,
      query: input.userMessage,
      now,
      activeConcerns: activeConcernsBefore,
      excludeEventIds: new Set([userEvent.id]),
    });

    const rawPulse = await this.engine.evaluatePulseWithOrgan({
      userMessage: input.userMessage,
      rapportMarkdown,
      recentHistory: this.engine.getHistory(),
      activeConcerns: activeConcernsBefore,
      override: input.pulseOverride,
    });

    const endocrineOutcome = applyEndocrineCalibrationGates(
      {
        userMessage: input.userMessage,
        sourceEventId: userEvent.id,
        rapportContent: rapportMarkdown,
        hormoneState: steppedHormones,
        profile: this.engine.profile,
        activeConcerns: activeConcernsBefore,
        now,
        rawPulse,
      },
      this.engine.db,
    );

    const isCalibratedConflict =
      rawPulse.is_conflict &&
      !endocrineOutcome.appliedGates.gate1RapportMatchedBanter &&
      !endocrineOutcome.appliedGates.gate2AmbiguityHold &&
      !endocrineOutcome.appliedGates.gate3OrphanSpikeBlocked;
    const isNegativeOrConflictTurn =
      isCalibratedConflict ||
      endocrineOutcome.hormoneState.cortisol > steppedHormones.cortisol;
    reconsolidateRecalledMemories({
      db: this.engine.db,
      memoryDir: this.engine.memoryDir,
      recalledItems: recalled.items,
      isNegativeOrConflictTurn,
      isIdleQuery: recalled.isIdleQuery,
      now,
    });

    this.engine.appendExternalTurnToHistory(
      input.userMessage,
      input.assistantReply,
    );

    // 核销出差期间可能已用掉的 has_prep
    for (const c of activeConcernsBefore) {
      if (c.status === "有效" && c.has_prep) {
        this.engine.db.markConcernHasPrep(c.id, false, nowIso);
      }
    }

    const journalEntry = appendHotJournalEntry({
      memoryDir: this.engine.memoryDir,
      dateStr: this.engine.getCircadianDateStr(now),
      timeStr: formatLocalTimeHm(now),
      tag: "交互",
      firstPersonText: `在外面陪他聊了“${input.userMessage.slice(0, 30)}”，我回他：“${input.assistantReply.slice(0, 60)}”`,
    });

    const handoverAfter = buildSubconsciousHandover({
      hormoneState: endocrineOutcome.hormoneState,
      profile: this.engine.profile,
      activeConcerns: endocrineOutcome.activeConcerns,
      db: this.engine.db,
      now,
      ambiguityProbeHint: endocrineOutcome.ambiguityProbeHint,
      fastReliefApplied: endocrineOutcome.fastReliefApplied,
    });
    const handoverYaml = renderHandoverYaml(handoverAfter);
    assertNoInternalLeaks(handoverYaml, "mcp.echore_digest_turn");

    return {
      handoverAfter,
      handoverYaml,
      fastReliefApplied: endocrineOutcome.fastReliefApplied,
      journalEntry,
    };
  }

  /**
   * 4. `echore_write_journal`：供出差中的“我”随手追加当日第一人称热记事
   */
  writeJournal(params: {
    firstPersonText: string;
    tag?: "交互" | "独居";
  }): { entryLine: string; dateStr: string } {
    const now = this.engine.clock.now();
    const dateStr = this.engine.getCircadianDateStr(now);

    const entryLine = appendHotJournalEntry({
      memoryDir: this.engine.memoryDir,
      dateStr,
      timeStr: formatLocalTimeHm(now),
      firstPersonText: params.firstPersonText,
      tag: params.tag ?? "交互",
    });
    assertNoInternalLeaks(entryLine, "mcp.echore_write_journal");
    return { entryLine, dateStr };
  }

  private readRawRapport(): string {
    const p = path.join(this.engine.memoryDir, "implicit", "rapport.md");
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8");
  }

  private createMcpTools(): ZodTool[] {
    return [
      defineZodTool({
        name: "echore_wake_context",
        description:
          "拉取当前调准好的《潜意识心境交接单》、rapport.md 常驻语感底座与近期主线记忆（零浮点数、零 log-* 主键）",
        inputSchema: z.object({
          topicHint: z
            .string()
            .optional()
            .describe("可选的当前话题提示词，用于精准预热近期相关记忆"),
        }),
        execute: async (input) => {
          const out = this.wakeContext(input);
          return out.formattedContext;
        },
      }),
      defineZodTool({
        name: "echore_recall",
        description:
          "按外部当前话题触发三桶五路召回与原话引文预水合（零 log-* 泄露）",
        inputSchema: z.object({
          query: z.string().min(1).describe("当前对话话题或检索词"),
          limit: z.number().optional().describe("最大召回条数（默认 10）"),
        }),
        execute: async (input) => {
          const res = this.recall(input);
          return (
            res.formattedBlock || "（未检索到相关历史记忆或原话印象）"
          );
        },
      }),
      defineZodTool({
        name: "echore_digest_turn",
        description:
          "将外部刚聊完的一轮对话喂回本地 Echore，触发 SQLite 落盘、情绪官实时脉冲评估与日内快代谢",
        inputSchema: z.object({
          userMessage: z.string().min(1).describe("用户刚才说的话"),
          assistantReply: z.string().min(1).describe("“我”刚才回复的话"),
        }),
        execute: async (input) => {
          const out = await this.digestTurn(input);
          return out.handoverYaml;
        },
      }),
      defineZodTool({
        name: "echore_write_journal",
        description: "供出差中的“我”随手追加当日第一人称热记事到 journal/",
        inputSchema: z.object({
          firstPersonText: z
            .string()
            .min(1)
            .describe("第一人称自然语言随手记正文"),
          tag: z
            .enum(["交互", "独居"])
            .optional()
            .describe("记事分类标签（默认 交互）"),
        }),
        execute: async (input) => {
          const out = this.writeJournal(input);
          return out.entryLine;
        },
      }),
    ];
  }

  /**
   * 标准 MCP JSON-RPC 2.0 协议分发器（支持 initialize / tools/list / tools/call / ping）
   */
  async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;

    try {
      if (request.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "echore-portable-soul",
              version: "0.1.0",
            },
          },
        };
      }

      if (request.method === "ping") {
        return {
          jsonrpc: "2.0",
          id,
          result: {},
        };
      }

      if (request.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: zodObjectToJsonSchema(t.inputSchema),
            })),
          },
        };
      }

      if (request.method === "tools/call") {
        const toolName = String(request.params?.name ?? "");
        const toolArgs = (request.params?.arguments ?? {}) as Record<
          string,
          unknown
        >;
        const tool = this.tools.find((t) => t.name === toolName);
        if (!tool) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Unknown MCP tool: ${toolName}`,
            },
          };
        }

        const parsed = tool.inputSchema.safeParse(toolArgs);
        if (!parsed.success) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Invalid tool arguments for ${toolName}: ${parsed.error.message}`,
            },
          };
        }

        const textOutput = await tool.execute(parsed.data);
        assertNoInternalLeaks(textOutput, `mcp.tools/call.${toolName}`);

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: textOutput,
              },
            ],
            isError: false,
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
