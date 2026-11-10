import type {
  ChronotypeId,
  ConcernRecord,
  HormoneState,
} from "../core/schemas.ts";
import {
  CHRONOTYPE_SCHEDULES,
  getDecimalHour,
} from "../reflex/guard.ts";
import type { ResolvedEndocrineProfile } from "./archetypes.ts";

export function clip(value: number, min: number, max: number): number {
  const effectiveMax = Math.max(min, max);
  return Math.max(min, Math.min(effectiveMax, Number(value.toFixed(4))));
}

/**
 * §2.3 无外部刺激时的通用双锚点指数回归公式（纯程序计算）
 * H_raw(t + dt) = F_h + (H(t) - F_h) * 2^(-dt / T_1/2)
 * H(t + dt) = clip(H_raw(t + dt), Floor_active, Cap_active)
 */
export function decayHormone(params: {
  current: number;
  restingFloor: number;
  halfLifeHours: number;
  deltaHours: number;
  activeFloor?: number;
  activeCap?: number;
}): number {
  const {
    current,
    restingFloor,
    halfLifeHours,
    deltaHours,
    activeFloor = 0,
    activeCap = 1,
  } = params;

  if (deltaHours <= 0) {
    return clip(current, activeFloor, activeCap);
  }
  const decayFactor = Math.pow(2, -deltaHours / Math.max(0.1, halfLifeHours));
  const raw = restingFloor + (current - restingFloor) * decayFactor;
  return clip(raw, activeFloor, activeCap);
}

/**
 * §2.3 褪黑素 24h 余弦节律曲线
 * 在 sleepLockStartHour 达到 >= 0.75，睡眠中段（+3h）达到峰值 ~0.95，白天回落至 ~0.08
 */
export function computeMelatonin(
  now: Date,
  chronotype: ChronotypeId,
): number {
  const schedule = CHRONOTYPE_SCHEDULES[chronotype];
  const hour = getDecimalHour(now);
  // Peak melatonin is 3 hours after sleepLockStartHour
  const peakHour = (schedule.sleepLockStartHour + 3.0) % 24;
  let diff = Math.abs(hour - peakHour);
  if (diff > 12) diff = 24 - diff;

  // Cosine wave normalized to [0.05, 0.95], tuned so at diff = 3h (sleepLockStartHour) it's >= 0.75
  const radians = (diff / 12) * Math.PI;
  const cosine01 = (Math.cos(radians) + 1) / 2; // 1 at peak, 0 at trough, 0.8535 at diff=3h
  const val = 0.05 + 0.90 * cosine01; // at diff=3h -> 0.05 + 0.90 * 0.85355 = 0.818 >= 0.75
  return clip(val, 0, 1);
}

/**
 * 从当前活跃牵挂表计算聚合的皮质醇 Floor 与冷战期催产素天花板 Cap_ox
 * - T1 (minor_worry): 不锁皮质醇 Floor，不压 Cap_ox
 * - T2 (conflict) 有效(急性): 挂皮质醇 Floor (默认 max(B_cort + 0.22, concern.floor_cort))
 * - T2 (conflict) 僵持待解(冷战期 Day 5+): 皮质醇 Floor 缓降，但开启催产素封顶 Cap_ox = B_ox - 0.15
 */
export function computeActiveBounds(
  profile: ResolvedEndocrineProfile,
  activeConcerns: ConcernRecord[],
): { floorCort: number; capOx: number } {
  let floorCort = profile.resting_floor.cortisol;
  let capOx = 1.0;

  for (const concern of activeConcerns) {
    if (concern.tier === "conflict") {
      if (concern.status === "有效") {
        const acuteFloor =
          concern.floor_cort > 0
            ? concern.floor_cort
            : clip(profile.baseline.cortisol + 0.22, 0, 0.85);
        floorCort = Math.max(floorCort, acuteFloor);
        if (concern.cap_ox < 1.0) {
          capOx = Math.min(capOx, concern.cap_ox);
        }
      } else if (concern.status === "僵持待解") {
        const coldWarFloor = clip(profile.baseline.cortisol + 0.05, 0, 0.6);
        floorCort = Math.max(floorCort, coldWarFloor);
        const coldWarCap =
          concern.cap_ox < 1.0
            ? concern.cap_ox
            : clip(profile.baseline.oxytocin - 0.15, profile.resting_floor.oxytocin, 1.0);
        capOx = Math.min(capOx, coldWarCap);
      }
    }
  }

  return {
    floorCort: clip(floorCort, profile.resting_floor.cortisol, 0.95),
    capOx: clip(capOx, profile.resting_floor.oxytocin, 1.0),
  };
}

/**
 * 创建角色初始激素状态（位于舒适基线 B_h）
 */
export function createInitialHormoneState(
  profile: ResolvedEndocrineProfile,
  now: Date,
): HormoneState {
  return {
    cortisol: profile.baseline.cortisol,
    oxytocin: profile.baseline.oxytocin,
    dopamine: profile.baseline.dopamine,
    melatonin: computeMelatonin(now, profile.chronotype),
    floor_cort: profile.resting_floor.cortisol,
    cap_ox: 1.0,
    updated_at: now.toISOString(),
  };
}

/**
 * 推进 Δt 小时后的 4 激素状态
 */
export function stepHormones(params: {
  state: HormoneState;
  profile: ResolvedEndocrineProfile;
  now: Date;
  activeConcerns?: ConcernRecord[];
  overrideDeltaHours?: number;
}): HormoneState {
  const { state, profile, now, activeConcerns = [] } = params;
  const prevMs = new Date(state.updated_at).getTime();
  const deltaHours =
    params.overrideDeltaHours !== undefined
      ? params.overrideDeltaHours
      : Math.max(0, (now.getTime() - prevMs) / (3600 * 1000));

  const { floorCort, capOx } = computeActiveBounds(profile, activeConcerns);

  const cortisol = decayHormone({
    current: state.cortisol,
    restingFloor: profile.resting_floor.cortisol,
    halfLifeHours: profile.half_life_hours.cortisol,
    deltaHours,
    activeFloor: floorCort,
    activeCap: 1.0,
  });

  const oxytocin = decayHormone({
    current: state.oxytocin,
    restingFloor: profile.resting_floor.oxytocin,
    halfLifeHours: profile.half_life_hours.oxytocin,
    deltaHours,
    activeFloor: profile.resting_floor.oxytocin,
    activeCap: capOx,
  });

  const dopamine = decayHormone({
    current: state.dopamine,
    restingFloor: profile.resting_floor.dopamine,
    halfLifeHours: profile.half_life_hours.dopamine,
    deltaHours,
    activeFloor: profile.resting_floor.dopamine,
    activeCap: 1.0,
  });

  const melatonin = computeMelatonin(now, profile.chronotype);

  return {
    cortisol,
    oxytocin,
    dopamine,
    melatonin,
    floor_cort: floorCort,
    cap_ox: capOx,
    updated_at: now.toISOString(),
  };
}

/**
 * 独居生活回合完成后，内源性多巴胺恢复至舒适基线 B_da
 */
export function applySolitaryDopamineRestore(
  state: HormoneState,
  profile: ResolvedEndocrineProfile,
  now: Date,
): HormoneState {
  return {
    ...state,
    dopamine: Math.max(state.dopamine, profile.baseline.dopamine),
    updated_at: now.toISOString(),
  };
}

export function isDefensiveOrTense(
  state: HormoneState,
  profile: ResolvedEndocrineProfile,
): boolean {
  return (
    state.cortisol > profile.baseline.cortisol + 0.15 || state.cap_ox < 0.99
  );
}

export function isInMissingZone(
  state: HormoneState,
  profile: ResolvedEndocrineProfile,
): boolean {
  return (
    state.oxytocin < profile.baseline.oxytocin &&
    state.oxytocin >= profile.resting_floor.oxytocin
  );
}

export function isInBoredZone(
  state: HormoneState,
  profile: ResolvedEndocrineProfile,
): boolean {
  return (
    state.dopamine < profile.baseline.dopamine &&
    state.dopamine >= profile.resting_floor.dopamine
  );
}
