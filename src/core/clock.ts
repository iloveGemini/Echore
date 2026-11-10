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
    return this.nowIso().slice(0, 10);
  }

  formatLogId(seq?: number): string {
    const iso = this.nowIso();
    const ymd = iso.slice(0, 10).replace(/-/g, "");
    const hm = `${iso.slice(11, 13)}${iso.slice(14, 16)}`;
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
