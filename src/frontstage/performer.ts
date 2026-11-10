import matter from "gray-matter";
import {
  assertNoInternalLeaks,
  type SubconsciousHandover,
} from "../core/schemas.ts";
import type { ResolvedEndocrineProfile } from "../endocrine/archetypes.ts";
import { renderHandoverYaml } from "../endocrine/handover.ts";
import type { RecallResult } from "../hippocampus/recall.ts";
import type { OrganModelRouter } from "../llm/router.ts";
import { runToolLoop, type ToolRunnerResult } from "../llm/tool-runner.ts";
import type {
  ChatMessage,
  SandwichRequest,
  ZodTool,
} from "../llm/types.ts";

/**
 * 清洗 rapport.md 正文中的 `[src: log-xxx]` 行尾溯源标记，
 * 确保常驻注入 System Part B 时绝对不把 `log-*` 主键暴露给前台。
 */
export function sanitizeRapportForFrontstage(rawRapportMarkdown: string): string {
  const parsed = matter(rawRapportMarkdown);
  const cleanedBody = parsed.content
    .replace(/\s*\[src:\s*log-[^\]]+\]/gi, "")
    .trim();
  assertNoInternalLeaks(cleanedBody, "sanitizeRapportForFrontstage");
  return cleanedBody;
}

export function buildStaticSystemPartA(
  profile: ResolvedEndocrineProfile,
): string {
  const text = [
    `# 住户身份：${profile.name}`,
    profile.core_persona,
    "",
    "## 第一人称主权与拟调节准绳",
    "- 你是唯一拥有第一人称“我”的传主，用自然真实的口吻与对方相处。",
    "- 严禁零成本冒领虚假的戏剧化体验；你的态度、亲疏与分寸自然受当下心境基调与盘旋心事的调节。",
    "- 潜意识递给你的心境与回忆是你自己脑海里的印象，自然化用，绝不复诵格式标签。",
  ].join("\n");

  assertNoInternalLeaks(text, "buildStaticSystemPartA");
  return text;
}

export function buildDynamicSubconsciousBlock(params: {
  handover: SubconsciousHandover;
  recallResult: RecallResult;
  perceptionSlice?: string;
  secretPrepNote?: string;
}): string {
  const sections: string[] = [];

  sections.push(`# 潜意识心境交接单\n${renderHandoverYaml(params.handover)}`);

  if (params.recallResult.formattedBlock.trim()) {
    sections.push(`# 脑海里浮现的往事与原话印象\n${params.recallResult.formattedBlock}`);
  }

  if (params.secretPrepNote?.trim()) {
    sections.push(`# 我之前顺手帮他准备好的备忘\n${params.secretPrepNote.trim()}`);
  }

  if (params.perceptionSlice?.trim()) {
    sections.push(`# 当下环境与伴生感知\n${params.perceptionSlice.trim()}`);
  }

  const combined = sections.join("\n\n");
  assertNoInternalLeaks(combined, "buildDynamicSubconsciousBlock");
  return combined;
}

/**
 * §6.6 构造严格遵循「静前动后」三明治顺序的 SandwichRequest
 */
export function assembleSandwichRequest(params: {
  model: string;
  maxTokens?: number;
  profile: ResolvedEndocrineProfile;
  rawRapportMarkdown: string;
  tools?: ZodTool[];
  appendOnlyHistory: ChatMessage[];
  handover: SubconsciousHandover;
  recallResult: RecallResult;
  perceptionSlice?: string;
  secretPrepNote?: string;
  latestUserMessage: string;
}): SandwichRequest {
  const systemPartA = buildStaticSystemPartA(params.profile);
  const systemPartB = sanitizeRapportForFrontstage(params.rawRapportMarkdown);
  const subconsciousBlock = buildDynamicSubconsciousBlock({
    handover: params.handover,
    recallResult: params.recallResult,
    perceptionSlice: params.perceptionSlice,
    secretPrepNote: params.secretPrepNote,
  });

  // Sort tools deterministically by name so tool order never invalidates prefix cache
  const sortedTools = params.tools
    ? [...params.tools].sort((a, b) => a.name.localeCompare(b.name))
    : undefined;

  return {
    model: params.model,
    maxTokens: params.maxTokens,
    staticPrefix: {
      tools: sortedTools,
      systemPartA,
      systemPartB,
    },
    appendOnlyHistory: [...params.appendOnlyHistory],
    dynamicTail: {
      subconsciousBlock,
      latestUserMessage: params.latestUserMessage,
    },
  };
}

export async function performFrontstageTurn(params: {
  router: OrganModelRouter;
  profile: ResolvedEndocrineProfile;
  rawRapportMarkdown: string;
  tools?: ZodTool[];
  appendOnlyHistory: ChatMessage[];
  handover: SubconsciousHandover;
  recallResult: RecallResult;
  perceptionSlice?: string;
  secretPrepNote?: string;
  latestUserMessage: string;
  maxToolSteps?: number;
}): Promise<{
  replyText: string;
  sandwichRequest: SandwichRequest;
  toolRunnerResult: ToolRunnerResult;
}> {
  const route = params.router.getRoute("frontstage");
  const sandwichRequest = assembleSandwichRequest({
    model: route.model,
    maxTokens: route.maxTokens ?? 8192,
    profile: params.profile,
    rawRapportMarkdown: params.rawRapportMarkdown,
    tools: params.tools,
    appendOnlyHistory: params.appendOnlyHistory,
    handover: params.handover,
    recallResult: params.recallResult,
    perceptionSlice: params.perceptionSlice,
    secretPrepNote: params.secretPrepNote,
    latestUserMessage: params.latestUserMessage,
  });

  const toolRunnerResult = await runToolLoop({
    provider: route.provider,
    tools: sandwichRequest.staticPrefix.tools ?? [],
    maxSteps: params.maxToolSteps ?? 6,
    initialRequest: {
      mode: "sandwich",
      request: sandwichRequest,
    },
  });

  const replyText = toolRunnerResult.finalResponse.text.trim();
  assertNoInternalLeaks(replyText, "performFrontstageTurn.replyText");

  return {
    replyText,
    sandwichRequest,
    toolRunnerResult,
  };
}
