# Echore 当前状态

> 开发交接用，不替代 [`README.md`](README.md)（是什么、为什么）和 [`notes/`](notes/)（设计与契约）。只留接下来要用的信息；全文 ≲ 150 行，做完的压成一行或删掉。
> 最后更新：2026-11-10（完成 M2 代码审阅修复：夜间冷闭环 + 记忆唯一编译器 + 分品类定步长衰减与沉底归档，待进入 M3 感知独居与 MCP 出差）。

## 1. 当前阶段与核心决议（2026-11-10）

- **当前阶段**：**M1、M2 已完成**（白天热闭环 + 内分泌底座 + 多模型路由 + 夜间冷闭环 + 记忆唯一编译器），下一步进入 **M3（感知系统 + 独居目标树 + MCP 出差 + 时间快进仿真台）**。
- **架构总纲与生效契约**：[`notes/design/architecture-and-memory-spec.md`](notes/design/architecture-and-memory-spec.md)（v1.3）· [`notes/plan/m1-contracts.md`](notes/plan/m1-contracts.md) · [`notes/plan/m2-contracts.md`](notes/plan/m2-contracts.md)。
- **M1 已落地交付项（摘要）**：
  - `src/core/`（`VirtualClock`、`EchoreDatabase`、`assertNoInternalLeaks`）、`src/reflex/guard.ts`（褪黑素睡眠锁、24h 主动冷却窗、连续 2 次主动未回 `proactive_lock`）、`src/endocrine/`（5 套内分泌原型 + L0/L1/L2 解析、双锚点回归方程、出厂前四道调准、零数字《潜意识心境交接单》）、`src/hippocampus/`（L1–L6 Linter、1v1 三桶五路召回 + Top 3 原话预水合）、`src/llm/`（Anthropic/OpenAI 双 Adapter 三明治缓存组装 + `OrganModelRouter`）、`src/frontstage/` + `src/loop/engine.ts`（【环 1：实时交互环】与无声替身 Subagent）。
- **M2 已落地交付项**：
  1. **前台睡前自省冷叙事 (`src/frontstage/journal.ts`)**：`extractHotEntriesForDate`、`extractColdReflectionForDate`、`appendColdReflectionEntry`、`synthesizeBedtimeReflection`（由前台以第一人称汇总当日交互与独居热记事，写入 `journal/YYYY-MM-DD.md` 的 `## 睡前自省`，严守零泄露校验）。
  2. **情绪官夜间肝脏结算 (`src/endocrine/handover.ts`)**：`settleNightlyConcerns` 扫描 SQLite `concerns` 表出具《情绪结转裁决单》（`EndocrineNightVerdict`），区分日内快代谢 `settle_resolved`（`已落定`）、T1 满 7 天 `fade_minor_worry`（`已淡化`）、T2 满 5 天 `escalate_cold_war`（`僵持待解` + 开启冷战催产素封顶 $\text{Cap}_{\text{ox}} = B_{\text{ox}} - 0.15$）、T2 僵持满 21 天 `crystallize_scar`（结转 T3 `已结痂`，释放日常 $\text{Cap}_{\text{ox}}$ 并生成 `scar_rule`）。
  3. **记忆官夜间唯一编译器 (`src/hippocampus/compiler.ts`)**：`runNightlyCompiler` 统一编译 `people/`、`events/`、`concerns/` 与 `implicit/rapport.md`，自动检测同主语#属性槽位冲突并闭合 `supersedes` 取代链（旧文件置为 `status: 已取代`，同步修正活跃文件共时引用防 L2/L3/L4 报错），自动补齐未定义 `[[people/xxx]]` 符号档防 L1 报错，并原样保留前台第一人称叙事原肉。
  4. **分品类定步长衰减、正向再巩固与沉底门 (`src/hippocampus/decay.ts`)**：`computeDailyRetention`、`reconsolidateRecalledMemories`（正向召回 `+0.05`，负面冲突/未落定牵挂只增 `access_count` 不加 `strength`）、`runDailyMemoryDecayAndArchive`（零访问记忆在 $t = T_{\text{cat}}$ 精准衰减至 `0.12` 并归档为 `status: 已沉底`，`allow_forget: false` 免死金牌直接豁免）。
  5. **环 3 总控串联 (`src/loop/engine.ts`)**：`EchoreEngine.runSleepCycle()` 完整跑通 Step 1（睡前冷叙事）→ Step 2（肝脏结算）→ Step 3（唯一编译）→ Step 4（定步长衰减归档 + L1–L6 终检 + 独立记忆仓自动 `git commit`）。

---

## 2. 模块推进路线与未完成项

1. **Phase 0：架构定稿与工程规程就位（✅ 已完成，2026-11-10）**
2. **M1：白天热闭环 + 内分泌底座 + 多模型路由（✅ 已完成，2026-11-10）**
3. **M2：夜间冷闭环 + 记忆唯一编译器（✅ 已完成，2026-11-10）**
4. **M3：感知系统 + 独居目标树 + MCP 出差 + 时间快进仿真台（📐 下一步待开工）**
   - 编写 `notes/plan/m3-contracts.md` 契约；
   - 实现四通道感知层（`src/perception/chrono-ambient.ts`、`desktop-probe.ts`、`world-feed.ts`）；
   - 实现独居生活引擎三类有物证行动（`src/frontstage/solitary.ts`：S1 阅读批注、S2 `projects.yaml` 跨天目标进度树推进、S3 为用户暗中查资料 `has_prep` + 多巴胺回血至 $B_{\text{da}}$）；
   - 串联【环 2：自主心跳环】（`EchoreEngine.onHeartbeat()`：意愿分流器 Arbitrator 驱动主动破冰 / 独居行动 / 入睡触发环 3 / 静默呼吸）；
   - 实现 MCP Server 出差模式外壳（`src/loop/mcp-server.ts`：暴露 `echore_wake_context`、`echore_recall`、`echore_digest_turn`、`echore_write_journal`）与 CLI 时间快进仿真台（`src/loop/simulator.ts`）。

---

## 3. 验证结果与运行备忘（2026-11-10）

- **测试结果**：`ECHORE_DATA_DIR=~/.echore/test bun test` → **5 个测试文件、22 项测试（168 个断言）全绿通过**
- **类型检查**：`bun run typecheck` (`tsc --noEmit`) → **0 error**
- **已知问题**：M2 审阅检出的 7 项边界与逻辑问题（Day-0 新记忆免扣首日衰减、已落定牵挂单次结转与原叙保护、多槽位冲突取代闭合、行级共时链接改写隔离、`memory_meta` 路径唯一键重命名同步、冲突关联事件防反刍锁、兜底文案红线与入睡节律对齐）已全部修复并附回归测试；下一步进入 M3。
