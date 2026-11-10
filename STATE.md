# Echore 当前状态

> 开发交接用，不替代 [`README.md`](README.md)（是什么、为什么）和 [`notes/`](notes/)（设计与契约）。只留接下来要用的信息；全文 ≲ 150 行，做完的压成一行或删掉。
> 最后更新：2026-11-10（完成 M3.1 感知与独居 + M3.2 环 2 自主心跳 + M3.3 MCP 出差外壳与时间快进仿真台，M1–M3 全部核心交付项已落地闭环）。

## 1. 当前阶段与核心决议（2026-11-10）

- **当前阶段**：**M1、M2、M3（M3.1 / M3.2 / M3.3）全部完成**（【环 1：实时交互环】+【环 2：自主心跳环】+【环 3：昼夜新陈代谢环】+ 四通道感知 + S1/S2/S3 有物证独居 + MCP Server 出差模式 + 时间快进仿真台）。
- **架构总纲与生效契约**：[`notes/design/architecture-and-memory-spec.md`](notes/design/architecture-and-memory-spec.md)（v1.3）· [`notes/plan/m1-contracts.md`](notes/plan/m1-contracts.md) · [`notes/plan/m2-contracts.md`](notes/plan/m2-contracts.md) · [`notes/plan/m3-contracts.md`](notes/plan/m3-contracts.md)。
- **M1 / M2 已落地交付项（摘要）**：
  - `src/core/`、`src/reflex/guard.ts`、`src/endocrine/`、`src/hippocampus/`、`src/llm/`、`src/frontstage/{performer,silent-worker,journal}.ts`、`src/loop/engine.ts`（环 1 实时交互环 + 环 3 昼夜睡眠新陈代谢环）。
- **M3.1 已落地交付项（五官感知层 + 独居生活引擎）**：
  1. **四通道边际感知层 (`src/perception/`)**：`chrono-ambient.ts`（天气剧变/断联/特殊时间窗边际触发）、`desktop-probe.ts`（状态段去噪聚合 + 隐私黑名单 + 禁报进程名）、`world-feed.ts`（RSS/Atom 与 HTML 正文提取）。
  2. **独居生活引擎 (`src/frontstage/solitary.ts`)**：`runSolitaryTick` 实现 S1 `feed_roaming`、S2 `hobby_project`（`projects.yaml` 跨天目标进度树）、S3 `secret_prep`（`prep_for_user.md` + 置 `has_prep: true`），落盘 `event_log` 与 `journal/` 并将多巴胺回血至 $B_{\text{da}} + 0.12$。
- **M3.2 已落地交付项（【环 2：自主心跳环】与三环咬合）**：
  1. **环 2 自主心跳 (`src/loop/engine.ts` · `EchoreEngine.onHeartbeat()`)**：推进 4 激素指数回归与褪黑素节律；入睡自动触发 `runSleepCycle()`（同夜单次）；Arbitrator 意愿分流器驱动分支 A `proactive`（主动破冰 + 未回计数递增）、分支 B `solitary`（无聊区独居行动）、分支 C `idle`（零 LLM 消耗静默呼吸）。
  2. **环 1 联动闭环 (`EchoreEngine.onUserMessage()`)**：自动合成感知切片注入当轮动态尾部，并自动回捞、核销 `has_prep` 暗中准备物证。
- **M3.3 已落地交付项（MCP 出差模式外壳 + 时间快进仿真台）**：
  1. **MCP Server 出差模式外壳 (`src/loop/mcp-server.ts` · `EchoreMcpServer`)**：暴露 4 个潜意识接口（`echore_wake_context`、`echore_recall`、`echore_digest_turn`、`echore_write_journal`），支持 JSON-RPC 2.0（`initialize` / `tools/list` / `tools/call` / `ping`）与直接编程调用，全程经 `assertNoInternalLeaks` 严守零浮点数与零 `log-*` 主键泄露。
  2. **时间快进仿真台 (`src/loop/simulator.ts` · `TimeTravelSimulator`)**：支持一键快进任意时长（`4h` / `5d` / `15d`），自动驱动环 2 与跨夜环 3，输出激素轨迹、独居物证、T2 满 5 天冷战封顶 $\text{Cap}_{\text{ox}}$、T3 满 21 天结痂入 `rapport.md` 及 `status: 已沉底` 归档全链路看板。

---

## 2. 模块推进路线与未完成项

1. **Phase 0：架构定稿与工程规程就位（✅ 已完成，2026-11-10）**
2. **M1：白天热闭环 + 内分泌底座 + 多模型路由（✅ 已完成，2026-11-10）**
3. **M2：夜间冷闭环 + 记忆唯一编译器（✅ 已完成，2026-11-10）**
4. **M3.1：五官感知层 + 独居生活引擎（S1/S2/S3）（✅ 已完成，2026-11-10）**
5. **M3.2：【环 2：自主心跳环】与三环咬合（✅ 已完成，2026-11-10）**
6. **M3.3：MCP 出差外壳 + 时间快进仿真台（✅ 已完成，2026-11-10）**

---

## 3. 验证结果与运行备忘（2026-11-10）

- **测试结果**：`ECHORE_DATA_DIR=~/.echore/test bun test` → **8 个测试文件、32 项测试（275 个断言）全绿通过**
- **类型检查**：`bun run typecheck` (`tsc --noEmit`) → **0 error**
- **仿真验证**：`ECHORE_DATA_DIR=~/.echore/test bun run simulate 4h` 正常输出三环仿真看板
- **已知问题**：M3 代码审阅检出的 5 项边界问题（环 2 主动破冰保留 `has_prep` 直至环 1/MCP 实际消费、`echore_digest_turn` 接入情绪官模型评估与历史追加、S3 仅针对未准备的 `minor_worry` 且 S2 支持多项目进度树推进、快进仿真台放开编译器模型调用并限制单步跨度 $\le 180\text{m}$、桌面探针补齐 `media` 状态段与外部 `log-*` 清洗）已全部修复并附回归测试；M1–M3 全部交付闭环，可随时提交。
