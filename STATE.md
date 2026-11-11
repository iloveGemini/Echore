# Echore 当前状态

> 开发交接用，不替代 [`README.md`](README.md)（是什么、为什么）和 [`notes/`](notes/)（设计与契约）。只留接下来要用的信息；全文 ≲ 150 行，做完的压成一行或删掉。
> 最后更新：2026-11-11（补全 `web/app.js` 内部算法联调与性格测试台前端事件绑定及 HTTP/SSE 全接口对接逻辑，验证 36/36 测试全绿）。

## 1. 当前阶段与核心决议（2026-11-11）

- **当前阶段**：**M1、M2、M3 全部完成**，已交付 **前端对话间三风格交互原型 Demo (`notes/design/demos/index.html`)** 与 **内部算法联调及性格测试台 (`web/`)**，下一步进入 **F1 正式前端界面定稿与后端联调**。
- **架构总纲与生效契约**：[`notes/design/architecture-and-memory-spec.md`](notes/design/architecture-and-memory-spec.md)（v1.3）· [`notes/plan/m1-contracts.md`](notes/plan/m1-contracts.md) · [`notes/plan/m2-contracts.md`](notes/plan/m2-contracts.md) · [`notes/plan/m3-contracts.md`](notes/plan/m3-contracts.md)。
- **M1 / M2 已落地交付项（摘要）**：
  - `src/core/`、`src/reflex/guard.ts`、`src/endocrine/`、`src/hippocampus/`、`src/llm/`、`src/frontstage/{performer,silent-worker,journal}.ts`、`src/loop/engine.ts`（环 1 实时交互环 + 环 3 昼夜睡眠新陈代谢环）。
- **M3.1 已落地交付项（五官感知层 + 独居生活引擎）**：
  1. **四通道边际感知层 (`src/perception/`)**：`chrono-ambient.ts`（天气剧变/断联/特殊时间窗边际触发）、`desktop-probe.ts`（状态段去噪聚合 + 隐私黑名单 + 禁报进程名）、`world-feed.ts`（RSS/Atom 与 HTML 正文提取）。
  2. **独居生活引擎 (`src/frontstage/solitary.ts`)**：`runSolitaryTick` 实现 S1 `feed_roaming`、S2 `hobby_project`（`projects.yaml` 跨天目标进度树）、S3 `secret_prep`（`prep_for_user.md` + 置 `has_prep: true`），落盘 `event_log` 与 `journal/` 并将多巴胺回血至 $B_{\text{da}} + 0.12$。
- **M3.2 已落地交付项（【环 2：自主心跳环】与三环咬合）**：
  1. **环 2 自主心跳 (`src/loop/engine.ts` · `EchoreEngine.onHeartbeat()`)**：推进 4 激素指数回归与褪黑素节律；入睡自动触发 `runSleepCycle()`（同夜单次）；Arbitrator 意愿分流器驱动分支 A `proactive`（主动破冰 + 未回计数递增）、分支 B `solitary`（无聊区独居行动）、分支 C `idle`（零 LLM 消耗静默呼吸）。
  2. **环 1 联动闭环 (`EchoreEngine.onUserMessage()`)**：自动合成感知切片注入当轮动态尾部，并自动回捞、核销 `has_prep` 暗中准备物证。
- **M3.3 & M3.4 已落地交付项（双模外壳：MCP 出差 + 时间快进台 + 主场 HTTP/SSE 服务层）**：
  1. **MCP Server 出差模式外壳 (`src/loop/mcp-server.ts` · `EchoreMcpServer`)**：暴露 4 个零泄露潜意识接口（`echore_wake_context`、`echore_recall`、`echore_digest_turn`、`echore_write_journal`）与 JSON-RPC 2.0 协议分发。
  2. **时间快进仿真台 (`src/loop/simulator.ts` · `TimeTravelSimulator`)**：支持一键快进任意时长（`4h` / `5d` / `15d`），自动驱动环 2 与跨夜环 3。
  3. **主场模式极薄 HTTP + SSE 服务层与联调测试台 (`src/loop/http-server.ts` · `web/`)**：严格切分「陪伴主视图通道（`GET /api/companion/state`、`POST /api/chat`，强制过 `assertNoInternalLeaks`）」与「造物主观测台通道（`GET /api/observatory/state`、`GET /api/observatory/archetypes`、`POST /api/observatory/persona`、`POST /api/heartbeat`、`POST /api/fast-forward`、`POST /api/sleep`）」及 `GET /api/events` SSE 实时事件流，并由 `web/{index.html,styles.css,app.js}` 提供双栏联调测试台。
- **前端对话间交互 Demo (`notes/design/demos/`)**：
  - 纯原生 HTML5 + CSS + ES Module JS 单页实现（`index.html`、`styles.css`、`pixel-mascot.js`、`pixel-wanderer.js`、`app.js`、`bundle.js`），**升级为性格动物塑「傲娇猫咪 (cat_aloof)」轮廓清晰 32x32 像素精灵**：四足交替猫步、输入框边缘猫咪揣手手 (Cat Loaf)、气泡边缘双爪扒拉探头、7 态飞机耳/踩奶/舔爪动作，以及全画布物理拖拽和 Claude 日夜双色。

---

## 2. 模块推进路线与未完成项

1. **Phase 0：架构定稿与工程规程就位（✅ 已完成，2026-11-10）**
2. **M1：白天热闭环 + 内分泌底座 + 多模型路由（✅ 已完成，2026-11-10）**
3. **M2：夜间冷闭环 + 记忆唯一编译器（✅ 已完成，2026-11-10）**
4. **M3.1：五官感知层 + 独居生活引擎（S1/S2/S3）（✅ 已完成，2026-11-10）**
5. **M3.2：【环 2：自主心跳环】与三环咬合（✅ 已完成，2026-11-10）**
6. **M3.3：MCP 出差外壳 + 时间快进仿真台（✅ 已完成，2026-11-10）**
7. **M3.4：主场模式极薄 HTTP + SSE 服务层（✅ 已完成，2026-11-10）**

---

## 3. 验证结果与运行备忘（2026-11-11）

- **测试结果**：`ECHORE_DATA_DIR=~/.echore/test bun test` → **9 个测试文件、36/36 项测试（314 个断言）全绿通过**
- **类型检查**：`bun run typecheck` (`tsc --noEmit`) → **0 error**
- **服务层与仿真启动**：`ECHORE_DATA_DIR=~/.echore/test bun run serve`（默认监听 `127.0.0.1:3377`）· `ECHORE_DATA_DIR=~/.echore/test bun run simulate 4h`
- **已知问题**：无阻塞问题；后端三环引擎与 HTTP/SSE 服务层均已就绪，可进入前端设计。
