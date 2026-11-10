import type { EchoreDatabase } from "../core/db.ts";
import { assertNoInternalLeaks } from "../core/schemas.ts";

/**
 * §4.1 预水合器（Pre-Hydrator）
 * 根据 source_event_id 从 SQLite Event Log 提取当时 1~2 句原始对话引文，
 * 格式化为自然语言印象并彻底剥离 `log-*` 数据库主键。
 */
export function preHydrateQuotes(
  db: EchoreDatabase,
  sourceEventIds: Array<string | undefined | null>,
): Map<string, string> {
  const result = new Map<string, string>();

  for (const rawId of sourceEventIds) {
    if (!rawId) continue;
    const id = rawId.trim();
    if (!id || result.has(id)) continue;

    const record = db.getEventLogById(id);
    if (!record) continue;

    const datePart = record.timestamp.slice(0, 10);
    const speakerLabel =
      record.role === "user"
        ? "他说"
        : record.role === "assistant"
          ? "我当时说"
          : "当时记录";

    // Sanitize any accidental log-* string inside content just in case
    const cleanContent = record.content
      .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);

    const formatted = `${datePart} ${speakerLabel}：“${cleanContent}”`;
    assertNoInternalLeaks(formatted, "preHydrateQuotes");
    result.set(id, formatted);
  }

  return result;
}
