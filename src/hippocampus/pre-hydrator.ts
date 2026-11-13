import { formatGapHint, formatVagueWhen } from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type EventLogRecord,
} from "../core/schemas.ts";

export function formatEventSpeakerForRecall(
  record: EventLogRecord,
  variant: "past" | "flow" = "past",
): string | null {
  const producer =
    record.producer ??
    (record.role === "user"
      ? "user"
      : record.role === "assistant"
        ? "resident"
        : record.role === "solitary"
          ? "solitary"
          : "system");

  if (producer === "system") {
    return null;
  }

  const importPrefix = record.source === "import" ? "（搬家前）" : "";
  switch (producer) {
    case "user":
      return `${importPrefix}他说`;
    case "resident":
      return `${importPrefix}${variant === "past" ? "我当时说" : "我说"}`;
    case "peer":
      return `${importPrefix}${record.speaker || "同伴"}${variant === "past" ? "当时说" : "说"}`;
    case "external":
      return `${importPrefix}（外部对话记录）`;
    case "solitary":
      return `${importPrefix}${variant === "past" ? "当时记录" : "独居记事"}`;
    default:
      return null;
  }
}

/**
 * §4.1 预水合器（Pre-Hydrator）
 * 根据 source_event_id 从 SQLite Event Log 提取当时 1~2 句原始对话引文，
 * 格式化为带模糊时间体感（vagueWhen）的自然语言印象并彻底剥离 `log-*` 数据库主键。
 */
export function preHydrateQuotes(
  db: EchoreDatabase,
  sourceEventIds: Array<string | undefined | null>,
  now?: Date,
): Map<string, string> {
  const result = new Map<string, string>();

  for (const rawId of sourceEventIds) {
    if (!rawId) continue;
    const id = rawId.trim();
    if (!id || result.has(id)) continue;

    const record = db.getEventLogById(id, { activeOnly: true });
    if (!record) continue;

    const speakerLabel = formatEventSpeakerForRecall(record, "past");
    if (!speakerLabel) continue;

    // 回想只给大概：有 now 就只给模糊时间，不并列精确日期（与 recall.ts 的渲染规则一致）
    const timePrefix = now
      ? formatVagueWhen(record.timestamp, now)
      : record.timestamp.slice(0, 10);

    // Sanitize any accidental log-* string inside content just in case
    const cleanContent = record.content
      .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);

    const formatted = `${timePrefix} ${speakerLabel}：“${cleanContent}”`;
    assertNoInternalLeaks(formatted, "preHydrateQuotes");
    result.set(id, formatted);
  }

  return result;
}

/**
 * Wave 2 按时间序渲染事件流并自动插入模糊时段分组标题与相邻停顿体感提示（gapHint）
 */
export function formatEventFlowWithGapHints(
  records: readonly EventLogRecord[],
  now: Date,
): string[] {
  const lines: string[] = [];
  let currentHeader: string | null = null;
  let prevMs: number | null = null;

  for (const rec of records) {
    if (rec.status && rec.status !== "active") continue;
    const speakerLabel = formatEventSpeakerForRecall(rec, "flow");
    if (!speakerLabel) continue;

    const recMs = Date.parse(rec.timestamp);
    if (prevMs !== null && Number.isFinite(recMs)) {
      const gap = formatGapHint(recMs - prevMs);
      if (gap) {
        lines.push(gap);
      }
    }

    const header = formatVagueWhen(rec.timestamp, now);
    if (header !== currentHeader) {
      currentHeader = header;
      lines.push(`── ${header} ──`);
    }

    const cleanContent = rec.content
      .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    const line = `${speakerLabel}：“${cleanContent}”`;
    assertNoInternalLeaks(line, "formatEventFlowWithGapHints");
    lines.push(line);

    if (Number.isFinite(recMs)) {
      prevMs = recMs;
    }
  }

  return lines;
}
