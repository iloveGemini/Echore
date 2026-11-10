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
