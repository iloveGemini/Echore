# M2 接口与模块契约（夜间冷闭环 + 记忆唯一编译器）

> 状态：M2 生效契约（2026-11-10）
> 依据：[`notes/design/architecture-and-memory-spec.md`](../design/architecture-and-memory-spec.md) §1.2, §2.4–§2.5, §3.3–§3.5, §4.2–§4.4, §5, §6.4, §7.1

---

## 1. 范围与可观察验收标准

M2 聚焦跑通 **【环 3：昼夜新陈代谢环 Circadian Sleep Loop】** 及其唯一编译、衰减归档与 L1–L6 守卫：

1. **前台睡前自省冷叙事 (`src/frontstage/journal.ts`)**：
   - 入夜汇总当日 `journal/YYYY-MM-DD.md` 中的白天交互与独居热记事，由前台（唯一拥有第一人称“我”的传主）生成当日睡前自省冷叙事并写回 `journal/YYYY-MM-DD.md`。
   - 严守第一人称主权与 `assertNoInternalLeaks`（零激素浮点数、零 `log-*` 主键）。
2. **情绪官夜间肝脏结算 (`src/endocrine/handover.ts`)**：
   - 扫描 SQLite `concerns` 表，出具结构化《情绪结转裁决单》（`EndocrineNightVerdict`）：
     - **日内已和解落定**：白天经第四道门快代谢标为 `已落定` 的牵挂，出具 `settle_resolved` 裁决；
     - **T1 日常微澜 (`minor_worry`) 满 7 天淡化**：满 7 天仍为 `有效` 的 T1 牵挂，转为 `status: 已淡化`（`fade_minor_worry`）；
     - **T2 实质冲突 (`conflict`) 满 5 天转冷战封顶**：急性期（`status: 有效`）满 5 天未解，转为 `status: 僵持待解`（`escalate_cold_war`），皮质醇 Floor 缓降，同时启用催产素天花板封顶 $\text{Cap}_{\text{ox}} = B_{\text{ox}} - 0.15$；
     - **T2 僵持满 21 天转 T3 留疤 (`scar`)**：冷战僵持满 21 天仍未解，转为 `status: 已结痂`、`tier: scar`（`crystallize_scar`），释放日常短期 $\text{Cap}_{\text{ox}}$ 封顶，并生成 `scar_rule` 交由记忆官写入 `implicit/rapport.md`。
   - 铁律：情绪官只写 SQLite 状态表并出具裁决单，**绝不直接写 Markdown 文件**。
3. **记忆官夜间唯一编译器 (`src/hippocampus/compiler.ts`)**：
   - 作为 `memory/` 下所有结构化 `.md` 文件（`people/`、`events/`、`concerns/`、`implicit/rapport.md`）的唯一执笔编译器；
   - 读取前台日记（提取第一人称原叙）、当日 SQLite `event_log` 与《情绪结转裁决单》；
   - 编译新增/更新 `events/*.md`、`concerns/*.md`、`people/*.md`，维护 `supersedes` 取代链（自动将旧断言文件 `status` 更新为 `已取代`，并同步更新活跃文件的共时引用）；
   - 将新增默契黑话与 T3 结痂雷区追加至 `implicit/rapport.md`（每条强制带 `[src: log-xxx]` 行级溯源，且 `allow_forget: false`）；
   - **铁律**：编译出的断言文件 `## 前台原叙` 必须保留前台第一人称叙事原肉，绝不替前台捏造心理活动。
4. **分品类定步长衰减、正向再巩固与沉底门 (`src/hippocampus/decay.ts`)**：
   - 新编译记忆默认初始强度 `strength_0 = 0.75`（`allow_forget: false` 钉子记忆初设为 `0.90`）；
   - 分品类周期 $T_{\text{cat}}$：`chat(7d)`、`schedule(14d)`、`solitary(14d)`、`life_event(30d)`、`health(30d)`、`preference(90d)`；
   - 定步长指数衰减：$\text{effective\_half\_days} = T_{\text{cat}} \cdot (1 + 0.5 \cdot \text{access\_count})$，$\text{daily\_retention} = (0.12 / 0.75)^{1 / \text{effective\_half\_days}}$；
   - 正向再巩固：正向/事实记忆被召回并采用时 `strength = min(1.0, strength + 0.05)`；负面事件与未落定牵挂注被召回时只增 `access_count`，绝不上调 `strength`；
   - 归档门：`allow_forget: true` 且 `days_since_last_access >= T_cat` 且 `strength <= 0.12` 时，将文件 YAML 头与 `memory_meta` 的 `status` 由 `有效` 改为 `已沉底`（严禁物理删档）。
5. **环 3 总控串联 (`src/loop/engine.ts` · `EchoreEngine.runSleepCycle()`)**：
   - 完整串联 Step 1（前台睡前冷叙事）→ Step 2（情绪官肝脏结算）→ Step 3（记忆官唯一编译 + L1–L6 自愈校验）→ Step 4（定步长衰减归档 + L1–L6 终检 + 记忆仓自动 `git commit`）。
   - **全仓时间语义铁律**：昼夜作息节律、日记日期（`clock.todayStr()`）、牵挂年龄（`age_days`）、记忆衰减未访问天数（`days_since_last_access`）与 L6 超期审计一律统一采用**引擎本地日历日**（`formatLocalDateStr` + `localCalendarDaysBetween`），严禁混用本地时刻与 UTC 日期切片（`toISOString().slice(0, 10)`）。

---

## 2. 模块接口契约

### 2.1 `src/core/schemas.ts`（新增夜间契约）
- `ConcernVerdictActionSchema`:
  `'keep_active' | 'settle_resolved' | 'fade_minor_worry' | 'escalate_cold_war' | 'crystallize_scar'`
- `ConcernSettlementItemSchema`:
  ```ts
  {
    concern_id: string;
    action: ConcernVerdictAction;
    previous_tier: ConcernTier;
    next_tier: ConcernTier;
    previous_status: MemoryStatus;
    next_status: MemoryStatus;
    summary: string;
    source_event_id: string;
    age_days: number;
    reason: string;
    scar_rule?: {
      slot_tag: string;
      description: string;
      source_event_id: string;
    };
  }
  ```
- `EndocrineNightVerdictSchema`:
  ```ts
  {
    date: string;
    items: ConcernSettlementItem[];
    hormone_bounds_after: {
      floor_cort: number;
      cap_ox: number;
    };
  }
  ```
- `CompiledMemorySpecSchema` / `CompilationPlanSchema`：约束记忆官编译输出的断言结构、取代目标与 `rapport.md` 增量规则。

### 2.2 `src/frontstage/journal.ts`
- `extractHotEntriesForDate(memoryDir: string, dateStr: string): string[]`
- `extractColdReflectionForDate(memoryDir: string, dateStr: string): string | null`
- `appendColdReflectionEntry(input: { memoryDir: string; dateStr: string; timeStr: string; reflectionText: string }): string`
- `synthesizeBedtimeReflection(params: { router: OrganModelRouter; profile: ResolvedEndocrineProfile; memoryDir: string; dateStr: string; now: Date; handover?: SubconsciousHandover; overrideReflectionText?: string }): Promise<string>`

### 2.3 `src/endocrine/handover.ts`
- `settleNightlyConcerns(params: { db: EchoreDatabase; profile: ResolvedEndocrineProfile; now: Date }): EndocrineNightVerdict`

### 2.4 `src/hippocampus/compiler.ts`
- `syncMemoryMetaFromFiles(params: { memoryDir: string; db: EchoreDatabase; now: Date }): void`
- `runNightlyCompiler(params: { memoryDir: string; db: EchoreDatabase; router?: OrganModelRouter; now: Date; dateStr: string; verdict: EndocrineNightVerdict; coldReflection: string; planOverride?: CompilationPlan }): Promise<NightlyCompileResult>`

### 2.5 `src/hippocampus/decay.ts`
- `CATEGORY_HALF_LIFE_DAYS`: `Record<MemoryCategory, number>` (`chat: 7, schedule: 14, solitary: 14, life_event: 30, health: 30, preference: 90`)
- `computeDailyRetention(category: MemoryCategory, accessCount: number): number`
- `reconsolidateRecalledMemories(params: { db: EchoreDatabase; memoryDir: string; recalledItems: RecalledMemoryItem[]; isNegativeOrConflictTurn: boolean; now: Date }): void`
- `runDailyMemoryDecayAndArchive(params: { memoryDir: string; db: EchoreDatabase; now: Date }): DecayArchiveReport`

### 2.6 `src/loop/engine.ts`
- `EchoreEngine.runSleepCycle(options?: SleepCycleOptions): Promise<SleepCycleOutput>`
