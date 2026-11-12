import { z } from "zod";

export const ArchetypeIdSchema = z.enum([
  "dog_sunny",
  "cat_aloof",
  "cool_detached",
  "clingy_sensitive",
  "steady_anchor",
]);
export type ArchetypeId = z.infer<typeof ArchetypeIdSchema>;

export const ChronotypeIdSchema = z.enum([
  "early_bird",
  "regular",
  "night_owl",
]);
export type ChronotypeId = z.infer<typeof ChronotypeIdSchema>;

export const SliderLevelSchema = z.enum(["low", "mid", "high"]);
export type SliderLevel = z.infer<typeof SliderLevelSchema>;

export const MoodActionSlotsSchema = z.object({
  when_hurt_or_tense: z.string().min(1),
  when_missing_user: z.string().min(1),
  when_bored_alone: z.string().min(1),
  when_warm_excited: z.string().min(1),
});
export type MoodActionSlots = z.infer<typeof MoodActionSlotsSchema>;

export const PersonaSlidersSchema = z.object({
  attachment_need: SliderLevelSchema.optional(),
  defensiveness: SliderLevelSchema.optional(),
  solitude_tolerance: SliderLevelSchema.optional(),
});
export type PersonaSliders = z.infer<typeof PersonaSlidersSchema>;

export const ArchetypeBlendSchema = z.record(
  ArchetypeIdSchema,
  z.number().min(0).max(1),
);

export const PersonaConfigSchema = z.object({
  name: z.string().default("Echore"),
  core_persona: z
    .string()
    .default(
      "你是一个拥有独立生活节律、真实情绪惯性与第一人称主权的陪伴住户。只用第一人称“我”说话，绝不冒充没有根据的虚假体验，也绝不暴露任何系统参数。",
    ),
  archetype: z.union([ArchetypeIdSchema, ArchetypeBlendSchema]),
  chronotype: ChronotypeIdSchema.default("regular"),
  sliders: PersonaSlidersSchema.optional(),
  mood_action_slots: MoodActionSlotsSchema.partial().optional(),
});
export type PersonaConfig = z.input<typeof PersonaConfigSchema>;

export const HormoneStateSchema = z.object({
  cortisol: z.number().min(0).max(1),
  oxytocin: z.number().min(0).max(1),
  dopamine: z.number().min(0).max(1),
  melatonin: z.number().min(0).max(1),
  floor_cort: z.number().min(0).max(1),
  cap_ox: z.number().min(0).max(1),
  updated_at: z.string(),
});
export type HormoneState = z.infer<typeof HormoneStateSchema>;

export const ReflexStateSchema = z.object({
  consecutive_unanswered_proactive: z.number().int().min(0),
  last_proactive_at: z.string().nullable(),
  last_user_message_at: z.string().nullable(),
  proactive_lock: z.boolean(),
});
export type ReflexState = z.infer<typeof ReflexStateSchema>;

export const ConcernTierSchema = z.enum(["minor_worry", "conflict", "scar"]);
export type ConcernTier = z.infer<typeof ConcernTierSchema>;

export const MemoryStatusSchema = z.enum([
  "有效",
  "已取代",
  "已沉底",
  "已淡化",
  "僵持待解",
  "已落定",
  "已结痂",
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryTypeSchema = z.enum([
  "符号定义",
  "状态变更",
  "事件记录",
  "牵挂注",
  "内隐默契",
]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryCategorySchema = z.enum([
  "chat",
  "schedule",
  "life_event",
  "solitary",
  "preference",
  "health",
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

export const MemoryFrontmatterSchema = z.object({
  id: z.string().min(1),
  type: MemoryTypeSchema,
  tier: z.union([ConcernTierSchema, z.literal("normal")]).optional(),
  date: z.union([z.string(), z.date()]).transform((val) => {
    if (val instanceof Date) {
      return val.toISOString().slice(0, 10);
    }
    return String(val).slice(0, 10);
  }),
  status: MemoryStatusSchema,
  supersedes: z.string().optional(),
  source_event_id: z.string().optional(),
  category: MemoryCategorySchema,
  allow_forget: z.boolean().default(true),
});
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

export const ConcernRecordSchema = z.object({
  id: z.string().min(1),
  tier: ConcernTierSchema,
  status: MemoryStatusSchema,
  summary: z.string().min(1),
  source_event_id: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  floor_cort: z.number().min(0).max(1),
  cap_ox: z.number().min(0).max(1),
  has_prep: z.boolean().default(false),
});
export type ConcernRecord = z.infer<typeof ConcernRecordSchema>;

export const EventLogRecordSchema = z.object({
  id: z.string().regex(/^log-/),
  timestamp: z.string(),
  role: z.enum(["user", "assistant", "solitary", "system"]),
  speaker: z.string(),
  content: z.string(),
  metadata: z.record(z.unknown()).default({}),
});
export type EventLogRecord = z.infer<typeof EventLogRecordSchema>;

export const PulseEvaluationSchema = z.object({
  event_summary: z.string(),
  confidence: z.number().min(0).max(1),
  is_conflict: z.boolean().default(false),
  is_reconciliation: z.boolean().default(false),
  is_warm: z.boolean().default(false),
  is_novel: z.boolean().default(false),
  matched_rapport_joke: z.boolean().default(false),
  triggered_scar_zone: z.string().optional(),
  cortisol_delta: z.number().min(-1).max(1).default(0),
  oxytocin_delta: z.number().min(-1).max(1).default(0),
  dopamine_delta: z.number().min(-1).max(1).default(0),
  source_event_id: z.string().optional(),
  new_concern: z
    .object({
      id: z.string().optional(),
      tier: ConcernTierSchema,
      summary: z.string().min(1),
      floor_cort: z.number().min(0).max(1).optional(),
    })
    .optional(),
  reconciled_concern_ids: z.array(z.string()).default([]),
  ambiguity_probe_hint: z.string().optional(),
});
export type PulseEvaluation = z.infer<typeof PulseEvaluationSchema>;

export const SubconsciousHandoverItemSchema = z.object({
  牵挂: z.string().min(1),
  当时原话印象: z.string().min(1),
});
export type SubconsciousHandoverItem = z.infer<
  typeof SubconsciousHandoverItemSchema
>;

export const SubconsciousHandoverSchema = z.object({
  当下心境基调: z.string().min(1),
  身体节律感: z.string().min(1),
  脑子里盘旋的事: z.array(SubconsciousHandoverItemSchema).max(3),
});
export type SubconsciousHandover = z.infer<typeof SubconsciousHandoverSchema>;

export const ConcernVerdictActionSchema = z.enum([
  "keep_active",
  "settle_resolved",
  "fade_minor_worry",
  "escalate_cold_war",
  "crystallize_scar",
]);
export type ConcernVerdictAction = z.infer<typeof ConcernVerdictActionSchema>;

export const ScarRuleSpecSchema = z.object({
  slot_tag: z.string().min(1),
  description: z.string().min(1),
  source_event_id: z.string().regex(/^log-/),
});
export type ScarRuleSpec = z.infer<typeof ScarRuleSpecSchema>;

export const ConcernSettlementItemSchema = z.object({
  concern_id: z.string().min(1),
  action: ConcernVerdictActionSchema,
  previous_tier: ConcernTierSchema,
  next_tier: ConcernTierSchema,
  previous_status: MemoryStatusSchema,
  next_status: MemoryStatusSchema,
  summary: z.string().min(1),
  source_event_id: z.string().regex(/^log-/),
  created_at: z.string(),
  age_days: z.number().int().min(0),
  reason: z.string().min(1),
  scar_rule: ScarRuleSpecSchema.optional(),
});
export type ConcernSettlementItem = z.infer<typeof ConcernSettlementItemSchema>;

export const EndocrineNightVerdictSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(ConcernSettlementItemSchema),
  hormone_bounds_after: z.object({
    floor_cort: z.number().min(0).max(1),
    cap_ox: z.number().min(0).max(1),
  }),
});
export type EndocrineNightVerdict = z.infer<typeof EndocrineNightVerdictSchema>;

export const CompiledMemorySpecSchema = z.object({
  rel_path: z
    .string()
    .regex(/^(?:people|events|concerns)\/[a-zA-Z0-9_-]+\.md$/),
  id: z.string().min(1),
  type: MemoryTypeSchema,
  tier: z.union([ConcernTierSchema, z.literal("normal")]).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: MemoryStatusSchema,
  supersedes: z.string().optional(),
  source_event_id: z.string().optional(),
  category: MemoryCategorySchema,
  allow_forget: z.boolean().default(true),
  assertions: z.array(z.string().min(1)).min(1),
  frontstage_narrative: z.string().optional(),
});
export type CompiledMemorySpec = z.input<typeof CompiledMemorySpecSchema>;

export const RapportRuleSpecSchema = z.object({
  section: z.enum(["专属称呼与黑话", "语感与边界默契", "结痂雷区"]),
  predicate_line: z.string().min(1),
  source_event_id: z.string().regex(/^log-/),
  revises_rule_prefix: z.string().min(1).optional(),
});
export type RapportRuleSpec = z.infer<typeof RapportRuleSpecSchema>;

export const CompilationPlanSchema = z.object({
  memories: z.array(CompiledMemorySpecSchema).default([]),
  rapport_rules: z.array(RapportRuleSpecSchema).default([]),
});
export type CompilationPlan = z.input<typeof CompilationPlanSchema>;

export const WeatherConditionSchema = z.enum([
  "clear",
  "cloudy",
  "rain",
  "heavy_rain",
  "storm",
  "snow",
  "fog",
]);
export type WeatherCondition = z.infer<typeof WeatherConditionSchema>;

export const WeatherSnapshotSchema = z.object({
  condition: WeatherConditionSchema,
  temperatureC: z.number(),
  previousTemperatureC: z.number().optional(),
  alert: z.string().optional(),
});
export type WeatherSnapshot = z.infer<typeof WeatherSnapshotSchema>;

export const SolitaryActionKindSchema = z.enum([
  "feed_roaming",
  "hobby_project",
  "secret_prep",
]);
export type SolitaryActionKind = z.infer<typeof SolitaryActionKindSchema>;

export const SolitaryProjectNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["done", "in_progress", "pending"]),
  artifact_path: z.string().optional(),
  completed_at: z.string().optional(),
});
export type SolitaryProjectNode = z.infer<typeof SolitaryProjectNodeSchema>;

export const SolitaryProjectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  cursor: z.number().int().min(0).default(0),
  nodes: z.array(SolitaryProjectNodeSchema).min(1),
});
export type SolitaryProject = z.infer<typeof SolitaryProjectSchema>;

export const SolitaryProjectsFileSchema = z.object({
  projects: z.array(SolitaryProjectSchema),
});
export type SolitaryProjectsFile = z.infer<typeof SolitaryProjectsFileSchema>;

const LOG_ID_LEAK_RE = /\blog-\d{4,}[-\w]*\b/i;
const HORMONE_FLOAT_LEAK_RE =
  /\b(?:cortisol|oxytocin|dopamine|melatonin|floor_cort|cap_ox|H_cort|H_ox|H_da|B_cort|B_ox|B_da|F_cort|F_ox|F_da)\b[^\n\r]{0,12}?\d+\.\d+/i;
const RAW_FLOAT_DECIMAL_RE =
  /(?:皮质醇|催产素|多巴胺|褪黑素)[^\n\r]{0,10}?\d+\.\d+/;

/**
 * 铁律守卫：前台上下文严禁裸露激素浮点数或 `log-*` 数据库主键
 */
export function assertNoInternalLeaks(text: string, contextLabel = "frontstage"): void {
  if (LOG_ID_LEAK_RE.test(text)) {
    throw new Error(
      `[SovereigntyViolation:${contextLabel}] 检测到裸露的 log-* 数据库主键: ${text.match(LOG_ID_LEAK_RE)?.[0]}`,
    );
  }
  if (HORMONE_FLOAT_LEAK_RE.test(text) || RAW_FLOAT_DECIMAL_RE.test(text)) {
    throw new Error(
      `[SovereigntyViolation:${contextLabel}] 检测到裸露的激素浮点数指标`,
    );
  }
}
