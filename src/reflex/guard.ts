import type { ChronotypeId, ReflexState } from "../core/schemas.ts";

export interface ChronotypeSchedule {
  id: ChronotypeId;
  melatoninRiseHour: number; // e.g. 23.0 for 23:00
  sleepLockStartHour: number; // e.g. 1.0 for 01:00, 23.5 for 23:30
  sleepLockEndHour: number; // e.g. 8.0 for 08:00
}

export const CHRONOTYPE_SCHEDULES: Record<ChronotypeId, ChronotypeSchedule> = {
  early_bird: {
    id: "early_bird",
    melatoninRiseHour: 22.0,
    sleepLockStartHour: 23.5,
    sleepLockEndHour: 6.5,
  },
  regular: {
    id: "regular",
    melatoninRiseHour: 23.0,
    sleepLockStartHour: 1.0,
    sleepLockEndHour: 8.0,
  },
  night_owl: {
    id: "night_owl",
    melatoninRiseHour: 0.5,
    sleepLockStartHour: 2.5,
    sleepLockEndHour: 9.5,
  },
};

export interface ReflexEvaluation {
  sleepLocked: boolean;
  inQuietHours: boolean;
  proactiveCooldownLocked: boolean;
  proactiveUnansweredLocked: boolean;
  canProactiveWake: boolean;
  reasons: string[];
}

export const PROACTIVE_COOLDOWN_MS = 24 * 3600 * 1000;
export const MELATONIN_SLEEP_THRESHOLD = 0.75;
export const MAX_UNANSWERED_PROACTIVE = 2;

export function isHourInWindow(
  currentHourDecimal: number,
  startHour: number,
  endHour: number,
): boolean {
  if (startHour <= endHour) {
    return currentHourDecimal >= startHour && currentHourDecimal < endHour;
  }
  // Crosses midnight (e.g. 23.5 -> 6.5)
  return currentHourDecimal >= startHour || currentHourDecimal < endHour;
}

export function getDecimalHour(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/**
 * 岗位 4：反射层纯确定性脊髓守卫（零 AI 调用）
 */
export function evaluateReflexGuard(params: {
  reflexState: ReflexState;
  melatonin: number;
  now: Date;
  chronotype: ChronotypeId;
}): ReflexEvaluation {
  const { reflexState, melatonin, now, chronotype } = params;
  const schedule = CHRONOTYPE_SCHEDULES[chronotype];
  const hour = getDecimalHour(now);
  const inQuietHours = isHourInWindow(
    hour,
    schedule.sleepLockStartHour,
    schedule.sleepLockEndHour,
  );
  const sleepLocked = melatonin >= MELATONIN_SLEEP_THRESHOLD || inQuietHours;

  let proactiveCooldownLocked = false;
  if (reflexState.last_proactive_at && reflexState.consecutive_unanswered_proactive > 0) {
    const elapsedMs = now.getTime() - new Date(reflexState.last_proactive_at).getTime();
    if (elapsedMs < PROACTIVE_COOLDOWN_MS) {
      proactiveCooldownLocked = true;
    }
  }

  const proactiveUnansweredLocked =
    reflexState.proactive_lock ||
    reflexState.consecutive_unanswered_proactive >= MAX_UNANSWERED_PROACTIVE;

  const reasons: string[] = [];
  if (sleepLocked) {
    reasons.push(
      melatonin >= MELATONIN_SLEEP_THRESHOLD
        ? "褪黑素高位睡眠锁已激活"
        : "处于作息静默睡眠窗口",
    );
  }
  if (proactiveCooldownLocked) {
    reasons.push("距离上次主动发起未满 24h 冷却窗");
  }
  if (proactiveUnansweredLocked) {
    reasons.push("连续 2 次主动发起未获回复，proactive_lock 退避锁已挂起");
  }

  return {
    sleepLocked,
    inQuietHours,
    proactiveCooldownLocked,
    proactiveUnansweredLocked,
    canProactiveWake:
      !sleepLocked && !proactiveCooldownLocked && !proactiveUnansweredLocked,
    reasons,
  };
}

/**
 * 记录一次主动破冰发送：连续未回计数 +1，满 2 次立即锁死 proactive_lock
 */
export function recordProactiveSent(
  state: ReflexState,
  nowIso: string,
): ReflexState {
  const nextCount = state.consecutive_unanswered_proactive + 1;
  return {
    ...state,
    consecutive_unanswered_proactive: nextCount,
    last_proactive_at: nowIso,
    proactive_lock: nextCount >= MAX_UNANSWERED_PROACTIVE ? true : state.proactive_lock,
  };
}

/**
 * 用户主动发来消息：立即重置未回计数与 proactive_lock 退避锁
 */
export function recordUserMessageReceived(
  state: ReflexState,
  nowIso: string,
): ReflexState {
  return {
    ...state,
    consecutive_unanswered_proactive: 0,
    last_user_message_at: nowIso,
    proactive_lock: false,
  };
}
