# M1 接口与模块契约（白天热闭环 + 内分泌底座 + 多模型路由）

> 状态：M1 生效契约（2026-11-10）
> 依据：[`notes/design/architecture-and-memory-spec.md`](../design/architecture-and-memory-spec.md) §1–§7

---

## 1. 范围与可观察验收标准

M1 聚焦跑通 **【环 1：实时交互环 Reactive Loop】** 及其全部确定性底座：
1. **`src/core/`**：`VirtualClock` 虚拟时钟、`bun:sqlite` 骨层存储（`event_log`、`hormone_state`、`reflex_state`、`concerns`、`memory_meta` + FTS5 全文检索）、Zod 核心契约与零泄露校验器。
2. **`src/reflex/guard.ts`**：纯代码脊髓守卫（褪黑素睡眠锁、作息静默窗、24h 主动冷却窗、连续 2 次主动未回挂起 `proactive_lock = true` 及用户回复自动解锁）。
3. **`src/endocrine/`**：
   - `archetypes.ts`：5 套内置内分泌原型（`dog_sunny` / `cat_aloof` / `cool_detached` / `clingy_sensitive` / `steady_anchor`）+ 3 套作息（`early_bird` / `regular` / `night_owl`）+ L0（单原型/双原型混血）/ L1（三档语义滑块）/ L2（4 个动作槽位）覆写编译；
   - `hormones.ts`：4 激素双锚点（舒适基线 $B_h$ vs 匮乏底值 $F_h$）指数回归、活跃牵挂 `Floor_cort` 托底、T2 冷战期 `Cap_ox` 封顶（$B_{\text{ox}} - 0.15$）、24h 褪黑素余弦节律；
   - `evaluator.ts`：出厂前四道调准（挂载 `implicit/rapport.md` 默契滤网与 T3 雷区 $2.0\times$ 敏感加倍、低置信度 `< 0.75` 悬置试探阻尼、禁绝无事由孤儿脉冲与 Recall 零增益锁、和解当轮日内实时快代谢）；
   - `handover.ts`：产出零浮点数、零 `log-*` 主键的《潜意识心境交接单》（含原话预水合引文）。
4. **`src/hippocampus/`**：
   - `linter.ts`：L1–L6 六项确定性 Memory CI Linter；
   - `pre-hydrator.ts`：按 `source_event_id` 从 SQLite 提取原始对话并抹去机械主键；
   - `recall.ts`：1v1 三桶保底配额（近期生活主线槽 + 话题直命槽 + 显式图谱顺藤摸瓜槽）+ 五路加权混排（`0.40 / 0.15 / 0.25 / 0.10 / 0.10`）+ Top 3 原话预水合。
5. **`src/llm/`**：
   - `types.ts` / `anthropic.ts` / `openai-compat.ts` / `tool-runner.ts` / `router.ts`：统一 `LLMProvider`、三明治 Prompt Caching 顺序（静前动后）、并行工具循环与按岗位模型路由器。
6. **`src/frontstage/` + `src/loop/engine.ts`**：
   - `performer.ts`（三明治上下文组装与第一人称对话）、`silent-worker.ts`（无声替身 Subagent 结果强制第一人称归位）、`journal.ts`（白天热记事追加）、`engine.ts`（`EchoreEngine.onUserMessage()` 完整串联环 1）。
7. **`memory_template/`**：可通过 L1–L6 全绿体检的标准初始记忆仓骨架。

---

## 2. 模块接口契约

### 2.1 `src/core/clock.ts`
```ts
export interface Clock {
  now(): Date;
  nowMs(): number;
  nowIso(): string;
  todayStr(): string; // YYYY-MM-DD (local or configured tz)
  advanceMs(ms: number): void;
  advanceHours(hours: number): void;
  advanceDays(days: number): void;
  setNow(target: Date | string | number): void;
}
```
- `formatVagueWhen(eventIsoOrDate: Date | string, now: Date): string`（Wave 2 回想时刻自然粗化：今天按自然日 8 时段返回 `今天凌晨/早上/上午/中午/下午/傍晚/晚上/深夜`，昨/前天返回 `昨天深夜` 等，7 天内返回 `MM-DD（周X）时段`，更早返回 `YYYY-MM-DD`）
- `formatGapHint(deltaMs: number): string | null`（Wave 2 相邻事件停顿体感：`< 10m` 返回 `null`、`10–30m` 返回 `（过了一会儿）`、`30–60m` 返回 `（过了半个多小时）`、`>= 60m` 返回 `（隔了约 N 小时）`、`>= 24h` 返回 `（隔了约 N 天）`）

### 2.2 `src/core/schemas.ts`
- `ArchetypeIdSchema`: `'dog_sunny' | 'cat_aloof' | 'cool_detached' | 'clingy_sensitive' | 'steady_anchor'`
- `ChronotypeIdSchema`: `'early_bird' | 'regular' | 'night_owl'`
- `SliderLevelSchema`: `'low' | 'mid' | 'high'`
- `MoodActionSlotsSchema`: `{ when_hurt_or_tense, when_missing_user, when_bored_alone, when_warm_excited }`
- `PersonaConfigSchema`: 支持 `name`（默认 `'Echore'`）、`user_name`（默认 `'用户'`）、`user_pronoun`（默认 `'他'`）、`relationship`（默认 `'初识'`）、L0 单字符串或权重 Record、L1 可选滑块（`attachment_need`、`defensiveness`、`solitude_tolerance`）、L2 可选动作槽位覆写。
- `SubconsciousHandoverSchema`:
  ```ts
  {
    当下心境基调: string;
    身体节律感: string;
    脑子里盘旋的事: Array<{
      牵挂: string;
      当时原话印象: string;
    }>;
  }
  ```
  配套 `assertNoInternalLeaks(text: string)`：一旦检测到 `log-\d{8}` 主键或裸激素键值即抛错拦截。

### 2.3 `src/core/db.ts`
- 环境变量 `ECHORE_DATA_DIR` 优先（测试强制走 `~/.echore/test` 或内存/临时路径，绝不触碰正式库）。
- 核心方法：
  - `appendEventLog(entry): EventLogRecord`
  - `getEventLogById(id: string): EventLogRecord | null`
  - `getRecentEventLogs(limit: number): EventLogRecord[]`
  - `getHormoneState(): HormoneState` / `saveHormoneState(state: HormoneState): void`
  - `getReflexState(): ReflexState` / `saveReflexState(state: ReflexState): void`
  - `listActiveConcerns(): ConcernRecord[]` / `upsertConcern(concern: ConcernRecord): void`
  - `upsertMemoryMeta(meta: MemoryMetaRecord): void` / `getMemoryMeta(id: string): MemoryMetaRecord | null`

### 2.4 `src/reflex/guard.ts`
- `evaluateReflexGuard({ reflexState, melatonin, now, chronotype })`：
  - `sleepLocked`: `melatonin >= 0.75` 或处于作息睡眠锁窗口；
  - `proactiveCooldownLocked`: 距 `last_proactive_at` 不足 24h；
  - `proactiveUnansweredLocked`: `proactive_lock === true` 或 `consecutive_unanswered_proactive >= 2`；
  - `canProactiveWake`: 上述三把锁全为 `false`。

### 2.5 `src/endocrine/`
- `resolvePersonaProfile(config: PersonaConfig): ResolvedEndocrineProfile`
- `stepHormones({ state, profile, now, activeConcerns?, overrideDeltaHours? }): HormoneState`
- `applyEndocrineCalibrationGates(input: EndocrineEvaluationInput, db?: EchoreDatabase): EndocrineTurnOutcome`：执行四道门调准并就地更新激素与牵挂状态。
- `buildSubconsciousHandover(params: BuildHandoverParams): SubconsciousHandover`

### 2.6 `src/hippocampus/`
- `runMemoryLinter({ memoryDir, db, now }): LintReport`（覆盖 L1–L7）
- `preHydrateQuotes(db: EchoreDatabase, sourceEventIds: Array<string | undefined | null>, now?: Date): Map<string, string>`
- `formatEventFlowWithGapHints(records: EventLogRecord[], now: Date): string[]`（按时间序展开事件流并插入模糊时段与 `gapHint` 停顿提示）
- `isIdleQuery(text: string): boolean` / `isExplicitReaskQuery(text: string): boolean`
- `isStanceCue(query: string): boolean` / `hasMemoryStance(file: ParsedMemoryFile): boolean`（Wave 4 双门控 B 立场锚：同时满足“评价词 + 征询/反问词”与“住户历史表态 + 话题实质重叠 `sem > 0.30 || kw >= 0.20`”时，穿透会话去重并赋予 `+0.22` 立场锚加成）
- `computeIdfKeywordScores(query: string, docs: ReadonlyArray<{ key: string; text: string }>): Map<string, number>`（Wave 3 实词 IDF 字面打分，消除长句日常词稀释罕见专名得分）
- `computeThreeChannelRrfScores(candidates, k?: number): Map<string, number>`（Wave 3 三检索通道 `sem / kw / graph` 加权 RRF 融合，$k=60$，不含固有标量 `time / strength`）
- `recallMemories(params): RecallResult`（Wave 2 & Wave 3 升级：空档输入 `isIdleQuery` 短路只留桶 A；`recentSessionRecalledIds` 会话去重降权与点名重提豁免；IDF 实词字面打分 + 三检索通道 RRF 与 `0.10*time + 0.10*strength` 标量先验混排；桶 C 二跳图扩散 `Hop 1 >= 0.30`、`Hop 2 >= 0.50`、历时边 `0.40x` 阻尼与总度数 $\ge 5$ Hub 节点中继抑制；三层级联兜底：Stage 1 活跃 MD → Stage 2 `event_log_fts` + 当日 `journal` 热记事 → Stage 3 `status: 已沉底` 冷仓唤醒闭环）

### 2.7 `src/llm/` 与 `src/frontstage/`、`src/loop/engine.ts`
- `SandwichRequest`:
  - `staticPrefix`: `{ tools, systemPartA, systemPartB }`（24h 稳定，打缓存断点 1）
  - `appendOnlyHistory`: `ChatMessage[]`（打缓存断点 2，多步工具循环内全程保持同一 `SandwichRequest` 缓存断点）
  - `dynamicTail`: `{ subconsciousBlock, latestUserMessage }`（垫在最末尾）
- `runSilentWorker(params: SilentWorkerTaskParams)` / `createSilentWorkerTool(router, workerTools)`：返回强制以第一人称 `"我刚才顺手去翻了翻，记下这些要点：..."` 包装的笔记，严禁暴露“Subagent/助手汇报”字样。
- `EchoreEngine.onUserMessage(userMessage: string, options?: ReactiveTurnOptions)`：执行【环 1】五步闭环并返回 `{ userEventId, assistantEventId, reply, handover, recalled, hormoneState, endocrineOutcome, journalEntry, sandwichRequest }`。
