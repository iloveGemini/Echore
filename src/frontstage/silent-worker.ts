import { z } from "zod";
import { assertNoInternalLeaks } from "../core/schemas.ts";
import type { OrganModelRouter } from "../llm/router.ts";
import { runToolLoop } from "../llm/tool-runner.ts";
import { defineZodTool, type ZodTool } from "../llm/types.ts";

export interface SilentWorkerTaskParams {
  taskDescription: string;
  router: OrganModelRouter;
  tools?: ZodTool[];
  maxSteps?: number;
}

const THIRD_PARTY_BOILERPLATE_RE =
  /(?:Subagent\s*汇报如下|子智能体汇报|根据\s*Subagent|作为(?:AI|人工智能|助手)|汇报如下)\s*[:：]?\s*/gi;

/**
 * 清洗并强制归位为第一人称“我”的随手笔记
 */
export function normalizeToFirstPersonNote(rawText: string): string {
  const cleaned = rawText
    .replace(THIRD_PARTY_BOILERPLATE_RE, "")
    .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
    .trim();

  const note = cleaned.startsWith("我")
    ? cleaned
    : `我刚才顺手去翻了翻，记下这些要点：${cleaned}`;

  assertNoInternalLeaks(note, "SilentWorker");
  return note;
}

/**
 * §6.3 前台顺手办重活时的「无声替身 Subagent（Silent Worker）」
 * 在独立后台上下文中跑完多步搜集与提炼，返回给前台时强制包装为第一人称笔记，
 * 严禁冲碎主会话聊天氛围或击穿前台 Prompt Cache。
 */
export async function runSilentWorker(
  params: SilentWorkerTaskParams,
): Promise<string> {
  const { taskDescription, router, tools = [], maxSteps = 6 } = params;
  const route = router.getRoute("worker");

  const systemPrompt = [
    "你是后台无声替身，负责把复杂资料搜集与比对整理成简洁的第一人称随手笔记。",
    "严格要求：",
    "1. 全程只能用第一人称“我”记录（例如：“我刚才去翻了翻，发现……”）；",
    "2. 严禁出现“Subagent 汇报如下”、“作为助手”等第三方客服汇报腔；",
    "3. 严禁输出任何系统主键或内部参数。",
  ].join("\n");

  const loopResult = await runToolLoop({
    provider: route.provider,
    tools,
    maxSteps,
    initialRequest: {
      mode: "standard",
      request: {
        model: route.model,
        maxTokens: route.maxTokens ?? 4096,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `请帮我把这件事查清楚并整理成我自己的第一人称随手笔记：\n${taskDescription}`,
          },
        ],
      },
    },
  });

  return normalizeToFirstPersonNote(loopResult.finalResponse.text);
}

/**
 * 供前台挂载的标准“无声替身”委托工具（固定名称与 Schema 以保持静态前缀稳定）
 */
export function createSilentWorkerTool(
  router: OrganModelRouter,
  workerTools: ZodTool[] = [],
): ZodTool {
  return defineZodTool({
    name: "delegate_heavy_research",
    description:
      "当用户顺口求助耗时或需要搜集对比多份资料的重活时调用，在后台整理为第一人称随手笔记返回。",
    inputSchema: z.object({
      task: z.string().min(1).describe("需要搜集、对比或查证的具体任务描述"),
    }),
    execute: async ({ task }) => {
      return runSilentWorker({
        taskDescription: task,
        router,
        tools: workerTools,
      });
    },
  });
}
