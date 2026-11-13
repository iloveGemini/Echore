import { z } from "zod";

export type OrganRole = "frontstage" | "endocrine" | "compiler" | "worker";

export interface ZodTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any) => Promise<string> | string;
}

export interface ToolCallBlock {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ChatMessage =
  | {
      role: "user";
      content: string;
      toolResults?: ToolResultBlock[];
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCallBlock[];
    };

/**
 * §6.6 跨厂商「三明治 Prompt Caching」上下文组装结构（静前动后）
 */
export interface SandwichRequest {
  model: string;
  maxTokens?: number;
  /** 第 1 段：全天候静态区（24h 内一字不改 ── 100% 命中前缀缓存） */
  staticPrefix: {
    tools?: ZodTool[];
    systemPartA: string; // 住户核心人设 + 第一人称主权规则
    systemPartB: string; // implicit/rapport.md 常驻内隐默契底座
  };
  /** 第 2 段：只追加历史区（Append-Only ── 多轮对话持续命中缓存） */
  appendOnlyHistory: ChatMessage[];
  /** 第 3 段：当轮动态尾部（每轮都在变 ── 永远垫在最末尾，不毁前缀） */
  dynamicTail: {
    subconsciousBlock?: string; // 当轮《潜意识心境交接单》+ 三桶预水合记忆 + 感知快照
    latestUserMessage: string;
  };
}

export interface LLMGenerateParams {
  model: string;
  maxTokens?: number;
  system?: string;
  systemBlocks?: Array<{ text: string; cacheBreakpoint?: boolean }>;
  cacheBreakpointMessageIndex?: number;
  messages: ChatMessage[];
  tools?: ZodTool[];
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCallBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage?: LLMUsage;
  raw?: unknown;
}

export interface LLMProvider {
  readonly providerName: string;
  generate(params: LLMGenerateParams): Promise<LLMResponse>;
  generateSandwich(request: SandwichRequest): Promise<LLMResponse>;
}

export interface EmbeddingGenerateParams {
  model?: string;
  texts: string[];
}

export interface EmbeddingProvider {
  readonly providerName: string;
  embed(params: EmbeddingGenerateParams): Promise<number[][]>;
}

/**
 * 轻量级 Zod Object Schema -> JSON Schema 转换器（带 additionalProperties: false）
 */
export function zodObjectToJsonSchema(schema: z.ZodTypeAny): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
} {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(shape)) {
      const { jsonProp, isOptional } = zodFieldToJsonProp(fieldSchema);
      properties[key] = jsonProp;
      if (!isOptional) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }

  return {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
}

function zodFieldToJsonProp(field: z.ZodTypeAny): {
  jsonProp: Record<string, unknown>;
  isOptional: boolean;
} {
  let current: z.ZodTypeAny = field;
  let isOptional = false;
  const description = field.description;

  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault
  ) {
    isOptional = true;
    current = (current as z.ZodOptional<z.ZodTypeAny>)._def.innerType;
  }

  let base: Record<string, unknown> = { type: "string" };
  if (current instanceof z.ZodString) {
    base = { type: "string" };
  } else if (current instanceof z.ZodNumber) {
    base = { type: "number" };
  } else if (current instanceof z.ZodBoolean) {
    base = { type: "boolean" };
  } else if (current instanceof z.ZodEnum) {
    base = { type: "string", enum: current._def.values };
  } else if (current instanceof z.ZodArray) {
    const inner = zodFieldToJsonProp(current._def.type);
    base = { type: "array", items: inner.jsonProp };
  } else if (current instanceof z.ZodObject) {
    base = zodObjectToJsonSchema(current);
  }

  if (description) {
    base.description = description;
  }

  return { jsonProp: base, isOptional };
}

export function defineZodTool<T extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  inputSchema: T;
  execute: (input: z.infer<T>) => Promise<string> | string;
}): ZodTool {
  return def;
}
