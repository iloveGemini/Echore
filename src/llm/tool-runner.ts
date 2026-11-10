import type {
  ChatMessage,
  LLMGenerateParams,
  LLMProvider,
  LLMResponse,
  SandwichRequest,
  ToolResultBlock,
  ZodTool,
} from "./types.ts";

export interface ToolRunnerResult {
  finalResponse: LLMResponse;
  steps: number;
  executedTools: Array<{
    name: string;
    input: unknown;
    output: string;
    isError: boolean;
  }>;
}

/**
 * 通用多步 Zod 工具执行循环：
 * - 支持并行 tool_use 并在同一条 user 消息中返回全部 tool_result
 * - 使用 Zod 强校验工具入参，校验或执行报错时回传 isError: true
 */
export async function runToolLoop(params: {
  provider: LLMProvider;
  tools: ZodTool[];
  maxSteps?: number;
  initialRequest:
    | { mode: "sandwich"; request: SandwichRequest }
    | { mode: "standard"; request: LLMGenerateParams };
}): Promise<ToolRunnerResult> {
  const { provider, tools, maxSteps = 6, initialRequest } = params;
  const toolMap = new Map<string, ZodTool>(tools.map((t) => [t.name, t]));
  const executedTools: ToolRunnerResult["executedTools"] = [];

  let steps = 0;
  let currentResponse: LLMResponse;

  // Clone history so we don't mutate caller's array
  const workingHistory: ChatMessage[] =
    initialRequest.mode === "sandwich"
      ? [...initialRequest.request.appendOnlyHistory]
      : [...initialRequest.request.messages];

  while (steps < maxSteps) {
    steps += 1;

    if (initialRequest.mode === "sandwich") {
      if (steps === 1) {
        currentResponse = await provider.generateSandwich({
          ...initialRequest.request,
          staticPrefix: {
            ...initialRequest.request.staticPrefix,
            tools,
          },
          appendOnlyHistory: workingHistory,
        });
      } else {
        // After step 1, the initial dynamicTail user message has entered workingHistory
        const stableSystem = `${initialRequest.request.staticPrefix.systemPartA}\n\n${initialRequest.request.staticPrefix.systemPartB}`;
        currentResponse = await provider.generate({
          model: initialRequest.request.model,
          maxTokens: initialRequest.request.maxTokens,
          system: stableSystem,
          messages: workingHistory,
          tools,
        });
      }
    } else {
      currentResponse = await provider.generate({
        ...initialRequest.request,
        messages: workingHistory,
        tools,
      });
    }

    if (
      currentResponse.stopReason !== "tool_use" ||
      currentResponse.toolCalls.length === 0
    ) {
      return {
        finalResponse: currentResponse,
        steps,
        executedTools,
      };
    }

    // If step 1 was sandwich mode, push the initial dynamic user message before assistant tool_use turn
    if (initialRequest.mode === "sandwich" && steps === 1) {
      const tailText = initialRequest.request.dynamicTail.subconsciousBlock
        ? `<subconscious_context>\n${initialRequest.request.dynamicTail.subconsciousBlock}\n</subconscious_context>\n\n${initialRequest.request.dynamicTail.latestUserMessage}`
        : initialRequest.request.dynamicTail.latestUserMessage;
      workingHistory.push({
        role: "user",
        content: tailText,
      });
    }

    workingHistory.push({
      role: "assistant",
      content: currentResponse.text,
      toolCalls: currentResponse.toolCalls,
    });

    // Execute all tool calls in parallel and return all tool_result blocks in a single user message
    const toolResults: ToolResultBlock[] = await Promise.all(
      currentResponse.toolCalls.map(async (call) => {
        const tool = toolMap.get(call.name);
        if (!tool) {
          const msg = `Unknown tool: ${call.name}`;
          executedTools.push({
            name: call.name,
            input: call.input,
            output: msg,
            isError: true,
          });
          return {
            toolUseId: call.id,
            content: msg,
            isError: true,
          };
        }

        const parsed = tool.inputSchema.safeParse(call.input);
        if (!parsed.success) {
          const msg = `INVALID_JSON / Schema validation failed for ${call.name}: ${parsed.error.message}`;
          executedTools.push({
            name: call.name,
            input: call.input,
            output: msg,
            isError: true,
          });
          return {
            toolUseId: call.id,
            content: msg,
            isError: true,
          };
        }

        try {
          const output = await tool.execute(parsed.data);
          executedTools.push({
            name: call.name,
            input: parsed.data,
            output,
            isError: false,
          });
          return {
            toolUseId: call.id,
            content: output,
            isError: false,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          executedTools.push({
            name: call.name,
            input: parsed.data,
            output: msg,
            isError: true,
          });
          return {
            toolUseId: call.id,
            content: msg,
            isError: true,
          };
        }
      }),
    );

    workingHistory.push({
      role: "user",
      content: "",
      toolResults,
    });
  }

  return {
    finalResponse: currentResponse!,
    steps,
    executedTools,
  };
}
