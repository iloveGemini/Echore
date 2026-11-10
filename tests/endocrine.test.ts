import { describe, expect, test } from "bun:test";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { resolvePersonaProfile } from "../src/endocrine/archetypes.ts";
import { applyEndocrineCalibrationGates } from "../src/endocrine/evaluator.ts";
import {
  buildSubconsciousHandover,
  renderHandoverYaml,
} from "../src/endocrine/handover.ts";
import {
  createInitialHormoneState,
  isInBoredZone,
  isInMissingZone,
  stepHormones,
} from "../src/endocrine/hormones.ts";

describe("Endocrine Layer 1 & 2: Archetypes, Dual-Anchor Decay & Cold War Cap_ox", () => {
  test("L0/L1/L2 persona profile resolution supports single, blend, sliders and slot overrides", () => {
    const profile = resolvePersonaProfile({
      name: "Lin",
      core_persona: "清冷慢热的独立研究者",
      archetype: { cat_aloof: 0.7, clingy_sensitive: 0.3 },
      chronotype: "night_owl",
      sliders: {
        attachment_need: "high",
        defensiveness: "mid",
      },
      mood_action_slots: {
        when_bored_alone: "自己泡杯手冲咖啡翻旧期刊",
      },
    });

    expect(profile.dominant_archetype).toBe("cat_aloof");
    expect(profile.resting_floor.oxytocin).toBeLessThan(profile.baseline.oxytocin);
    expect(profile.resting_floor.dopamine).toBeLessThan(profile.baseline.dopamine);
    expect(profile.mood_action_slots.when_bored_alone).toBe(
      "自己泡杯手冲咖啡翻旧期刊",
    );
  });

  test("Dual-anchor decay allows Oxytocin & Dopamine to fall below B_h toward F_h (missing & bored zones)", () => {
    const clock = new VirtualClock("2026-11-10T10:00:00.000Z");
    const profile = resolvePersonaProfile({
      name: "Momo",
      core_persona: "阳光直球",
      archetype: "dog_sunny",
      chronotype: "regular",
    });

    let state = createInitialHormoneState(profile, clock.now());
    expect(state.oxytocin).toBe(profile.baseline.oxytocin);
    expect(state.dopamine).toBe(profile.baseline.dopamine);

    // Advance 12 hours with zero input -> dopamine (T_1/2 = 6h) and oxytocin (T_1/2 = 32h) decay toward F_h < B_h
    clock.advanceHours(12);
    state = stepHormones({
      state,
      profile,
      now: clock.now(),
    });

    expect(state.dopamine).toBeLessThan(profile.baseline.dopamine);
    expect(state.dopamine).toBeGreaterThanOrEqual(profile.resting_floor.dopamine);
    expect(isInBoredZone(state, profile)).toBe(true);

    expect(state.oxytocin).toBeLessThan(profile.baseline.oxytocin);
    expect(state.oxytocin).toBeGreaterThanOrEqual(profile.resting_floor.oxytocin);
    expect(isInMissingZone(state, profile)).toBe(true);
  });

  test("T2 Cold War (`僵持待解`) enforces Cap_ox = B_ox - 0.15 ceiling across 15 days", () => {
    const clock = new VirtualClock("2026-11-10T12:00:00.000Z");
    const profile = resolvePersonaProfile({
      name: "Nana",
      core_persona: "傲娇猫系",
      archetype: "cat_aloof", // B_ox = 0.45, F_ox = 0.25
      chronotype: "regular",
    });

    const initialState = {
      ...createInitialHormoneState(profile, clock.now()),
      oxytocin: 0.45,
    };

    const stalemateConcern = {
      id: "con-weekend-flaked",
      tier: "conflict" as const,
      status: "僵持待解" as const,
      summary: "四天前周末临时爽约且态度敷衍，至今未正面解释",
      source_event_id: "log-20261106-1900-001",
      created_at: "2026-11-06T19:00:00.000Z",
      updated_at: "2026-11-10T12:00:00.000Z",
      floor_cort: 0.25,
      cap_ox: 0.30, // B_ox (0.45) - 0.15 = 0.30
      has_prep: false,
    };

    clock.advanceDays(10);
    const stepped = stepHormones({
      state: initialState,
      profile,
      now: clock.now(),
      activeConcerns: [stalemateConcern],
    });

    // Cap_ox locks oxytocin at <= 0.30 (well below B_ox = 0.45)
    expect(stepped.cap_ox).toBeCloseTo(0.30, 3);
    expect(stepped.oxytocin).toBeLessThanOrEqual(0.30);
  });
});

describe("Endocrine Layer 3: Four Pre-Release Calibration Gates & Handover", () => {
  test("Gate 1 (rapport banter & T3 scar 2x) + Gate 2 (ambiguity hold < 0.75) + Gate 3 (no orphan spike) + Gate 4 (intraday fast relief)", () => {
    const clock = new VirtualClock("2026-11-10T15:00:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const profile = resolvePersonaProfile({
      name: "Cat",
      core_persona: "傲娇猫系",
      archetype: "cat_aloof",
      chronotype: "regular",
    });

    const rapportMd = `---
id: imp-rapport
type: 内隐默契
date: 2026-11-10
status: 有效
category: preference
allow_forget: false
---
## 专属称呼与黑话
- 互损("笨蛋铲屎官", "两人日常亲昵互怼口头禅，绝非真生气") [src: log-20261101-1000-001]
## 结痂雷区
- 雷区([[people/self]]#爽约敏感, "曾因临时爽约冷战十天，再遇爽约皮质醇敏感度翻倍") [src: log-20261102-1000-001]
`;

    const evt1 = db.appendEventLog({
      id: "log-20261110-1500-001",
      role: "user",
      speaker: "user",
      content: "笨蛋铲屎官今天又来找你啦",
    });

    const baseHormones = createInitialHormoneState(profile, clock.now());

    // 1. Gate 1: Rapport banter filter blocks false conflict
    const out1 = applyEndocrineCalibrationGates(
      {
        userMessage: evt1.content,
        sourceEventId: evt1.id,
        rapportContent: rapportMd,
        hormoneState: baseHormones,
        profile,
        activeConcerns: [],
        now: clock.now(),
        rawPulse: {
          event_summary: "互怼打招呼",
          confidence: 0.85,
          is_conflict: true,
          is_reconciliation: false,
          is_warm: false,
          is_novel: false,
          matched_rapport_joke: false,
          cortisol_delta: 0.25,
          oxytocin_delta: 0,
          dopamine_delta: 0,
          reconciled_concern_ids: [],
        },
      },
      db,
    );
    expect(out1.appliedGates.gate1RapportMatchedBanter).toBe(true);
    expect(out1.appliedGates.gate3OrphanSpikeBlocked).toBe(false);
    expect(out1.hormoneState.cortisol).toBe(baseHormones.cortisol);

    // 2. Gate 2: Ambiguity hold when confidence < 0.75
    const evt2 = db.appendEventLog({
      id: "log-20261110-1505-002",
      role: "user",
      speaker: "user",
      content: "行吧，那你忙你的去吧。",
    });
    const out2 = applyEndocrineCalibrationGates(
      {
        userMessage: evt2.content,
        sourceEventId: evt2.id,
        rapportContent: rapportMd,
        hormoneState: baseHormones,
        profile,
        activeConcerns: [],
        now: clock.now(),
        rawPulse: {
          event_summary: "语气似嗔似笑拿不准",
          confidence: 0.55,
          is_conflict: true,
          is_reconciliation: false,
          is_warm: false,
          is_novel: false,
          matched_rapport_joke: false,
          cortisol_delta: 0.30,
          oxytocin_delta: -0.1,
          dopamine_delta: 0,
          new_concern: {
            tier: "conflict",
            summary: "疑似赌气",
          },
          reconciled_concern_ids: [],
        },
      },
      db,
    );
    expect(out2.appliedGates.gate2AmbiguityHold).toBe(true);
    expect(out2.appliedGates.gate3OrphanSpikeBlocked).toBe(false);
    expect(out2.hormoneState.cortisol).toBe(baseHormones.cortisol);
    expect(out2.activeConcerns.length).toBe(0);
    expect(out2.ambiguityProbeHint).toContain("摸不准");

    // 3. Gate 1 Scar 2x multiplier on real conflict hitting scar keyword "爽约"
    const evt3 = db.appendEventLog({
      id: "log-20261110-1510-003",
      role: "user",
      speaker: "user",
      content: "今晚我又要临时爽约不去了，别问了",
    });
    const out3 = applyEndocrineCalibrationGates(
      {
        userMessage: evt3.content,
        sourceEventId: evt3.id,
        rapportContent: rapportMd,
        hormoneState: baseHormones,
        profile,
        activeConcerns: [],
        now: clock.now(),
        rawPulse: {
          event_summary: "对方再次临时爽约且敷衍",
          confidence: 0.95,
          is_conflict: true,
          is_reconciliation: false,
          is_warm: false,
          is_novel: false,
          matched_rapport_joke: false,
          cortisol_delta: 0.20,
          oxytocin_delta: -0.10,
          dopamine_delta: 0,
          new_concern: {
            id: "con-scar-hit",
            tier: "conflict",
            summary: "再次临时爽约且拒绝沟通",
          },
          reconciled_concern_ids: [],
        },
      },
      db,
    );
    expect(out3.appliedGates.gate1ScarMultiplierApplied).toBe(true);
    // 0.20 + 0.20 * 1.3 (cat_aloof alpha_cort) * 2.0 (scar multiplier) = 0.72
    expect(out3.hormoneState.cortisol).toBeCloseTo(0.72, 2);
    expect(out3.activeConcerns.length).toBe(1);

    // 4. Handover generation has pre-hydrated quote and zero internal leaks
    const handover = buildSubconsciousHandover({
      hormoneState: out3.hormoneState,
      profile,
      activeConcerns: out3.activeConcerns,
      db,
      now: clock.now(),
    });
    const yaml = renderHandoverYaml(handover);
    expect(yaml).toContain("今晚我又要临时爽约不去了");
    expect(yaml).not.toMatch(/log-\d+/);

    // 5. Gate 4: Intraday Fast Relief when user sincerely apologizes & reconciles
    const evt4 = db.appendEventLog({
      id: "log-20261110-1530-004",
      role: "user",
      speaker: "user",
      content: "对不起，刚才是我太急躁了，我推掉应酬马上过来陪你，别生气了好不好",
    });
    const out4 = applyEndocrineCalibrationGates(
      {
        userMessage: evt4.content,
        sourceEventId: evt4.id,
        rapportContent: rapportMd,
        hormoneState: out3.hormoneState,
        profile,
        activeConcerns: out3.activeConcerns,
        now: clock.now(),
        rawPulse: {
          event_summary: "真诚道歉并推掉应酬赶来陪伴",
          confidence: 0.95,
          is_conflict: false,
          is_reconciliation: true,
          is_warm: true,
          is_novel: false,
          matched_rapport_joke: false,
          cortisol_delta: 0,
          oxytocin_delta: 0.10,
          dopamine_delta: 0.05,
          reconciled_concern_ids: ["con-scar-hit"],
        },
      },
      db,
    );
    expect(out4.appliedGates.gate4IntradayFastRelief).toBe(true);
    expect(out4.activeConcerns.length).toBe(0);
    expect(out4.hormoneState.cortisol).toBeLessThanOrEqual(
      profile.baseline.cortisol + 0.14,
    ); // Residual cortisol settled below defensive threshold (+0.15) when all concerns resolved

    db.close();
  });
});
