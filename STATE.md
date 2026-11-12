# Echore 当前状态

> 开发交接用，不替代 [`README.md`](README.md)（是什么、为什么）和 [`notes/`](notes/)（设计与契约）。只留接下来要用的信息；全文 ≲ 150 行，做完的压成一行或删掉。
> 最后更新：2026-11-12（完成记忆系统进化 **Wave 1–4 全部落地**：Z 式冲突待复核门、L7 颗粒度机检、睡眠环原子回滚、空档短路、会话去重、三层级联冷仓唤醒、时间体感、召回回放黄金评测集、IDF 实词打分、三通道 RRF 融合、二跳度数抑制图扩散，以及 **Wave 4 睡前 30min 双向原话反馈链、`rapport.md` 反例条件收窄与双门控 B 立场锚**，验证 45/45 测试全绿）。

## 1. 当前阶段与核心决议（2026-11-12）

- **当前阶段**：**M1、M2、M3 与记忆进化 Wave 1–4 全部完成**；下一步进入 **F1 正式前端定稿与后端联调**。
- **架构总纲与生效契约**：[`notes/design/architecture-and-memory-spec.md`](notes/design/architecture-and-memory-spec.md)（v1.4）· [`notes/plan/memory-absorption-plan.md`](notes/plan/memory-absorption-plan.md)（v2 已完成）· [`notes/plan/m1-contracts.md`](notes/plan/m1-contracts.md) · [`notes/plan/m2-contracts.md`](notes/plan/m2-contracts.md) · [`notes/plan/m3-contracts.md`](notes/plan/m3-contracts.md)。
- **M1 / M2 / Wave 1–4 已落地交付项（摘要）**：
  - `src/core/`、`src/reflex/guard.ts`、`src/endocrine/`、`src/hippocampus/`、`src/llm/`、`src/frontstage/{performer,silent-worker,journal}.ts`、`src/loop/engine.ts`（环 1 实时交互环 + 环 3 昼夜睡眠新陈代谢环）。
  - **Wave 1 夜间编译止血与原子回滚护栏（2026-11-12）**：
    1. **Z 式冲突待复核门 (`src/hippocampus/compiler.ts`)**：保护 `allow_forget: false` 钉子记忆与 `people/*` 定义档；对未显式声明 `supersedes` 的 `preference / life_event / chat` 槽位碰撞，保留旧文件为 `有效`，将新断言降级为 `情境表态(...)` 并记入 `pendingConflicts`。
    2. **L7 记忆颗粒度机检 (`src/hippocampus/linter.ts`)**：拦截单文件断言过载（`> 6` 条，`too_coarse`）、正文超长（`> 600` 字符，`too_coarse`）与空洞/未格式化断言（`needs_rewrite`）。
    3. **睡眠环原子回滚 (`src/loop/engine.ts` · `runSleepCycle()`)**：写操作前记录 `memoryDir` 文件快照与 SQLite 备份；若 L1–L7 机检未通过或抛错，100% 还原磁盘 `.md` 文件与 SQLite 状态表。
  - **Wave 2 召回卫生、三层级联冷仓唤醒与时间体感（2026-11-12）**：
    1. **空档输入短路与防刷分 (`recall.ts` · `decay.ts`)**：`isIdleQuery` 识别纯语气/应答词（“嗯/好的/哈哈哈可以的”），短路跳过桶 B/C 与 `reconsolidateRecalledMemories` 加分。
    2. **会话去重与点名重提豁免 (`recall.ts` · `engine.ts`)**：维护本会话 2h 内已注入记忆滑窗施加 `0.40x` 降权，命中 `isExplicitReaskQuery` 自动豁免。
    3. **三层级联兜底与冷仓唤醒闭环 (`recall.ts` · `decay.ts`)**：Stage 1 活跃 MD → Stage 2 `event_log_fts` + 当日 `journal` 热记事（`[当时原话线索]`）→ Stage 3 显式追问旧茬时唤醒 `status: 已沉底` 冷归档并在再巩固时恢复为 `有效`、强度回血至 `0.435`。
    4. **模糊时间感与停顿体感 (`clock.ts` · `pre-hydrator.ts`)**：落地 `formatVagueWhen` 与 `formatGapHint`。
  - **Wave 3 召回回放评测集、IDF 实词打分、三通道 RRF 融合与二跳图谱（2026-11-12）**：
    1. **召回回放黄金评测集 (`tests/recall-replay.test.ts`)**：覆盖长句罕见专名、低分准确命中 vs 高分一跳邻居、二跳桥接与度数 $\ge 5$ Hub 抑制、空档卫生等场景。
    2. **IDF 实词字面打分 + 三检索通道 RRF 融合 (`recall.ts`)**：`computeIdfKeywordScores` 消除长句日常词对专名的稀释；`computeThreeChannelRrfScores` 仅对 `sem / kw / graph` 三检索通道排加权 RRF（$k=60$），再叠加 `0.10*time + 0.10*strength` 标量先验。
    3. **桶 C 二跳图扩散与 Hub 抑制 (`recall.ts`)**：支持 `Hop 1 >= 0.30`、`Hop 2 >= 0.50` 递进扩散，历时边施加 `0.40x` 阻尼，并对总度数 $\ge 5$ 的 Hub 节点拦截二跳中继。
  - **Wave 4 睡前双向原话反馈链、默契条件收窄与双门控立场锚（2026-11-12）**：
    1. **30min 时间窗双向原话反馈链 (`journal.ts` · `compiler.ts`)**：`extractFeedbackTriplets` 按相邻消息 $\le 30\text{min}$ 切分连续对话段，机械配对 `prev -> acts -> next` 原话三联包递给睡前自省与夜间编译器，防自我美化。
    2. **默契反例条件收窄 (`compiler.ts` · `schemas.ts`)**：`RapportRuleSpecSchema` 支持 `revises_rule_prefix`，就地收窄既有 `rapport.md` 默契条目并更新 `[src: log-xxx]`。
    3. **双门控 B 立场锚 (`recall.ts`)**：同时满足门控 1（评价词 + 征询/反问词 `isStanceCue`）与门控 2（住户历史表态 `hasMemoryStance` + 实质话题重叠 `sem > 0.30 || kw > 0.25`）时，穿透会话去重并赋予 `+0.22` 立场锚加成（`[我之前的立场]`），根治闲聊顺从改口。
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
8. **记忆进化 Wave 1：Z 式防误取代 + L7 颗粒度机检 + 睡眠环原子回滚（✅ 已完成，2026-11-12）**
9. **记忆进化 Wave 2：空档短路 + 会话去重 + 三层级联冷仓唤醒 + 时间体感（✅ 已完成，2026-11-12）**
10. **记忆进化 Wave 3：召回回放黄金评测集 + IDF 实词打分 + 三通道 RRF 融合 + 二跳度数抑制图扩散（✅ 已完成，2026-11-12）**
11. **记忆进化 Wave 4：睡前 30min 双向原话反馈链 + `rapport.md` 反例条件收窄 + 双门控 B 立场锚（✅ 已完成，2026-11-12）**

---

## 3. 验证结果与运行备忘（2026-11-12）

- **测试结果**：`ECHORE_DATA_DIR=~/.echore/test bun test` → **10 个测试文件、45/45 项测试（413 个断言）全绿通过**
- **类型检查**：`bun run typecheck` (`tsc --noEmit`) → **0 error**
- **服务层与仿真启动**：`ECHORE_DATA_DIR=~/.echore/test bun run serve`（默认监听 `127.0.0.1:3377`）· `ECHORE_DATA_DIR=~/.echore/test bun run simulate 4h`
- **已知问题**：无阻塞问题；后端三环引擎与 HTTP/SSE 服务层均已就绪，可进入前端设计。
