import { assertNoInternalLeaks } from "../core/schemas.ts";
import {
  type ChatMessage,
  type EmbeddingGenerateParams,
  type EmbeddingProvider,
  type LLMGenerateParams,
  type LLMProvider,
  type LLMResponse,
  type SandwichRequest,
  type ToolCallBlock,
  type ZodTool,
  zodObjectToJsonSchema,
} from "./types.ts";

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

export interface OpenAICompatAdapterOptions {
  apiKey?: string;
  baseURL?: string;
  fetchFn?: typeof fetch;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

function toOpenAITools(tools?: ZodTool[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodObjectToJsonSchema(t.inputSchema),
      strict: true,
    },
  }));
}

function toOpenAIMessages(
  systemPrompt: string | undefined,
  history: ChatMessage[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (systemPrompt) {
    out.push({ role: "system", content: systemPrompt });
  }

  for (const msg of history) {
    if (msg.role === "user") {
      if (msg.toolResults && msg.toolResults.length > 0) {
        for (const tr of msg.toolResults) {
          out.push({
            role: "tool",
            tool_call_id: tr.toolUseId,
            content: tr.content,
          });
        }
      }
      if (msg.content) {
        out.push({ role: "user", content: msg.content });
      }
    } else {
      const tool_calls =
        msg.toolCalls && msg.toolCalls.length > 0
          ? msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input ?? {}),
              },
            }))
          : undefined;
      out.push({
        role: "assistant",
        content: msg.content || null,
        ...(tool_calls ? { tool_calls } : {}),
      });
    }
  }
  return out;
}

export class OpenAICompatAdapter implements LLMProvider, EmbeddingProvider {
  readonly providerName = "openai-compat";
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAICompatAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseURL = (
      options.baseURL ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1"
    ).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async generate(params: LLMGenerateParams): Promise<LLMResponse> {
    const messages = toOpenAIMessages(params.system, params.messages);
    const tools = toOpenAITools(params.tools);
    return this.sendChatCompletion({
      model: params.model,
      max_tokens: params.maxTokens ?? 8192,
      messages,
      ...(tools ? { tools } : {}),
    });
  }

  /**
   * §6.6 保持前缀字节 100% 稳定，使 OpenAI / DeepSeek / Qwen 自动前缀缓存命中
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

    const stableSystem = `${request.staticPrefix.systemPartA}\n\n${request.staticPrefix.systemPartB}`;
    const messages = toOpenAIMessages(stableSystem, request.appendOnlyHistory);

    const tailContent = request.dynamicTail.subconsciousBlock
      ? `<subconscious_context>\n${request.dynamicTail.subconsciousBlock}\n</subconscious_context>\n\n${request.dynamicTail.latestUserMessage}`
      : request.dynamicTail.latestUserMessage;

    messages.push({
      role: "user",
      content: tailContent,
    });

    const tools = toOpenAITools(request.staticPrefix.tools);
    return this.sendChatCompletion({
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      messages,
      ...(tools ? { tools } : {}),
    });
  }

  /**
   * Wave 5.1 标准 OpenAI 兼容 `/embeddings` 批量向量化接口
   * 兼容 OpenAI / SiliconFlow / Ollama / Voyage / Jina 等 `/v1/embeddings` 端点
   */
  async embed(params: EmbeddingGenerateParams): Promise<number[][]> {
    if (params.texts.length === 0) {
      return [];
    }

    const response = await this.fetchFn(`${this.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: params.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
        input: params.texts,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `OpenAICompatAdapter Embeddings HTTP ${response.status}: ${errText}`,
      );
    }

    const json = (await response.json()) as {
      data?: Array<{
        index?: number;
        embedding?: number[];
      }>;
    };

    const items = [...(json.data ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    return items.map((item) =>
      Array.isArray(item.embedding) ? item.embedding : [],
    );
  }

  private async sendChatCompletion(
    body: Record<string, unknown>,
  ): Promise<LLMResponse> {
    const response = await this.fetchFn(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `OpenAICompatAdapter HTTP ${response.status}: ${errText}`,
      );
    }

    const json = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    const choice = json.choices?.[0];
    const message = choice?.message;
    const text = (message?.content ?? "").trim();
    const toolCalls: ToolCallBlock[] = (message?.tool_calls ?? []).map(
      (tc) => {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsedInput = {};
        }
        return {
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        };
      },
    );

    const stopReason =
      toolCalls.length > 0 || choice?.finish_reason === "tool_calls"
        ? "tool_use"
        : choice?.finish_reason === "length"
          ? "max_tokens"
          : "end_turn";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cacheReadInputTokens:
          json.usage?.prompt_cache_hit_tokens ??
          json.usage?.prompt_tokens_details?.cached_tokens ??
          0,
      },
      raw: json,
    };
  }
}
