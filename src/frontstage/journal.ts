import fs from "node:fs";
import path from "node:path";
import { formatLocalTimeHm } from "../core/clock.ts";
import { PROMPTS_DIR, readPrompt } from "../core/prompts.ts";
import {
  assertNoInternalLeaks,
  type EventLogRecord,
  type SubconsciousHandover,
} from "../core/schemas.ts";
import type { ResolvedEndocrineProfile } from "../endocrine/archetypes.ts";
import { renderHandoverYaml } from "../endocrine/handover.ts";
import type { OrganModelRouter } from "../llm/router.ts";

export const DEFAULT_FEEDBACK_SEGMENT_GAP_MS = 30 * 60_000;

export interface FeedbackTriplet {
  prev: EventLogRecord | null;
  acts: EventLogRecord[];
  next: EventLogRecord | null;
}

/**
 * Wave 4.1 基于 30min 时间窗切段的双向原话反馈链提取（吸收自 Psyche `review.md` & `coldwrite.ts`）：
 * - 相邻消息时间差 > 30min 视为不同对话段，绝不跨断档强行配对；
 * - 在同一连续对话段内，机械配对「用户前一句 prev → 住户连续回复 acts → 用户紧接着的真实反应 next」。
 */
function isGenuineUserEvent(e: EventLogRecord): boolean {
  if (e.status && e.status !== "active") return false;
  if (e.producer) return e.producer === "user";
  return e.role === "user";
}

function isGenuineResidentEvent(e: EventLogRecord): boolean {
  if (e.status && e.status !== "active") return false;
  if (e.producer) return e.producer === "resident";
  return e.role === "assistant";
}

export function extractFeedbackTriplets(
  events: readonly EventLogRecord[],
  maxGapMs = DEFAULT_FEEDBACK_SEGMENT_GAP_MS,
): FeedbackTriplet[] {
  const dialogEvents = events.filter(
    (e) => isGenuineUserEvent(e) || isGenuineResidentEvent(e),
  );
  if (dialogEvents.length === 0) return [];

  // 1. 按相邻时间差 <= maxGapMs 切分为连续对话段
  const segments: EventLogRecord[][] = [];
  let currentSeg: EventLogRecord[] = [];

  for (const ev of dialogEvents) {
    if (currentSeg.length === 0) {
      currentSeg.push(ev);
      continue;
    }
    const prevEv = currentSeg[currentSeg.length - 1]!;
    const prevMs = Date.parse(prevEv.timestamp);
    const currMs = Date.parse(ev.timestamp);
    if (
      Number.isFinite(prevMs) &&
      Number.isFinite(currMs) &&
      currMs - prevMs > maxGapMs
    ) {
      segments.push(currentSeg);
      currentSeg = [ev];
    } else {
      currentSeg.push(ev);
    }
  }
  if (currentSeg.length > 0) {
    segments.push(currentSeg);
  }

  // 2. 在每个连续段内提取 prev -> acts -> next 三联包
  const triplets: FeedbackTriplet[] = [];
  for (const seg of segments) {
    let i = 0;
    let lastUserEv: EventLogRecord | null = null;
    while (i < seg.length) {
      const ev = seg[i]!;
      if (isGenuineUserEvent(ev)) {
        lastUserEv = ev;
        i += 1;
        continue;
      }
      const acts: EventLogRecord[] = [];
      while (i < seg.length && isGenuineResidentEvent(seg[i]!)) {
        acts.push(seg[i]!);
        i += 1;
      }
      const nextUserEv =
        i < seg.length && isGenuineUserEvent(seg[i]!) ? seg[i]! : null;
      triplets.push({
        prev: lastUserEv,
        acts,
        next: nextUserEv,
      });
    }
  }

  return triplets;
}

function sanitizeFeedbackQuote(text: string): string {
  return text
    .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

/**
 * 将双向原话反馈链渲染为面向前台睡前自省的零主键文本块
 */
export function formatFeedbackTripletsForReflection(
  triplets: readonly FeedbackTriplet[],
): string {
  if (triplets.length === 0) return "";
  const lines = triplets.slice(-8).map((t) => {
    const parts: string[] = [];
    if (t.prev) {
      parts.push(`他说：“${sanitizeFeedbackQuote(t.prev.content)}”`);
    }
    const actsText = t.acts
      .map((a) => sanitizeFeedbackQuote(a.content))
      .join(" / ");
    parts.push(`我回：“${actsText}”`);
    if (t.next) {
      parts.push(`他随后反应：“${sanitizeFeedbackQuote(t.next.content)}”`);
    } else {
      parts.push(`（他随后未再接话）`);
    }
    return `- ${parts.join(" → ")}`;
  });
  const joined = lines.join("\n");
  assertNoInternalLeaks(joined, "formatFeedbackTripletsForReflection");
  return joined;
}

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

/**
 * 当发生删除、Reroll 或版本切换时，按当前 `status = 'active'` 的当日事件流同步重整 `journal/YYYY-MM-DD.md` 中的 `交互` 热记事行，
 * 保留 `独居` 与 `睡前自省` 原文，确保被丢弃的 Reroll 候选或已删消息绝不残留在热记事里进入夜间编译。
 */
export function syncInteractiveHotJournalForDate(params: {
  memoryDir: string;
  dateStr: string;
  activeDateEvents: readonly EventLogRecord[];
}): void {
  const { memoryDir, dateStr, activeDateEvents } = params;
  const filePath = path.join(memoryDir, "journal", `${dateStr}.md`);
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const nonInteractiveLines = lines.filter(
    (l) => !/^-\s*\[[^\]]+·\s*交互\]/.test(l.trim()),
  );

  const interactiveLines: string[] = [];
  const activeOnly = activeDateEvents.filter(
    (e) => (e.status ?? "active") === "active",
  );

  let i = 0;
  while (i < activeOnly.length) {
    const ev = activeOnly[i]!;
    const producer =
      ev.producer ??
      (ev.role === "user"
        ? "user"
        : ev.role === "assistant"
          ? "resident"
          : ev.role);

    if (
      producer === "resident" &&
      (ev.source === "heartbeat" || ev.metadata?.proactive === true)
    ) {
      const timeStr = formatLocalTimeHm(new Date(ev.timestamp));
      const clean = ev.content
        .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      const line = `- [${timeStr} · 交互] 我主动找他说：“${clean.slice(0, 60)}”`;
      assertNoInternalLeaks(line, "syncInteractiveHotJournalForDate");
      interactiveLines.push(line);
      i += 1;
      continue;
    }

    if (producer === "user") {
      const nextEv = activeOnly[i + 1];
      const nextProducer =
        nextEv?.producer ??
        (nextEv?.role === "assistant" ? "resident" : nextEv?.role);
      if (
        nextEv &&
        (nextProducer === "resident" || nextProducer === "external")
      ) {
        const timeStr = formatLocalTimeHm(new Date(nextEv.timestamp));
        const cleanUser = ev.content
          .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        const cleanReply = nextEv.content
          .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        const prefix =
          nextEv.source === "mcp_digest"
            ? `刚才在外面和他就“${cleanUser.slice(0, 30)}”聊了一轮，我回他：“${cleanReply.slice(0, 60)}”`
            : `今天和他就“${cleanUser.slice(0, 30)}”聊了几句，我回他：“${cleanReply.slice(0, 60)}”`;
        const line = `- [${timeStr} · 交互] ${prefix}`;
        assertNoInternalLeaks(line, "syncInteractiveHotJournalForDate");
        interactiveLines.push(line);
        i += 2;
        continue;
      }
    }

    i += 1;
  }

  // Insert interactiveLines before `## 睡前自省` if present, otherwise at the end
  const reflectionHeaderIdx = nonInteractiveLines.findIndex((l) =>
    l.trim().startsWith("## 睡前自省"),
  );
  let rebuilt: string[];
  if (reflectionHeaderIdx !== -1) {
    rebuilt = [
      ...nonInteractiveLines.slice(0, reflectionHeaderIdx),
      ...interactiveLines,
      ...nonInteractiveLines.slice(reflectionHeaderIdx),
    ];
  } else {
    const trimmedTail = [...nonInteractiveLines];
    while (
      trimmedTail.length > 0 &&
      trimmedTail[trimmedTail.length - 1]!.trim() === ""
    ) {
      trimmedTail.pop();
    }
    rebuilt = [...trimmedTail, ...interactiveLines, ""];
  }

  const nextContent = `${rebuilt.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  fs.writeFileSync(filePath, nextContent, "utf8");
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
  todaysEvents?: readonly EventLogRecord[];
  overrideReflectionText?: string;
  promptsDir?: string;
}): Promise<string> {
  const {
    router,
    profile,
    memoryDir,
    dateStr,
    now,
    handover,
    todaysEvents = [],
    overrideReflectionText,
    promptsDir = PROMPTS_DIR,
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
  const triplets = extractFeedbackTriplets(todaysEvents);
  const feedbackBlock = formatFeedbackTripletsForReflection(triplets);

  if (hotEntries.length === 0 && !feedbackBlock) {
    const quietReflection = `今日平淡无波澜，按时歇下。`;
    return appendColdReflectionEntry({
      memoryDir,
      dateStr,
      timeStr,
      reflectionText: quietReflection,
    });
  }

  const route = router.getRoute("frontstage");
  const bedtimePromptText = readPrompt("bedtime-reflection.md", promptsDir).text;
  const system = [
    `# 住户身份与自身标尺：${profile.name}`,
    profile.core_persona,
    ...(bedtimePromptText ? ["", bedtimePromptText] : []),
  ].join("\n");

  const userPromptParts = [
    `[今日白天随手记]\n${hotEntries.length > 0 ? hotEntries.map((e) => `- ${e}`).join("\n") : "（无）"}`,
  ];
  if (feedbackBlock) {
    userPromptParts.push(`[今日对话真实反馈原话链]\n${feedbackBlock}`);
  }
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
