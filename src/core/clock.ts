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
    const d = this.now();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
