import type { EchoreDatabase } from "../core/db.ts";
import {
  type ConcernRecord,
  type HormoneState,
  type PulseEvaluation,
  PulseEvaluationSchema,
} from "../core/schemas.ts";
import type { ResolvedEndocrineProfile } from "./archetypes.ts";
import { clip, computeActiveBounds } from "./hormones.ts";

export interface RapportParsedFilter {
  banterKeywords: string[];
  scarZones: Array<{
    tag: string;
    description: string;
    keywords: string[];
  }>;
}

/**
 * 解析 implicit/rapport.md 中的专属黑话/玩笑习惯与结痂雷区（T3 留疤）
 */
export function parseRapportFilter(rapportMarkdown: string): RapportParsedFilter {
  const banterKeywords: string[] = [];
  const scarZones: RapportParsedFilter["scarZones"] = [];

  const lines = rapportMarkdown.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;

    // Match - 暗号("加班搭子", "...") or - 互损(...) or - 偏恶(...)
    const banterMatch = line.match(
      /^-\s*(?:暗号|互损|玩笑|默契)\s*\(\s*"([^"]+)"/,
    );
    if (banterMatch?.[1]) {
      banterKeywords.push(banterMatch[1]);
    }

    // Match - 雷区([[people/self]]#爽约敏感, "曾在 11 月初因临时爽约...")
    const scarMatch = line.match(
      /^-\s*雷区\s*\(\s*\[\[[^\]]+\]\]#([^,\s]+)\s*,\s*"([^"]+)"\s*\)/,
    );
    if (scarMatch) {
      const tag = scarMatch[1]!.trim();
      const description = scarMatch[2]!.trim();
      const keywords = [
        tag.replace(/敏感$/, ""),
        ...description
          .split(/[，。、；\s]+/)
          .filter((w) => w.length >= 2 && w.length <= 6),
      ].filter(Boolean);
      scarZones.push({ tag, description, keywords });
    }
  }

  return { banterKeywords, scarZones };
}

export interface EndocrineEvaluationInput {
  userMessage: string;
  sourceEventId: string;
  rapportContent: string;
  hormoneState: HormoneState;
  profile: ResolvedEndocrineProfile;
  activeConcerns: ConcernRecord[];
  now: Date;
  rawPulse: PulseEvaluation;
  /** 若为记忆召回或单纯未回消息，触发防滚雪球锁 */
  isRecallOnly?: boolean;
  isSilenceOnly?: boolean;
}

export interface EndocrineTurnOutcome {
  hormoneState: HormoneState;
  activeConcerns: ConcernRecord[];
  appliedGates: {
    gate1RapportMatchedBanter: boolean;
    gate1ScarMultiplierApplied: boolean;
    gate2AmbiguityHold: boolean;
    gate3OrphanSpikeBlocked: boolean;
    gate4IntradayFastRelief: boolean;
  };
  ambiguityProbeHint?: string;
  fastReliefApplied: boolean;
}

export const AMBIGUITY_CONFIDENCE_THRESHOLD = 0.75;
export const DEFAULT_AMBIGUITY_HINT =
  "有点摸不准他刚才那句是开玩笑还是认真的，顺着话头轻轻试探一下";

/**
 * §2.5 情绪官「出厂前四道调准」+ 肝脏日内实时快代谢
 * 1. 第一道门：强制挂载 implicit/rapport.md 默契滤网（识别互损玩笑防误判；触碰 T3 结痂雷区皮质醇敏感度 2.0x）
 * 2. 第二道门：模糊语境「悬置阻尼（Ambiguity Hold）」（confidence < 0.75 严禁飙皮质醇或立 T2 冲突）
 * 3. 第三道门：因果同源铁律（No Orphan Spike + Recall 零增益锁 + 单纯未回消息 != 冲突）
 * 4. 第四道门：日内实时快代谢（Intraday Fast Relief：和解当轮立即解除 Floor_cort 与 Cap_ox，并当场消退 60%~85% 残余压力）
 */
export function applyEndocrineCalibrationGates(
  input: EndocrineEvaluationInput,
  db?: EchoreDatabase,
): EndocrineTurnOutcome {
  const pulse = PulseEvaluationSchema.parse(input.rawPulse);
  const rapportFilter = parseRapportFilter(input.rapportContent);
  const nowIso = input.now.toISOString();

  let cortisolDelta = pulse.cortisol_delta;
  let oxytocinDelta = pulse.oxytocin_delta;
  let dopamineDelta = pulse.dopamine_delta;
  let newConcernSpec = pulse.new_concern;

  let gate1RapportMatchedBanter = false;
  let gate1ScarMultiplierApplied = false;
  let gate2AmbiguityHold = false;
  let gate3OrphanSpikeBlocked = false;
  let gate4IntradayFastRelief = false;
  let ambiguityProbeHint: string | undefined;

  // --- 防滚雪球铁律：Recall 零增益 & 单纯未回消息 != 冲突 ---
  if (input.isRecallOnly || input.isSilenceOnly) {
    if (cortisolDelta > 0 || pulse.is_conflict || newConcernSpec) {
      cortisolDelta = 0;
      newConcernSpec = undefined;
      gate3OrphanSpikeBlocked = true;
    }
  }

  // --- 第一道门：implicit/rapport.md 默契滤网 & T3 结痂雷区 ---
  const hitBanterKeyword = rapportFilter.banterKeywords.some(
    (kw) => kw && input.userMessage.includes(kw),
  );
  if (pulse.matched_rapport_joke || (hitBanterKeyword && pulse.is_conflict)) {
    gate1RapportMatchedBanter = true;
    cortisolDelta = 0;
    newConcernSpec = undefined;
    oxytocinDelta = Math.max(oxytocinDelta, 0.04);
  }

  const hitScar =
    pulse.triggered_scar_zone !== undefined ||
    rapportFilter.scarZones.some((sz) =>
      sz.keywords.some((kw) => kw && input.userMessage.includes(kw)),
    );
  if (hitScar && (pulse.is_conflict || cortisolDelta > 0)) {
    gate1ScarMultiplierApplied = true;
  }

  // --- 第二道门：模糊语境「悬置阻尼（Ambiguity Hold）」 ---
  if (
    !gate1RapportMatchedBanter &&
    (pulse.is_conflict || cortisolDelta > 0 || newConcernSpec?.tier === "conflict") &&
    pulse.confidence < AMBIGUITY_CONFIDENCE_THRESHOLD
  ) {
    gate2AmbiguityHold = true;
    cortisolDelta = 0;
    oxytocinDelta = 0;
    newConcernSpec = undefined;
    ambiguityProbeHint = pulse.ambiguity_probe_hint || DEFAULT_AMBIGUITY_HINT;
  }

  // --- 第三道门：因果同源铁律（No Orphan Spike） ---
  if (cortisolDelta > 0 || pulse.is_conflict || newConcernSpec) {
    const effectiveSourceId = pulse.source_event_id || input.sourceEventId;
    const hasValidEventInDb = db
      ? Boolean(effectiveSourceId && db.getEventLogById(effectiveSourceId))
      : Boolean(effectiveSourceId && effectiveSourceId.startsWith("log-"));
    const hasReason =
      Boolean(pulse.event_summary.trim()) ||
      Boolean(newConcernSpec?.summary?.trim());

    // 显著负向脉冲若给不出合法事由与原文指针，或者负向冲突未关联具体牵挂事由，直接按噪声归零
    if (!hasValidEventInDb || !hasReason || (cortisolDelta > 0.1 && !newConcernSpec && input.activeConcerns.length === 0)) {
      gate3OrphanSpikeBlocked = true;
      cortisolDelta = 0;
      newConcernSpec = undefined;
    }
  }

  // --- 第四道门：日内实时快代谢（Intraday Fast Relief） ---
  const updatedConcerns: ConcernRecord[] = input.activeConcerns.map((c) => ({
    ...c,
  }));

  if (pulse.is_reconciliation && updatedConcerns.length > 0) {
    const targetIds =
      pulse.reconciled_concern_ids.length > 0
        ? new Set(pulse.reconciled_concern_ids)
        : new Set(updatedConcerns.map((c) => c.id));

    for (const c of updatedConcerns) {
      if (targetIds.has(c.id) && (c.status === "有效" || c.status === "僵持待解")) {
        c.status = "已落定";
        c.floor_cort = 0;
        c.cap_ox = 1.0;
        c.updated_at = nowIso;
        gate4IntradayFastRelief = true;
        if (db) {
          db.upsertConcern(c);
        }
      }
    }
  }

  // 如新建牵挂注，写入状态表
  if (newConcernSpec && !gate2AmbiguityHold && !gate3OrphanSpikeBlocked) {
    const concernId =
      newConcernSpec.id ??
      `con-${nowIso.slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
    const defaultFloor =
      newConcernSpec.tier === "conflict"
        ? clip(input.profile.baseline.cortisol + 0.22, 0, 0.85)
        : 0;
    const created: ConcernRecord = {
      id: concernId,
      tier: newConcernSpec.tier,
      status: "有效",
      summary: newConcernSpec.summary,
      source_event_id: pulse.source_event_id || input.sourceEventId,
      created_at: nowIso,
      updated_at: nowIso,
      floor_cort: newConcernSpec.floor_cort ?? defaultFloor,
      cap_ox: 1.0,
      has_prep: false,
    };
    updatedConcerns.unshift(created);
    if (db) {
      db.upsertConcern(created);
    }
  }

  const stillActiveConcerns = updatedConcerns.filter(
    (c) => c.status === "有效" || c.status === "僵持待解",
  );
  const { floorCort, capOx } = computeActiveBounds(
    input.profile,
    stillActiveConcerns,
  );

  // 计算激素脉冲与快代谢
  let nextCortisol = input.hormoneState.cortisol;
  let nextOxytocin = input.hormoneState.oxytocin;
  let nextDopamine = input.hormoneState.dopamine;

  if (gate4IntradayFastRelief) {
    const excessCort = Math.max(
      0,
      nextCortisol - input.profile.baseline.cortisol,
    );
    const reliefRatio = input.profile.fast_relief_ratio; // 0.65 ~ 0.85
    nextCortisol =
      input.profile.baseline.cortisol + excessCort * (1 - reliefRatio);
    nextOxytocin = Math.max(nextOxytocin, input.profile.baseline.oxytocin);
  }

  if (cortisolDelta !== 0) {
    const scarFactor = gate1ScarMultiplierApplied ? 2.0 : 1.0;
    const scaledDelta =
      cortisolDelta > 0
        ? cortisolDelta * input.profile.sensitivity.cortisol * scarFactor
        : cortisolDelta;
    nextCortisol += scaledDelta;
  }

  if (oxytocinDelta !== 0) {
    const scaledOx =
      oxytocinDelta > 0
        ? oxytocinDelta * input.profile.sensitivity.oxytocin
        : oxytocinDelta;
    nextOxytocin += scaledOx;
  }

  if (dopamineDelta !== 0) {
    const scaledDa =
      dopamineDelta > 0
        ? dopamineDelta * input.profile.sensitivity.dopamine
        : dopamineDelta;
    nextDopamine += scaledDa;
  }

  const nextState: HormoneState = {
    cortisol: clip(nextCortisol, floorCort, 1.0),
    oxytocin: clip(
      nextOxytocin,
      input.profile.resting_floor.oxytocin,
      capOx,
    ),
    dopamine: clip(
      nextDopamine,
      input.profile.resting_floor.dopamine,
      1.0,
    ),
    melatonin: input.hormoneState.melatonin,
    floor_cort: floorCort,
    cap_ox: capOx,
    updated_at: nowIso,
  };

  if (db) {
    db.saveHormoneState(nextState);
  }

  return {
    hormoneState: nextState,
    activeConcerns: stillActiveConcerns,
    appliedGates: {
      gate1RapportMatchedBanter,
      gate1ScarMultiplierApplied,
      gate2AmbiguityHold,
      gate3OrphanSpikeBlocked,
      gate4IntradayFastRelief,
    },
    ambiguityProbeHint,
    fastReliefApplied: gate4IntradayFastRelief,
  };
}
