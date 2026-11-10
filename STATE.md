# Echore 当前状态

> 开发交接用，不替代 [`README.md`](README.md)（是什么、为什么）和 [`notes/`](notes/)（设计与契约）。只留接下来要用的信息；全文 ≲ 150 行，做完的压成一行或删掉。
> 最后更新：2026-11-10（完成 M1：白天热闭环 + 内分泌底座 + 多模型路由施工与验证，待进入 M2 夜间冷闭环）。

## 1. 当前阶段与核心决议（2026-11-10）

- **当前阶段**：**M1 已完成**（白天热闭环 + 内分泌底座 + 多模型路由），下一步进入 **M2（夜间冷闭环 + 记忆唯一编译器）**。
- **架构总纲与 M1 契约**：[`notes/design/architecture-and-memory-spec.md`](notes/design/architecture-and-memory-spec.md)（v1.3）· [`notes/plan/m1-contracts.md`](notes/plan/m1-contracts.md)。
- **M1 已落地交付项**：
  1. **底座与骨层存储 (`src/core/`)**：`VirtualClock`（确定性快进与 `log-*` ID 生成）、`EchoreDatabase`（`bun:sqlite` 单文件库，`event_log` + CJK 分词 `FTS5`、`hormone_state`、`reflex_state`、`concerns`、`memory_meta`）、Zod 契约与 `assertNoInternalLeaks`（拦截 `log-*` 主键与激素浮点数泄露）。
  2. **反射层守卫 (`src/reflex/guard.ts`)**：纯代码实现褪黑素睡眠锁（$\ge 0.75$）、3 套作息静默窗、24h 主动冷却窗、连续 2 次主动未回挂起 `proactive_lock = true` 及用户回复自动解锁。
  3. **情绪官热路径 (`src/endocrine/`)**：
     - `archetypes.ts`：5 套内置内分泌原型（`dog_sunny` / `cat_aloof` / `cool_detached` / `clingy_sensitive` / `steady_anchor`）+ 3 套作息 + L0（单原型/双原型混血）/ L1（三档滑块）/ L2（4 个动作槽位）解析器；
     - `hormones.ts`：舒适基线 $B_h$ 与匮乏底值 $F_h$ 双锚点指数回归、T2 急性期 `Floor_cort` 托底与冷战期 `Cap_ox`（$B_{\text{ox}} - 0.15$）天花板封顶、24h 褪黑素余弦节律；
     - `evaluator.ts`：出厂前四道调准（Gate 1 挂载 `rapport.md` 默契滤网与 T3 结痂雷区 $2.0\times$ 敏感加倍、Gate 2 置信度 `< 0.75` 悬置阻尼、Gate 3 禁绝无事由孤儿脉冲與 Recall 零增益、Gate 4 和解当轮日内快代谢清除 $65\%\sim 85\%$ 残余压力）；
     - `handover.ts`：生成零浮点数、零 `log-*` 主键且附带预水合引文的《潜意识心境交接单》。
  4. **记忆官热路径与 Linter (`src/hippocampus/`)**：
     - `linter.ts`：完整实现 L1（未定义符号）、L2（共时失效状态引用）、L3（取代链闭合）、L4（同符号有效断言冲突）、L5（原文指针完备性）、L6（牵挂注 T1/T2/T3 分级流转）六项确定性体检；
     - `pre-hydrator.ts` + `recall.ts`：1v1 三桶保底配额（近期生活主线槽 + 话题直命槽 + 显式图谱 1 度扩散槽）+ 五路加权混排 + Top 3 原话引文预水合。
  5. **多模型路由与三明治缓存组装 (`src/llm/`)**：
     - `AnthropicAdapter`（自动在 System Part B 与 Append-Only 历史末尾打 `ephemeral` 缓存断点）+ `OpenAICompatAdapter`（100% 静态前缀字节稳定）+ 并行 `runToolLoop` + 按岗位 `OrganModelRouter`（`frontstage` / `endocrine` / `compiler` / `worker`）。
  6. **前台实时演奏与环 1 总控 (`src/frontstage/` + `src/loop/engine.ts`)**：
     - `performer.ts`（三明治组装 + `rapport.md` 行尾溯源剥离）、`silent-worker.ts`（无声替身 Subagent 强制第一人称归位）、`journal.ts`（追加当日第一人称热记事）、`EchoreEngine.onUserMessage()` 完整跑通【环 1：实时交互环】。

---

## 2. 模块推进路线与未完成项

1. **Phase 0：架构定稿与工程规程就位（✅ 已完成，2026-11-10）**
2. **M1：白天热闭环 + 内分泌底座 + 多模型路由（✅ 已完成，2026-11-10）**
3. **M2：夜间冷闭环 + 记忆唯一编译器（📐 下一步待开工）**
   - 编写 `notes/plan/m2-contracts.md` 契约；
   - 实现前台睡前自省冷叙事汇总（`src/frontstage/journal.ts` 扩展）；
   - 实现情绪官夜间肝脏结算《情绪结转裁决单》（`src/endocrine/handover.ts` 扩展：T1 满 7 天淡化、T2 满 5 天急性转冷战封顶 `僵持待解`、T3 留疤）；
   - 实现记忆官夜间唯一 Markdown 编译器（`src/hippocampus/compiler.ts`：编译 `people/`、`events/`、`concerns/`、`implicit/rapport.md`，维护 `supersedes` 链并保留前台原叙）；
   - 实现分品类定步长指数衰减与 `status: 已沉底` 归档门（`src/hippocampus/decay.ts`）并串联【环 3：昼夜新陈代谢环】（`EchoreEngine.runSleepCycle()`，含 L1–L6 体检与自动 git commit）。
4. **M3：感知系统 + 独居目标树 + MCP 出差 + 时间快进仿真台（📐 待施工）**

---

## 3. 验证结果与运行备忘（2026-11-10）

- **测试结果**：`ECHORE_DATA_DIR=~/.echore/test bun test` → **4 个测试文件、16 项测试（105 个断言）全绿通过**
- **类型检查**：`bun run typecheck` (`tsc --noEmit`) → **0 error**
- **本轮加固（M1 Code Review 修复）**：
  - 情绪官 `evaluatePulseWithOrgan` 补齐「最近对话上下文 + 当前活跃牵挂注」输入与完整 JSON Schema（含 `new_concern` / `reconciled_concern_ids` 及高置信冲突兜底补齐）；
  - `runToolLoop` 多步工具调用在 Step 2+ 保持 Anthropic 三明治双缓存断点（`systemPartB` + `appendOnlyHistory` 末尾）；
  - 修复 Gate 1/2 拦截后落入 Gate 3 误判、Gate 4 全清牵挂后残余皮质醇压回防御阈值内；
  - 补齐三桶五路召回 `topK` 截断保底优先级与未满补位，扩充 L2/L4/L6 Linter 谓词与 `tier` 校验；
  - 统一 `VirtualClock.todayStr()` / `formatLogId()` UTC 日期基准、增强 `assertNoInternalLeaks` 自然语言激素浮点检测、FTS5 停用词过滤与 `OR` 兜底检索、热记事单行换行折叠，并同步 [`notes/plan/m1-contracts.md`](notes/plan/m1-contracts.md)。
- **已知问题**：无阻塞问题；M2 需接入夜间编译器与定步长衰减闭环。
