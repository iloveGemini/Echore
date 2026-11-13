import matter from "gray-matter";
import { PROMPTS_DIR, readPrompt } from "../core/prompts.ts";
import {
  assertNoInternalLeaks,
  type NamingState,
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

export function interpolateFrontstageVariables(
  templateText: string,
  profile: Pick<
    ResolvedEndocrineProfile,
    "name" | "user_name" | "user_pronoun" | "relationship"
  >,
): string {
  const residentName = profile.name?.trim() || "Echore";
  const userName = profile.user_name?.trim() || "用户";
  const userPronoun = profile.user_pronoun?.trim() || "他";
  const relationship = profile.relationship?.trim() || "初识";

  return templateText
    .replaceAll("{resident_name}", residentName)
    .replaceAll("{user_name}", userName)
    .replaceAll("{user_pronoun}", userPronoun)
    .replaceAll("{relationship}", relationship);
}

export function buildStaticSystemPartA(
  profile: ResolvedEndocrineProfile,
  promptsDir = PROMPTS_DIR,
): string {
  const rawSystemRuleText = readPrompt("frontstage-system.md", promptsDir).text;
  const systemRuleText = interpolateFrontstageVariables(
    rawSystemRuleText,
    profile,
  );
  const text = [
    `# 住户身份：${profile.name}`,
    profile.core_persona,
    ...(systemRuleText ? ["", systemRuleText] : []),
  ].join("\n");

  assertNoInternalLeaks(text, "buildStaticSystemPartA");
  return text;
}

export function buildDynamicSubconsciousBlock(params: {
  handover: SubconsciousHandover;
  recallResult: RecallResult;
  perceptionSlice?: string;
  secretPrepNote?: string;
  userPronoun?: string;
  namingState?: NamingState;
  historyTurnCount?: number;
}): string {
  const sections: string[] = [];
  const pronoun = params.userPronoun?.trim() || "他";

  sections.push(`# 潜意识心境交接单\n${renderHandoverYaml(params.handover)}`);

  if (params.recallResult.formattedBlock.trim()) {
    sections.push(`# 脑海里浮现的往事与原话印象\n${params.recallResult.formattedBlock}`);
  }

  if (params.secretPrepNote?.trim()) {
    sections.push(`# 我之前顺手帮${pronoun}准备好的备忘\n${params.secretPrepNote.trim()}`);
  }

  if (params.perceptionSlice?.trim()) {
    sections.push(`# 当下环境与伴生感知\n${params.perceptionSlice.trim()}`);
  }

  if (
    params.namingState === "pending" &&
    (params.historyTurnCount ?? 0) <= 15
  ) {
    sections.push(
      `# 待定名提示\n我现在暂时还用着代号「Echore」，还没有正式名字。如果聊到取名，可以按我自己的脾气提议一个或和${pronoun}一起定；一旦定下来，直接用 edit 修改 people/self.md 里的「#姓名」那一行即可，平时没聊到时不用生硬推销改名。`,
    );
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
  namingState?: NamingState;
  latestUserMessage: string;
  promptsDir?: string;
}): SandwichRequest {
  const systemPartA = buildStaticSystemPartA(params.profile, params.promptsDir);
  const systemPartB = sanitizeRapportForFrontstage(params.rawRapportMarkdown);
  const userTurnsSoFar = Math.floor(params.appendOnlyHistory.length / 2);
  const subconsciousBlock = buildDynamicSubconsciousBlock({
    handover: params.handover,
    recallResult: params.recallResult,
    perceptionSlice: params.perceptionSlice,
    secretPrepNote: params.secretPrepNote,
    userPronoun: params.profile.user_pronoun,
    namingState: params.namingState,
    historyTurnCount: userTurnsSoFar,
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
  namingState?: NamingState;
  latestUserMessage: string;
  maxToolSteps?: number;
  promptsDir?: string;
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
    namingState: params.namingState,
    latestUserMessage: params.latestUserMessage,
    promptsDir: params.promptsDir,
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
