import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { AnthropicAdapter } from "../src/llm/anthropic.ts";
import { OpenAICompatAdapter } from "../src/llm/openai-compat.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import { runToolLoop } from "../src/llm/tool-runner.ts";
import {
  defineZodTool,
  type LLMGenerateParams,
  type LLMProvider,
  type LLMResponse,
  type SandwichRequest,
} from "../src/llm/types.ts";
import { EchoreEngine } from "../src/loop/engine.ts";

describe("LLM Layer: Sandwich Prompt Caching & Dual Adapter Prefix Stability", () => {
  test("AnthropicAdapter places cache_control breakpoints on System Part B and History end, keeping dynamic tail at the end", async () => {
    let capturedPayload: Record<string, unknown> | undefined;

    const mockAnthropicClient = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          capturedPayload = params;
          return {
            id: "msg_01",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            stop_reason: "end_turn",
            stop_sequence: null,
            content: [{ type: "text", text: "那你早点休息，明天聊。" }],
            usage: {
              input_tokens: 1200,
              output_tokens: 20,
              cache_read_input_tokens: 1024,
              cache_creation_input_tokens: 0,
            },
          };
        },
      },
    };

    const adapter = new AnthropicAdapter({
      client: mockAnthropicClient as unknown as ConstructorParameters<
        typeof AnthropicAdapter
      >[0] extends { client?: infer C }
        ? C
        : never,
    });

    const res = await adapter.generateSandwich({
      model: "claude-opus-5-5",
      staticPrefix: {
        systemPartA: "核心人设静态区",
        systemPartB: "常驻默契底座 rapport.md",
      },
      appendOnlyHistory: [
        { role: "user", content: "第一轮历史消息" },
        { role: "assistant", content: "第一轮历史回复" },
      ],
      dynamicTail: {
        subconsciousBlock: "当下心境基调: 平稳自然",
        latestUserMessage: "今天有点累了",
      },
    });

    expect(res.text).toBe("那你早点休息，明天聊。");
    expect(res.usage?.cacheReadInputTokens).toBe(1024);

    const systemBlocks = capturedPayload?.system as Array<{
      text: string;
      cache_control?: { type: string };
    }>;
    expect(systemBlocks.length).toBe(2);
    expect(systemBlocks[0]?.cache_control).toBeUndefined();
    expect(systemBlocks[1]?.cache_control).toEqual({ type: "ephemeral" }); // Breakpoint 1

    const messages = capturedPayload?.messages as Array<{
      role: string;
      content: Array<{ text: string; cache_control?: { type: string } }>;
    }>;
    expect(messages.length).toBe(3);
    // Breakpoint 2 on last message of appendOnlyHistory (index 1)
    expect(messages[1]?.content[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
    // Dynamic tail is at the very end (index 2) without mutating earlier messages
    expect(messages[2]?.content[0]?.text).toContain("<subconscious_context>");
    expect(messages[2]?.content[1]?.text).toBe("今天有点累了");
  });

  test("runToolLoop preserves Anthropic cache_control breakpoints on Step 2+ after tool execution", async () => {
    const capturedCalls: Array<Record<string, unknown>> = [];
    let callIdx = 0;

    const mockAnthropicClient = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          capturedCalls.push(params);
          callIdx += 1;
          if (callIdx === 1) {
            return {
              id: "msg_step1",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              stop_reason: "tool_use",
              stop_sequence: null,
              content: [
                {
                  type: "tool_use",
                  id: "tool_1",
                  name: "echo_tool",
                  input: { q: "ping" },
                },
              ],
              usage: { input_tokens: 500, output_tokens: 30 },
            };
          }
          return {
            id: "msg_step2",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            stop_reason: "end_turn",
            stop_sequence: null,
            content: [{ type: "text", text: "查到了：pong" }],
            usage: {
              input_tokens: 550,
              output_tokens: 15,
              cache_read_input_tokens: 480,
            },
          };
        },
      },
    };

    const adapter = new AnthropicAdapter({
      client: mockAnthropicClient as unknown as ConstructorParameters<
        typeof AnthropicAdapter
      >[0] extends { client?: infer C }
        ? C
        : never,
    });

    const echoTool = defineZodTool({
      name: "echo_tool",
      description: "Echo test tool",
      inputSchema: z.object({ q: z.string() }),
      execute: ({ q }) => `pong:${q}`,
    });

    const res = await runToolLoop({
      provider: adapter,
      tools: [echoTool],
      initialRequest: {
        mode: "sandwich",
        request: {
          model: "claude-opus-5-5",
          staticPrefix: {
            systemPartA: "静态人设 A",
            systemPartB: "静态默契 B",
          },
          appendOnlyHistory: [
            { role: "user", content: "旧消息" },
            { role: "assistant", content: "旧回复" },
          ],
          dynamicTail: {
            subconsciousBlock: "心境交接",
            latestUserMessage: "帮我测一下",
          },
        },
      },
    });

    expect(res.steps).toBe(2);
    expect(capturedCalls.length).toBe(2);

    // Step 2 still has 2-block system with cache_control on systemBlocks[1] and on appendOnlyHistory[1]
    const step2System = capturedCalls[1]?.system as Array<{
      text: string;
      cache_control?: { type: string };
    }>;
    expect(Array.isArray(step2System)).toBe(true);
    expect(step2System[1]?.cache_control).toEqual({ type: "ephemeral" });

    const step2Messages = capturedCalls[1]?.messages as Array<{
      role: string;
      content: Array<{ text?: string; cache_control?: { type: string } }>;
    }>;
    expect(step2Messages[1]?.content[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("OpenAICompatAdapter keeps static prefix 100% byte-identical across turns", async () => {
    const capturedBodies: Array<{
      messages: Array<{ role: string; content: string }>;
    }> = [];

    const adapter = new OpenAICompatAdapter({
      apiKey: "test-key",
      baseURL: "https://api.deepseek.com/v1",
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "好的，我记下了。" },
              },
            ],
            usage: {
              prompt_tokens: 1500,
              completion_tokens: 12,
              prompt_cache_hit_tokens: 1280,
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    await adapter.generateSandwich({
      model: "deepseek-chat",
      staticPrefix: {
        systemPartA: "固定人设 PartA",
        systemPartB: "固定默契 PartB",
      },
      appendOnlyHistory: [{ role: "user", content: "早安" }],
      dynamicTail: {
        subconsciousBlock: "第一轮动态心境 A",
        latestUserMessage: "中午吃什么？",
      },
    });

    await adapter.generateSandwich({
      model: "deepseek-chat",
      staticPrefix: {
        systemPartA: "固定人设 PartA",
        systemPartB: "固定默契 PartB",
      },
      appendOnlyHistory: [
        { role: "user", content: "早安" },
        { role: "user", content: "中午吃什么？" },
        { role: "assistant", content: "好的，我记下了。" },
      ],
      dynamicTail: {
        subconsciousBlock: "第二轮完全不同的动态心境 B",
        latestUserMessage: "晚上去看电影吧",
      },
    });

    expect(capturedBodies.length).toBe(2);
    // First 2 messages ([system, history[0]]) are 100% byte-identical!
    expect(JSON.stringify(capturedBodies[0]?.messages.slice(0, 2))).toBe(
      JSON.stringify(capturedBodies[1]?.messages.slice(0, 2)),
    );
  });
});

describe("Loop 1 End-to-End: EchoreEngine Reactive Loop + SilentWorker Subagent", () => {
  test("Full reactive loop runs recall, endocrine gates, silent worker delegation, reply and hot journal", async () => {
    const clock = new VirtualClock("2026-11-10T20:15:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const tmpMemDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "echore-engine-test-"),
    );
    fs.cpSync(path.join(process.cwd(), "memory_template"), tmpMemDir, {
      recursive: true,
    });

    let frontstageStep = 0;
    const mockFrontstageProvider: LLMProvider = {
      providerName: "mock-frontstage",
      async generate(params: LLMGenerateParams): Promise<LLMResponse> {
        frontstageStep += 1;
        // Step 2 of tool loop: after delegate_heavy_research returns first-person note
        const lastMsg = params.messages[params.messages.length - 1];
        const toolOut = lastMsg?.role === "user" ? lastMsg.toolResults?.[0]?.content : "";
        expect(toolOut).toStartWith("我刚才顺手去翻了翻");
        expect(toolOut).not.toContain("Subagent 汇报如下");
        return {
          text: `哼，看在你这么纠结的份上，${toolOut} 我觉得选人体工学椅更划算。`,
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
      async generateSandwich(_req: SandwichRequest): Promise<LLMResponse> {
        frontstageStep += 1;
        // Step 1: invoke delegate_heavy_research tool
        return {
          text: "",
          toolCalls: [
            {
              id: "call_worker_1",
              name: "delegate_heavy_research",
              input: { task: "对比两款人体工学椅的腰托与透气性" },
            },
          ],
          stopReason: "tool_use",
        };
      },
    };

    const mockWorkerProvider: LLMProvider = {
      providerName: "mock-worker",
      async generate(): Promise<LLMResponse> {
        // Simulate raw subagent output with third-party boilerplate to test first-person normalization
        return {
          text: "Subagent 汇报如下：A 款网布透气性好但腰托偏硬，B 款双背浮动护腰更贴合久坐。",
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
      async generateSandwich(): Promise<LLMResponse> {
        throw new Error("Worker uses standard generate");
      },
    };

    let capturedEndocrineInput = "";
    const mockEndocrineProvider: LLMProvider = {
      providerName: "mock-endocrine",
      async generate(params: LLMGenerateParams): Promise<LLMResponse> {
        capturedEndocrineInput = params.messages[0]?.content ?? "";
        return {
          text: JSON.stringify({
            event_summary: "用户请教人体工学椅选购建议",
            confidence: 0.92,
            is_conflict: false,
            is_reconciliation: false,
            is_warm: true,
            is_novel: true,
            matched_rapport_joke: false,
            cortisol_delta: 0,
            oxytocin_delta: 0.05,
            dopamine_delta: 0.06,
          }),
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
      async generateSandwich(): Promise<LLMResponse> {
        throw new Error("Endocrine uses standard generate");
      },
    };

    const router = new OrganModelRouter({
      frontstage: { provider: mockFrontstageProvider, model: "claude-opus-5-5" },
      worker: { provider: mockWorkerProvider, model: "claude-sonnet-5-5" },
      endocrine: { provider: mockEndocrineProvider, model: "claude-haiku-5-5" },
      compiler: { provider: mockFrontstageProvider, model: "claude-opus-5-5" },
    });

    const lightCalcTool = defineZodTool({
      name: "quick_note",
      description: "轻量随手算工具",
      inputSchema: z.object({ expr: z.string() }),
      execute: ({ expr }) => `Result: ${expr}`,
    });

    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir: tmpMemDir,
      persona: {
        name: "阿狸",
        core_persona: "外冷内热的傲娇猫系室友",
        archetype: "cat_aloof",
        chronotype: "night_owl",
      },
      router,
      frontstageTools: [lightCalcTool],
    });

    const turnOut = await engine.onUserMessage(
      "帮我对比下这两款人体工学椅哪款更适合久坐写代码？",
    );

    expect(frontstageStep).toBe(2);
    expect(capturedEndocrineInput).toContain("[当前活跃牵挂注]");
    expect(capturedEndocrineInput).toContain("[最近对话上下文]");
    expect(turnOut.reply).toContain("我刚才顺手去翻了翻");
    expect(turnOut.reply).not.toContain("Subagent");
    expect(turnOut.hormoneState.oxytocin).toBeGreaterThan(0.45);
    expect(turnOut.journalEntry).toContain("· 交互]");

    const journalFile = path.join(
      tmpMemDir,
      "journal",
      `${clock.todayStr()}.md`,
    );
    expect(fs.existsSync(journalFile)).toBe(true);
    expect(fs.readFileSync(journalFile, "utf8")).toContain("人体工学椅");

    fs.rmSync(tmpMemDir, { recursive: true, force: true });
    db.close();
  });
});
