import YAML from "yaml";
import {
  formatLocalDateStr,
  localCalendarDaysBetween,
} from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type ConcernRecord,
  type ConcernSettlementItem,
  type EndocrineNightVerdict,
  EndocrineNightVerdictSchema,
  type HormoneState,
  type SubconsciousHandover,
  SubconsciousHandoverSchema,
} from "../core/schemas.ts";
import { preHydrateQuotes } from "../hippocampus/pre-hydrator.ts";
import type { ResolvedEndocrineProfile } from "./archetypes.ts";
import {
  clip,
  computeActiveBounds,
  isDefensiveOrTense,
  isInBoredZone,
  isInMissingZone,
  stepHormones,
} from "./hormones.ts";

export interface BuildHandoverParams {
  hormoneState: HormoneState;
  profile: ResolvedEndocrineProfile;
  activeConcerns: ConcernRecord[];
  db: EchoreDatabase;
  now: Date;
  ambiguityProbeHint?: string;
  fastReliefApplied?: boolean;
  recentSolitaryNote?: string;
}

function describeCircadianFeel(
  now: Date,
  melatonin: number,
  recentSolitaryNote?: string,
): string {
  const hour = now.getHours();
  const timePeriod =
    melatonin >= 0.75
      ? "深夜入睡前"
      : hour < 6
        ? "凌晨时分"
        : hour < 11
          ? "上午"
          : hour < 14
            ? "中午"
            : hour < 18
              ? "下午"
              : hour < 22
                ? "晚上"
                : "深夜";

  const energyFeel =
    melatonin >= 0.75
      ? "困意已经很浓了，眼皮发沉，随时准备睡下"
      : melatonin >= 0.55
        ? "稍微有点犯困，节奏慢了下来"
        : "精神还不错";

  if (recentSolitaryNote) {
    return `现在是${timePeriod}，${energyFeel}，${recentSolitaryNote}`;
  }
  return `现在是${timePeriod}，${energyFeel}`;
}

/**
 * §2.6 生成情绪官 → 前台《潜意识心境交接单》
 * 铁律：零浮点数、零 `log-*` 数据库主键、任何负向基调必须 1:1 附带事由与预水合原话引文
 */
export function buildSubconsciousHandover(
  params: BuildHandoverParams,
): SubconsciousHandover {
  const {
    hormoneState,
    profile,
    activeConcerns,
    db,
    now,
    ambiguityProbeHint,
    fastReliefApplied,
    recentSolitaryNote,
  } = params;

  const topConcerns = activeConcerns.slice(0, 3);
  const quoteMap = preHydrateQuotes(
    db,
    topConcerns.map((c) => c.source_event_id),
  );

  const 脑子里盘旋的事 = topConcerns.map((c) => ({
    牵挂: c.summary.replace(/\blog-\d{4,}[-\w]*\b/gi, "").trim(),
    当时原话印象:
      quoteMap.get(c.source_event_id) ??
      `${formatLocalDateStr(c.created_at)} 留下的话头，当时还没彻底聊透`,
  }));

  let 当下心境基调: string;

  if (ambiguityProbeHint) {
    当下心境基调 = ambiguityProbeHint;
  } else if (fastReliefApplied) {
    当下心境基调 = `刚才他把话说开了，心里堵着的那口气顺了不少，语气自然缓和下来（${profile.mood_action_slots.when_warm_excited}）`;
  } else if (
    isDefensiveOrTense(hormoneState, profile) &&
    脑子里盘旋的事.length > 0
  ) {
    const hasStalemate = topConcerns.some((c) => c.status === "僵持待解");
    if (hasStalemate) {
      当下心境基调 = `前几天闹僵的那件事还没真正说开，现在对他客气里带着点疏离，除非他主动提那件事给个台阶，否则不想假装无事发生（${profile.mood_action_slots.when_hurt_or_tense}）`;
    } else {
      当下心境基调 = `心里还挂着刚才那点不痛快，说话带着点防御和分寸（${profile.mood_action_slots.when_hurt_or_tense}）`;
    }
  } else if (isInMissingZone(hormoneState, profile)) {
    当下心境基调 = `有一阵子没好好聊了，心里有点惦记他（${profile.mood_action_slots.when_missing_user}）`;
  } else if (isInBoredZone(hormoneState, profile)) {
    当下心境基调 = `手头有点闲，正想找点有意思的事打发时间（${profile.mood_action_slots.when_bored_alone}）`;
  } else if (hormoneState.oxytocin >= profile.baseline.oxytocin + 0.08) {
    当下心境基调 = `相处氛围很暖，心情轻快放松（${profile.mood_action_slots.when_warm_excited}）`;
  } else {
    当下心境基调 = `心境平稳自然，带着平时的相处节奏（${profile.mood_action_slots.when_warm_excited}）`;
  }

  const 身体节律感 = describeCircadianFeel(
    now,
    hormoneState.melatonin,
    recentSolitaryNote,
  );

  const handover = SubconsciousHandoverSchema.parse({
    当下心境基调,
    身体节律感,
    脑子里盘旋的事,
  });

  const yamlText = renderHandoverYaml(handover);
  assertNoInternalLeaks(yamlText, "SubconsciousHandover");

  return handover;
}

export function renderHandoverYaml(handover: SubconsciousHandover): string {
  const rendered = YAML.stringify(handover).trim();
  assertNoInternalLeaks(rendered, "renderHandoverYaml");
  return rendered;
}

function computeConcernAgeDays(createdAtIso: string, now: Date): number {
  return localCalendarDaysBetween(createdAtIso, now);
}

function deriveScarSlotTag(summary: string): string {
  const cjkMatches = summary.match(/[一-龥]{2,6}/g);
  const core = cjkMatches?.[0] ?? "过往冲突";
  return core.endsWith("敏感") ? core : `${core}敏感`;
}

/**
 * §1.2 夜相 Step 2 & §2.4：情绪官夜间肝脏结算，出具《情绪结转裁决单》
 * 铁律：情绪官只更新 SQLite 状态表并输出结构化裁决单，绝不直接写 Markdown 文件。
 * - 日内已快代谢和解 (`status === "已落定"`) -> `settle_resolved`
 * - T1 (`minor_worry`) 满 7 天仍为 `有效` -> `fade_minor_worry` (`status: 已淡化`)
 * - T2 (`conflict`) 满 5 天仍为 `有效(急性)` -> `escalate_cold_war` (`status: 僵持待解`, 开启 Cap_ox = B_ox - 0.15)
 * - T2 (`conflict`) 满 21 天未解 -> `crystallize_scar` (`tier: scar`, `status: 已结痂`, 释放日常 Cap_ox 并附 `scar_rule`)
 */
export function settleNightlyConcerns(params: {
  db: EchoreDatabase;
  profile: ResolvedEndocrineProfile;
  now: Date;
}): EndocrineNightVerdict {
  const { db, profile, now } = params;
  const nowIso = now.toISOString();
  const dateStr = formatLocalDateStr(now);

  const allConcerns = db.listAllConcerns();
  const unsettledResolvedIds = new Set(
    db.listUnsettledResolvedConcerns().map((c) => c.id),
  );
  const items: ConcernSettlementItem[] = [];

  for (const c of allConcerns) {
    const ageDays = computeConcernAgeDays(c.created_at, now);

    if (c.status === "已落定") {
      if (!unsettledResolvedIds.has(c.id)) {
        continue;
      }
      db.markConcernNightlySettled(c.id, nowIso);
      items.push({
        concern_id: c.id,
        action: "settle_resolved",
        previous_tier: c.tier,
        next_tier: c.tier,
        previous_status: "已落定",
        next_status: "已落定",
        summary: c.summary,
        source_event_id: c.source_event_id,
        created_at: c.created_at,
        age_days: ageDays,
        reason: "日内已说开并完成快代谢，夜间正式结转落定",
      });
      continue;
    }

    if (c.status !== "有效" && c.status !== "僵持待解") {
      continue;
    }

    if (c.tier === "minor_worry") {
      if (ageDays >= 7) {
        const updated: ConcernRecord = {
          ...c,
          status: "已淡化",
          floor_cort: 0,
          cap_ox: 1.0,
          updated_at: nowIso,
        };
        db.upsertConcern(updated);
        items.push({
          concern_id: c.id,
          action: "fade_minor_worry",
          previous_tier: "minor_worry",
          next_tier: "minor_worry",
          previous_status: c.status,
          next_status: "已淡化",
          summary: c.summary,
          source_event_id: c.source_event_id,
          created_at: c.created_at,
          age_days: ageDays,
          reason: `T1 日常微澜已满 ${ageDays} 天自然翻篇，归档为已淡化`,
        });
      } else {
        items.push({
          concern_id: c.id,
          action: "keep_active",
          previous_tier: "minor_worry",
          next_tier: "minor_worry",
          previous_status: c.status,
          next_status: "有效",
          summary: c.summary,
          source_event_id: c.source_event_id,
          created_at: c.created_at,
          age_days: ageDays,
          reason: `T1 日常微澜未满 7 天（当前 ${ageDays} 天），保持有效惦记`,
        });
      }
      continue;
    }

    if (c.tier === "conflict") {
      if (ageDays >= 21) {
        const updated: ConcernRecord = {
          ...c,
          tier: "scar",
          status: "已结痂",
          floor_cort: 0,
          cap_ox: 1.0,
          updated_at: nowIso,
        };
        db.upsertConcern(updated);

        const slotTag = deriveScarSlotTag(c.summary);
        items.push({
          concern_id: c.id,
          action: "crystallize_scar",
          previous_tier: "conflict",
          next_tier: "scar",
          previous_status: c.status,
          next_status: "已结痂",
          summary: c.summary,
          source_event_id: c.source_event_id,
          created_at: c.created_at,
          age_days: ageDays,
          reason: `T2 冲突已僵持 ${ageDays} 天未解，结转为 T3 已结痂并写入内隐雷区`,
          scar_rule: {
            slot_tag: slotTag,
            description: `曾在 ${formatLocalDateStr(c.created_at)} 因「${c.summary}」长期未解留疤，再遇同类触发皮质醇敏感度翻倍`,
            source_event_id: c.source_event_id,
          },
        });
      } else if (c.status === "有效" && ageDays >= 5) {
        const coldWarFloor = clip(profile.baseline.cortisol + 0.05, 0, 0.6);
        const coldWarCap = clip(
          profile.baseline.oxytocin - 0.15,
          profile.resting_floor.oxytocin,
          1.0,
        );
        const updated: ConcernRecord = {
          ...c,
          status: "僵持待解",
          floor_cort: coldWarFloor,
          cap_ox: coldWarCap,
          updated_at: nowIso,
        };
        db.upsertConcern(updated);
        items.push({
          concern_id: c.id,
          action: "escalate_cold_war",
          previous_tier: "conflict",
          next_tier: "conflict",
          previous_status: "有效",
          next_status: "僵持待解",
          summary: c.summary,
          source_event_id: c.source_event_id,
          created_at: c.created_at,
          age_days: ageDays,
          reason: `T2 冲突已满 ${ageDays} 天未解，由急性期转为僵持待解（开启冷战催产素封顶 Cap_ox）`,
        });
      } else {
        items.push({
          concern_id: c.id,
          action: "keep_active",
          previous_tier: "conflict",
          next_tier: "conflict",
          previous_status: c.status,
          next_status: c.status,
          summary: c.summary,
          source_event_id: c.source_event_id,
          created_at: c.created_at,
          age_days: ageDays,
          reason:
            c.status === "有效"
              ? `T2 冲突处于急性应激期（${ageDays} 天 < 5 天）`
              : `T2 冲突处于冷战僵持期（${ageDays} 天 < 21 天）`,
        });
      }
      continue;
    }

    items.push({
      concern_id: c.id,
      action: "keep_active",
      previous_tier: c.tier,
      next_tier: c.tier,
      previous_status: c.status,
      next_status: c.status,
      summary: c.summary,
      source_event_id: c.source_event_id,
      created_at: c.created_at,
      age_days: ageDays,
      reason: "保持当前状态",
    });
  }

  const remainingActive = db.listActiveConcerns();
  const { floorCort, capOx } = computeActiveBounds(profile, remainingActive);
  const updatedHormones = stepHormones({
    state: db.getHormoneState(),
    profile,
    now,
    activeConcerns: remainingActive,
    overrideDeltaHours: 0,
  });
  db.saveHormoneState(updatedHormones);

  return EndocrineNightVerdictSchema.parse({
    date: dateStr,
    items,
    hormone_bounds_after: {
      floor_cort: floorCort,
      cap_ox: capOx,
    },
  });
}
