import Anthropic from "@anthropic-ai/sdk";
import { assertNoInternalLeaks } from "../core/schemas.ts";
import {
  type ChatMessage,
  type LLMGenerateParams,
  type LLMProvider,
  type LLMResponse,
  type SandwichRequest,
  type ToolCallBlock,
  type ZodTool,
  zodObjectToJsonSchema,
} from "./types.ts";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  baseURL?: string;
  client?: Pick<Anthropic, "messages">;
  enableAdaptiveThinking?: boolean;
}

function toAnthropicTools(tools?: ZodTool[]): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodObjectToJsonSchema(t.inputSchema),
    strict: true,
  }));
}

function toAnthropicMessages(
  history: ChatMessage[],
  markLastWithCacheBreakpoint: boolean,
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!;
    const isLast = i === history.length - 1;
    const shouldCache = isLast && markLastWithCacheBreakpoint;

    if (msg.role === "user") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.toolResults && msg.toolResults.length > 0) {
        for (const tr of msg.toolResults) {
          blocks.push({
            type: "tool_result",
            tool_use_id: tr.toolUseId,
            content: tr.content,
            is_error: tr.isError,
          });
        }
      }
      if (msg.content) {
        blocks.push({
          type: "text",
          text: msg.content,
        });
      }
      if (shouldCache && blocks.length > 0) {
        const lastBlock = blocks[blocks.length - 1]!;
        if ("cache_control" in lastBlock || lastBlock.type === "text" || lastBlock.type === "tool_result") {
          (lastBlock as Anthropic.TextBlockParam).cache_control = {
            type: "ephemeral",
          };
        }
      }
      result.push({ role: "user", content: blocks });
    } else {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        blocks.push({
          type: "text",
          text: msg.content,
        });
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input ?? {},
          });
        }
      }
      if (shouldCache && blocks.length > 0) {
        const lastBlock = blocks[blocks.length - 1]!;
        (lastBlock as Anthropic.TextBlockParam).cache_control = {
          type: "ephemeral",
        };
      }
      result.push({ role: "assistant", content: blocks });
    }
  }

  return result;
}

export class AnthropicAdapter implements LLMProvider {
  readonly providerName = "anthropic";
  private readonly client: Pick<Anthropic, "messages">;
  private readonly enableAdaptiveThinking: boolean;

  constructor(options: AnthropicAdapterOptions = {}) {
    if (options.client) {
      this.client = options.client;
    } else {
      this.client = new Anthropic({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
      });
    }
    this.enableAdaptiveThinking = options.enableAdaptiveThinking ?? false;
  }

  async generate(params: LLMGenerateParams): Promise<LLMResponse> {
    const messages = toAnthropicMessages(params.messages, false);
    const tools = toAnthropicTools(params.tools);

    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens ?? 16000,
      ...(params.system ? { system: params.system } : {}),
      ...(tools ? { tools } : {}),
      ...(this.enableAdaptiveThinking
        ? { thinking: { type: "adaptive" } }
        : {}),
      messages,
    };

    const res = await this.client.messages.create(createParams);
    return this.parseResponse(res);
  }

  /**
   * §6.6 严格按照三明治顺序构造 Anthropic 请求：
   * - 断点 1：锁住 System Part A + System Part B（rapport.md）
   * - 断点 2：锁住只追加历史区末尾
   * - 动态尾部：当轮心境交接单 + 预水合记忆 + 最新用户话语垫在最末尾
   */
  async generateSandwich(request: SandwichRequest): Promise<LLMResponse> {
    assertNoInternalLeaks(request.staticPrefix.systemPartA, "systemPartA");
    assertNoInternalLeaks(request.staticPrefix.systemPartB, "systemPartB");
    if (request.dynamicTail.subconsciousBlock) {
      assertNoInternalLeaks(
        request.dynamicTail.subconsciousBlock,
        "subconsciousBlock",
      );
    }

    const systemBlocks: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: request.staticPrefix.systemPartA,
      },
      {
        type: "text",
        text: request.staticPrefix.systemPartB,
        cache_control: { type: "ephemeral" }, // ◄ Claude 缓存断点 1
      },
    ];

    const historyMessages = toAnthropicMessages(
      request.appendOnlyHistory,
      request.appendOnlyHistory.length > 0, // ◄ Claude 缓存断点 2
    );

    const tailBlocks: Anthropic.TextBlockParam[] = [];
    if (request.dynamicTail.subconsciousBlock) {
      tailBlocks.push({
        type: "text",
        text: `<subconscious_context>\n${request.dynamicTail.subconsciousBlock}\n</subconscious_context>`,
      });
    }
    tailBlocks.push({
      type: "text",
      text: request.dynamicTail.latestUserMessage,
    });

    const messages: Anthropic.MessageParam[] = [
      ...historyMessages,
      {
        role: "user",
        content: tailBlocks,
      },
    ];

    const tools = toAnthropicTools(request.staticPrefix.tools);

    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? 16000,
      system: systemBlocks,
      ...(tools ? { tools } : {}),
      ...(this.enableAdaptiveThinking
        ? { thinking: { type: "adaptive" } }
        : {}),
      messages,
    };

    const res = await this.client.messages.create(createParams);
    return this.parseResponse(res);
  }

  private parseResponse(res: Anthropic.Message): LLMResponse {
    if (res.stop_reason === "refusal") {
      return {
        text: "",
        toolCalls: [],
        stopReason: "refusal",
        raw: res,
      };
    }

    const textParts: string[] = [];
    const toolCalls: ToolCallBlock[] = [];

    for (const block of res.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }

    const stopReason =
      res.stop_reason === "tool_use"
        ? "tool_use"
        : res.stop_reason === "max_tokens"
          ? "max_tokens"
          : res.stop_reason === "end_turn"
            ? "end_turn"
            : "other";

    return {
      text: textParts.join("\n").trim(),
      toolCalls,
      stopReason,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadInputTokens:
          (res.usage as { cache_read_input_tokens?: number })
            .cache_read_input_tokens ?? 0,
        cacheCreationInputTokens:
          (res.usage as { cache_creation_input_tokens?: number })
            .cache_creation_input_tokens ?? 0,
      },
      raw: res,
    };
  }
}
