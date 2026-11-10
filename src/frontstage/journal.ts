import fs from "node:fs";
import path from "node:path";
import { formatLocalTimeHm } from "../core/clock.ts";
import {
  assertNoInternalLeaks,
  type SubconsciousHandover,
} from "../core/schemas.ts";
import type { ResolvedEndocrineProfile } from "../endocrine/archetypes.ts";
import { renderHandoverYaml } from "../endocrine/handover.ts";
import type { OrganModelRouter } from "../llm/router.ts";

export interface HotJournalEntryInput {
  memoryDir: string;
  dateStr: string; // YYYY-MM-DD
  timeStr: string; // HH:MM
  firstPersonText: string;
  tag?: "交互" | "独居" | "睡前自省";
}

/**
 * §1.1 & §3.3 前台执笔区（memory/journal/YYYY-MM-DD.md）
 * 只写第一人称自然语言，不写 YAML 头或 supersedes ID，严禁包含 log-* 主键或激素浮点数。
 */
export function appendHotJournalEntry(input: HotJournalEntryInput): string {
  const {
    memoryDir,
    dateStr,
    timeStr,
    firstPersonText,
    tag = "交互",
  } = input;

  const cleanText = firstPersonText
    .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  assertNoInternalLeaks(cleanText, "appendHotJournalEntry");

  const journalDir = path.join(memoryDir, "journal");
  fs.mkdirSync(journalDir, { recursive: true });
  const filePath = path.join(journalDir, `${dateStr}.md`);

  const exists = fs.existsSync(filePath);
  const header = exists ? "" : `# ${dateStr} 随手记\n\n`;
  const entryLine = `- [${timeStr} · ${tag}] ${cleanText}\n`;

  fs.appendFileSync(filePath, `${header}${entryLine}`, "utf8");
  return entryLine.trim();
}

export function readJournalContent(
  memoryDir: string,
  dateStr: string,
): string {
  const filePath = path.join(memoryDir, "journal", `${dateStr}.md`);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

/**
 * 提取当日所有白天热记事（交互 + 独居）
 */
export function extractHotEntriesForDate(
  memoryDir: string,
  dateStr: string,
): string[] {
  const content = readJournalContent(memoryDir, dateStr);
  if (!content) return [];
  const entries: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^-\s*\[[^\]]+·\s*(?:交互|独居)\]\s*(.+)$/);
    if (match?.[1]) {
      entries.push(match[1].trim());
    }
  }
  return entries;
}

/**
 * 提取当日睡前自省冷叙事（用于记忆官编译时原样挂入 `## 前台原叙`）
 */
export function extractColdReflectionForDate(
  memoryDir: string,
  dateStr: string,
): string | null {
  const content = readJournalContent(memoryDir, dateStr);
  if (!content) return null;

  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    const tagMatch = trimmed.match(/^-\s*\[[^\]]+·\s*睡前自省\]\s*(.+)$/);
    if (tagMatch?.[1]) {
      return tagMatch[1].trim();
    }
  }

  const quoteLines = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("> "))
    .map((l) => l.replace(/^>\s*/, "").trim())
    .filter(Boolean);
  if (quoteLines.length > 0) {
    return quoteLines[quoteLines.length - 1]!;
  }
  return null;
}

/**
 * 追加睡前第一人称自省冷叙事至 journal/YYYY-MM-DD.md
 */
export function appendColdReflectionEntry(input: {
  memoryDir: string;
  dateStr: string;
  timeStr: string;
  reflectionText: string;
}): string {
  const cleanText = input.reflectionText
    .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
    .replace(/^>\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  assertNoInternalLeaks(cleanText, "appendColdReflectionEntry");

  const journalDir = path.join(input.memoryDir, "journal");
  fs.mkdirSync(journalDir, { recursive: true });
  const filePath = path.join(journalDir, `${input.dateStr}.md`);

  const exists = fs.existsSync(filePath);
  const header = exists ? "" : `# ${input.dateStr} 随手记\n\n`;
  const existingContent = exists ? fs.readFileSync(filePath, "utf8") : "";
  const sectionHeader = existingContent.includes("## 睡前自省")
    ? ""
    : "\n## 睡前自省\n";
  const block = `${header}${sectionHeader}- [${input.timeStr} · 睡前自省] ${cleanText}\n> ${cleanText}\n`;

  fs.appendFileSync(filePath, block, "utf8");
  return cleanText;
}

/**
 * §1.2 夜相 Step 1：前台汇总当日交互与独居热记事，撰写第一人称睡前自省冷叙事（保住自传产权）
 */
export async function synthesizeBedtimeReflection(params: {
  router: OrganModelRouter;
  profile: ResolvedEndocrineProfile;
  memoryDir: string;
  dateStr: string;
  now: Date;
  handover?: SubconsciousHandover;
  overrideReflectionText?: string;
}): Promise<string> {
  const {
    router,
    profile,
    memoryDir,
    dateStr,
    now,
    handover,
    overrideReflectionText,
  } = params;

  const timeStr = formatLocalTimeHm(now);

  if (overrideReflectionText?.trim()) {
    return appendColdReflectionEntry({
      memoryDir,
      dateStr,
      timeStr,
      reflectionText: overrideReflectionText,
    });
  }

  const hotEntries = extractHotEntriesForDate(memoryDir, dateStr);
  if (hotEntries.length === 0) {
    const quietReflection = `今日平淡无波澜，按时歇下。`;
    return appendColdReflectionEntry({
      memoryDir,
      dateStr,
      timeStr,
      reflectionText: quietReflection,
    });
  }

  const route = router.getRoute("frontstage");
  const system = [
    `# 住户身份：${profile.name}`,
    profile.core_persona,
    "",
    "现在是睡前时刻。请以第一人称“我”回顾今天随手记下的片段，写一段简短、真实、带自己脾气的睡前自省日记（1~3 句话）。",
    "要求：",
    "- 只写纯正文自然语言，必须包含第一人称认知（“我”或自身视角）；",
    "- 严禁写 YAML 头、Markdown 标题或任何系统参数；",
    "- 严禁无根据地编造白天没发生过的事件。",
  ].join("\n");

  const userPromptParts = [
    `[今日白天随手记]\n${hotEntries.map((e) => `- ${e}`).join("\n")}`,
  ];
  if (handover) {
    userPromptParts.push(`[当下心境]\n${renderHandoverYaml(handover)}`);
  }

  const resp = await route.provider.generate({
    model: route.model,
    maxTokens: 300,
    system,
    messages: [
      {
        role: "user",
        content: userPromptParts.join("\n\n"),
      },
    ],
  });

  const rawText = resp.text.trim();
  const fallbackText =
    rawText || hotEntries.join("；") || "今日日常记录。";

  return appendColdReflectionEntry({
    memoryDir,
    dateStr,
    timeStr,
    reflectionText: fallbackText,
  });
}
