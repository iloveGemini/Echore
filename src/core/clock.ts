export interface Clock {
  now(): Date;
  nowMs(): number;
  nowIso(): string;
  todayStr(): string;
  formatLogId(seq?: number): string;
  advanceMs(ms: number): void;
  advanceMinutes(minutes: number): void;
  advanceHours(hours: number): void;
  advanceDays(days: number): void;
  setNow(target: Date | string | number): void;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * 将 Date 或 ISO 时间戳统一转换为引擎本地日历日 `YYYY-MM-DD`。
 * 若输入已是纯 `YYYY-MM-DD` 日历串，则原样返回（避免被 JS Date 解析为 UTC 零点产生跨时区偏移）。
 */
export function formatLocalDateStr(dateOrIso: Date | string): string {
  if (typeof dateOrIso === "string") {
    const trimmed = dateOrIso.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return trimmed.slice(0, 10);
    }
    return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
  }
  return `${dateOrIso.getFullYear()}-${pad2(dateOrIso.getMonth() + 1)}-${pad2(dateOrIso.getDate())}`;
}

/**
 * 提取引擎本地时刻 `HH:MM`
 */
export function formatLocalTimeHm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 按引擎本地日历日计算两个时间点（或 `YYYY-MM-DD` 日历串）之间跨越的自然日天数
 */
export function localCalendarDaysBetween(
  startIsoOrDate: Date | string,
  endIsoOrDate: Date | string,
): number {
  const startYmd = formatLocalDateStr(startIsoOrDate);
  const endYmd = formatLocalDateStr(endIsoOrDate);
  const startMs = Date.parse(`${startYmd}T00:00:00Z`);
  const endMs = Date.parse(`${endYmd}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((endMs - startMs) / (24 * 3600 * 1000)));
}

const WEEKDAY_LABELS = [
  "周日",
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
] as const;

export function getTimeOfDaySlot(hour: number): string {
  if (hour < 5) return "凌晨";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "晚上";
  return "深夜";
}

/**
 * Wave 2 回想时刻自然粗化（吸收自 Psyche `traces.md` §3.2）：
 * - 今天：今天凌晨 / 早上 / 上午 / 中午 / 下午 / 傍晚 / 晚上 / 深夜（纯日期则返回“今天”）
 * - 昨天、前天：昨天深夜、前天下午
 * - 7 天内：MM-DD（周X）晚上
 * - 更早：YYYY-MM-DD
 */
export function formatVagueWhen(
  eventIsoOrDate: Date | string,
  now: Date,
): string {
  if (typeof eventIsoOrDate === "string") {
    const trimmed = eventIsoOrDate.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const daysAgo = localCalendarDaysBetween(trimmed, now);
      if (daysAgo === 0) return "今天";
      if (daysAgo === 1) return "昨天";
      if (daysAgo === 2) return "前天";
      if (daysAgo <= 7) {
        const [y, m, d] = trimmed.split("-").map(Number);
        if (y && m && d) {
          const localDt = new Date(y, m - 1, d);
          return `${pad2(m)}-${pad2(d)}（${WEEKDAY_LABELS[localDt.getDay()]}）`;
        }
      }
      return trimmed;
    }
  }

  const d =
    typeof eventIsoOrDate === "string"
      ? new Date(eventIsoOrDate)
      : eventIsoOrDate;
  if (Number.isNaN(d.getTime())) {
    return String(eventIsoOrDate).slice(0, 10);
  }

  const slot = getTimeOfDaySlot(d.getHours());
  const daysAgo = localCalendarDaysBetween(d, now);
  if (daysAgo === 0) return `今天${slot}`;
  if (daysAgo === 1) return `昨天${slot}`;
  if (daysAgo === 2) return `前天${slot}`;
  if (daysAgo <= 7) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}（${WEEKDAY_LABELS[d.getDay()]}）${slot}`;
  }
  return formatLocalDateStr(d);
}

/**
 * Wave 2 相邻事件停顿体感提示（吸收自 Psyche `traces.md` §3.2b）：
 * - < 10 分钟：null（连续对话）
 * - 10–30 分钟：（过了一会儿）
 * - 30–60 分钟：（过了半个多小时）
 * - >= 60 分钟：（隔了约 N 小时）
 * - >= 24 小时：（隔了约 N 天）
 */
export function formatGapHint(deltaMs: number): string | null {
  if (!Number.isFinite(deltaMs) || deltaMs < 10 * 60_000) {
    return null;
  }
  if (deltaMs < 30 * 60_000) {
    return "（过了一会儿）";
  }
  if (deltaMs < 60 * 60_000) {
    return "（过了半个多小时）";
  }
  if (deltaMs < 24 * 3_600_000) {
    const hours = Math.max(1, Math.round(deltaMs / 3_600_000));
    return `（隔了约 ${hours} 小时）`;
  }
  const days = Math.max(1, Math.round(deltaMs / 86_400_000));
  return `（隔了约 ${days} 天）`;
}

export class VirtualClock implements Clock {
  private fixedTimeMs: number | null;
  private offsetMs = 0;
  private seqCounter = 0;

  constructor(initialTime?: Date | string | number) {
    if (initialTime !== undefined) {
      this.fixedTimeMs = new Date(initialTime).getTime();
    } else {
      this.fixedTimeMs = null;
    }
  }

  nowMs(): number {
    if (this.fixedTimeMs !== null) {
      return this.fixedTimeMs;
    }
    return Date.now() + this.offsetMs;
  }

  now(): Date {
    return new Date(this.nowMs());
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  todayStr(): string {
    return formatLocalDateStr(this.now());
  }

  formatLogId(seq?: number): string {
    const d = this.now();
    const ymd = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    const hm = `${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    const s = seq !== undefined ? seq : ++this.seqCounter;
    return `log-${ymd}-${hm}-${pad3(s % 1000)}`;
  }

  advanceMs(ms: number): void {
    if (this.fixedTimeMs !== null) {
      this.fixedTimeMs += ms;
    } else {
      this.offsetMs += ms;
    }
  }

  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60 * 1000);
  }

  advanceHours(hours: number): void {
    this.advanceMs(hours * 3600 * 1000);
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 24 * 3600 * 1000);
  }

  setNow(target: Date | string | number): void {
    this.fixedTimeMs = new Date(target).getTime();
  }
}
