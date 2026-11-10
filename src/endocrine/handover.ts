import YAML from "yaml";
import type { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type ConcernRecord,
  type HormoneState,
  type SubconsciousHandover,
  SubconsciousHandoverSchema,
} from "../core/schemas.ts";
import { preHydrateQuotes } from "../hippocampus/pre-hydrator.ts";
import type { ResolvedEndocrineProfile } from "./archetypes.ts";
import {
  isDefensiveOrTense,
  isInBoredZone,
  isInMissingZone,
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
    hour < 6
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
      `${c.created_at.slice(0, 10)} 留下的话头，当时还没彻底聊透`,
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
