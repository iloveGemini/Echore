import fs from "node:fs";
import path from "node:path";
import { assertNoInternalLeaks } from "../core/schemas.ts";

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
