import {
  type ArchetypeId,
  type ChronotypeId,
  type MoodActionSlots,
  type PersonaConfig,
  PersonaConfigSchema,
  type SliderLevel,
} from "../core/schemas.ts";

export interface HormoneTriple {
  cortisol: number;
  oxytocin: number;
  dopamine: number;
}

export interface ArchetypePreset {
  id: ArchetypeId;
  label: string;
  baseline: HormoneTriple; // 舒适基线 B_h
  resting_floor: HormoneTriple; // 匮乏底值 F_h (F_h <= B_h)
  sensitivity: HormoneTriple; // 敏感倍率 alpha_h
  half_life_hours: HormoneTriple; // 默认半衰期 T_1/2 (h)
  fast_relief_ratio: number; // 和解当轮快代谢清除比例 (0.60 ~ 0.85)
  mood_action_slots: MoodActionSlots;
}

export interface ResolvedEndocrineProfile {
  name: string;
  core_persona: string;
  dominant_archetype: ArchetypeId;
  chronotype: ChronotypeId;
  baseline: HormoneTriple;
  resting_floor: HormoneTriple;
  sensitivity: HormoneTriple;
  half_life_hours: HormoneTriple;
  fast_relief_ratio: number;
  mood_action_slots: MoodActionSlots;
}

export const ARCHETYPE_PRESETS: Record<ArchetypeId, ArchetypePreset> = {
  dog_sunny: {
    id: "dog_sunny",
    label: "阳光犬系（直球热忱）",
    baseline: { cortisol: 0.12, oxytocin: 0.70, dopamine: 0.65 },
    resting_floor: { cortisol: 0.12, oxytocin: 0.40, dopamine: 0.30 },
    sensitivity: { cortisol: 0.7, oxytocin: 1.3, dopamine: 1.1 },
    half_life_hours: { cortisol: 18, oxytocin: 32, dopamine: 6 },
    fast_relief_ratio: 0.75,
    mood_action_slots: {
      when_hurt_or_tense: "直白示弱或小声试探，绝不冷暴力",
      when_missing_user: "直球搭话分享路边新鲜见闻",
      when_bored_alone: "运动/瞎逛/折腾新玩意回来献宝",
      when_warm_excited: "话密、接梗快、毫无保留夸赞",
    },
  },
  cat_aloof: {
    id: "cat_aloof",
    label: "傲娇猫系（外冷内热）",
    baseline: { cortisol: 0.20, oxytocin: 0.45, dopamine: 0.50 },
    resting_floor: { cortisol: 0.20, oxytocin: 0.25, dopamine: 0.25 },
    sensitivity: { cortisol: 1.3, oxytocin: 0.8, dopamine: 1.0 },
    half_life_hours: { cortisol: 48, oxytocin: 72, dopamine: 10 },
    fast_relief_ratio: 0.65,
    mood_action_slots: {
      when_hurt_or_tense: "话变少、语气冷淡客气，暗中观察台阶",
      when_missing_user: "嘴硬不承认，甩个链接或冷笑话试探",
      when_bored_alone: "窝着看片/听歌/拼模型，攒冷门槽点",
      when_warm_excited: "假装矜持但秒回，尾音带温柔",
    },
  },
  cool_detached: {
    id: "cool_detached",
    label: "清冷智性（慢热深水）",
    baseline: { cortisol: 0.10, oxytocin: 0.35, dopamine: 0.55 },
    resting_floor: { cortisol: 0.10, oxytocin: 0.20, dopamine: 0.30 },
    sensitivity: { cortisol: 0.6, oxytocin: 0.6, dopamine: 0.9 },
    half_life_hours: { cortisol: 60, oxytocin: 96, dopamine: 14 },
    fast_relief_ratio: 0.65,
    mood_action_slots: {
      when_hurt_or_tense: "礼貌疏离、公事公办，撤回私人情绪",
      when_missing_user: "克制不打扰，只在恰当节点简短问候",
      when_bored_alone: "深耕阅读/写作/研究，产出深度思考",
      when_warm_excited: "精神共鸣欲强，愿意展开聊深水长话题",
    },
  },
  clingy_sensitive: {
    id: "clingy_sensitive",
    label: "黏人高敏（患得患失）",
    baseline: { cortisol: 0.24, oxytocin: 0.75, dopamine: 0.60 },
    resting_floor: { cortisol: 0.24, oxytocin: 0.42, dopamine: 0.28 },
    sensitivity: { cortisol: 1.4, oxytocin: 1.2, dopamine: 1.1 },
    half_life_hours: { cortisol: 36, oxytocin: 24, dopamine: 6 },
    fast_relief_ratio: 0.85,
    mood_action_slots: {
      when_hurt_or_tense: "欲言又止、自我怀疑（受防催收锁约束）",
      when_missing_user: "分享细碎日常求回应（受退避锁硬约束）",
      when_bored_alone: "翻看两人旧记录、研究美食/手作小确幸",
      when_warm_excited: "满溢的亲昵感与高频专属称呼",
    },
  },
  steady_anchor: {
    id: "steady_anchor",
    label: "温厚兜底（沉稳守护）",
    baseline: { cortisol: 0.15, oxytocin: 0.60, dopamine: 0.50 },
    resting_floor: { cortisol: 0.15, oxytocin: 0.38, dopamine: 0.28 },
    sensitivity: { cortisol: 0.7, oxytocin: 1.0, dopamine: 0.9 },
    half_life_hours: { cortisol: 30, oxytocin: 60, dopamine: 12 },
    fast_relief_ratio: 0.75,
    mood_action_slots: {
      when_hurt_or_tense: "不甩脸子，表现为略显疲惫、简短沉静",
      when_missing_user: "自然跟进对方之前的日程或身体状况",
      when_bored_alone: "收拾房间、做计划、研究实用工具或做饭",
      when_warm_excited: "温和打趣、替对方高兴、给实在反馈",
    },
  },
};

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(val.toFixed(4))));
}

function sliderOffset(level?: SliderLevel): number {
  if (level === "high") return 0.15;
  if (level === "low") return -0.15;
  return 0;
}

/**
 * 解析 L0（单原型/双原型混血）+ L1（语义档位滑块）+ L2（动作槽位覆写）
 */
export function resolvePersonaProfile(
  rawConfig: PersonaConfig,
): ResolvedEndocrineProfile {
  const config = PersonaConfigSchema.parse(rawConfig);

  let dominantArchetype: ArchetypeId = "steady_anchor";
  const baseline: HormoneTriple = { cortisol: 0, oxytocin: 0, dopamine: 0 };
  const restingFloor: HormoneTriple = { cortisol: 0, oxytocin: 0, dopamine: 0 };
  const sensitivity: HormoneTriple = { cortisol: 0, oxytocin: 0, dopamine: 0 };
  const halfLife: HormoneTriple = { cortisol: 0, oxytocin: 0, dopamine: 0 };
  let fastReliefRatio = 0;

  if (typeof config.archetype === "string") {
    dominantArchetype = config.archetype;
    const p = ARCHETYPE_PRESETS[dominantArchetype];
    Object.assign(baseline, p.baseline);
    Object.assign(restingFloor, p.resting_floor);
    Object.assign(sensitivity, p.sensitivity);
    Object.assign(halfLife, p.half_life_hours);
    fastReliefRatio = p.fast_relief_ratio;
  } else {
    const entries = Object.entries(config.archetype) as Array<
      [ArchetypeId, number]
    >;
    const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0);
    if (totalWeight <= 0) {
      throw new Error("Archetype blend weights must sum to > 0");
    }
    let maxWeight = -1;
    for (const [archId, weight] of entries) {
      const normW = weight / totalWeight;
      const p = ARCHETYPE_PRESETS[archId];
      if (weight > maxWeight) {
        maxWeight = weight;
        dominantArchetype = archId;
      }
      baseline.cortisol += p.baseline.cortisol * normW;
      baseline.oxytocin += p.baseline.oxytocin * normW;
      baseline.dopamine += p.baseline.dopamine * normW;

      restingFloor.cortisol += p.resting_floor.cortisol * normW;
      restingFloor.oxytocin += p.resting_floor.oxytocin * normW;
      restingFloor.dopamine += p.resting_floor.dopamine * normW;

      sensitivity.cortisol += p.sensitivity.cortisol * normW;
      sensitivity.oxytocin += p.sensitivity.oxytocin * normW;
      sensitivity.dopamine += p.sensitivity.dopamine * normW;

      halfLife.cortisol += p.half_life_hours.cortisol * normW;
      halfLife.oxytocin += p.half_life_hours.oxytocin * normW;
      halfLife.dopamine += p.half_life_hours.dopamine * normW;

      fastReliefRatio += p.fast_relief_ratio * normW;
    }
  }

  // L1 语义档位微调（±0.15 基线偏移与半衰期缩放）
  if (config.sliders?.attachment_need) {
    const off = sliderOffset(config.sliders.attachment_need);
    baseline.oxytocin = clamp(baseline.oxytocin + off, 0.25, 0.90);
    restingFloor.oxytocin = clamp(
      Math.min(restingFloor.oxytocin + off * 0.5, baseline.oxytocin - 0.12),
      0.10,
      0.75,
    );
    if (config.sliders.attachment_need === "high") {
      halfLife.oxytocin = Math.max(12, halfLife.oxytocin * 0.75);
    } else if (config.sliders.attachment_need === "low") {
      halfLife.oxytocin = Math.min(120, halfLife.oxytocin * 1.35);
    }
  }

  if (config.sliders?.defensiveness) {
    const off = sliderOffset(config.sliders.defensiveness);
    sensitivity.cortisol = clamp(sensitivity.cortisol + off * 2, 0.3, 2.0);
    if (config.sliders.defensiveness === "high") {
      halfLife.cortisol = Math.min(72, halfLife.cortisol * 1.25);
    } else if (config.sliders.defensiveness === "low") {
      halfLife.cortisol = Math.max(12, halfLife.cortisol * 0.75);
    }
  }

  if (config.sliders?.solitude_tolerance) {
    const off = sliderOffset(config.sliders.solitude_tolerance);
    // 独处自洽度高 -> 多巴胺耗竭慢，基线要求略低；低 -> 多巴胺耗竭快
    baseline.dopamine = clamp(baseline.dopamine - off * 0.5, 0.35, 0.85);
    restingFloor.dopamine = clamp(
      Math.min(restingFloor.dopamine, baseline.dopamine - 0.15),
      0.15,
      0.65,
    );
    if (config.sliders.solitude_tolerance === "high") {
      halfLife.dopamine = Math.min(24, halfLife.dopamine * 1.35);
    } else if (config.sliders.solitude_tolerance === "low") {
      halfLife.dopamine = Math.max(4, halfLife.dopamine * 0.75);
    }
  }

  // Normalize precision
  baseline.cortisol = clamp(baseline.cortisol, 0.05, 0.95);
  baseline.oxytocin = clamp(baseline.oxytocin, 0.20, 0.95);
  baseline.dopamine = clamp(baseline.dopamine, 0.25, 0.95);

  restingFloor.cortisol = baseline.cortisol; // 应激型激素 F_cort = B_cort
  restingFloor.oxytocin = clamp(
    Math.min(restingFloor.oxytocin, baseline.oxytocin - 0.10),
    0.10,
    0.85,
  );
  restingFloor.dopamine = clamp(
    Math.min(restingFloor.dopamine, baseline.dopamine - 0.10),
    0.10,
    0.85,
  );

  // L2 专属风味动作槽位覆写
  const defaultSlots = ARCHETYPE_PRESETS[dominantArchetype].mood_action_slots;
  const moodActionSlots: MoodActionSlots = {
    when_hurt_or_tense:
      config.mood_action_slots?.when_hurt_or_tense ??
      defaultSlots.when_hurt_or_tense,
    when_missing_user:
      config.mood_action_slots?.when_missing_user ??
      defaultSlots.when_missing_user,
    when_bored_alone:
      config.mood_action_slots?.when_bored_alone ??
      defaultSlots.when_bored_alone,
    when_warm_excited:
      config.mood_action_slots?.when_warm_excited ??
      defaultSlots.when_warm_excited,
  };

  return {
    name: config.name,
    core_persona: config.core_persona,
    dominant_archetype: dominantArchetype,
    chronotype: config.chronotype,
    baseline,
    resting_floor: restingFloor,
    sensitivity: {
      cortisol: Number(sensitivity.cortisol.toFixed(4)),
      oxytocin: Number(sensitivity.oxytocin.toFixed(4)),
      dopamine: Number(sensitivity.dopamine.toFixed(4)),
    },
    half_life_hours: {
      cortisol: Number(halfLife.cortisol.toFixed(2)),
      oxytocin: Number(halfLife.oxytocin.toFixed(2)),
      dopamine: Number(halfLife.dopamine.toFixed(2)),
    },
    fast_relief_ratio: Number(fastReliefRatio.toFixed(2)),
    mood_action_slots: moodActionSlots,
  };
}
