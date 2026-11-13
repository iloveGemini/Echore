# Echore 当前状态

> 开发交接用，不替代 [`README.md`](README.md)（是什么、为什么）和 [`notes/`](notes/)（设计与契约）。只留接下来要用的信息；全文 ≲ 150 行，做完的压成一行或删掉。
> 最后更新：2026-11-13（完成 **Horon 记忆吸收二期 Wave 5–7 全部落地**及工作区 review 缺陷修复与 `evals/` 人工考卷补齐；验证 60/60 测试全绿）。

## 1. 当前阶段与核心决议（2026-11-13）

- **当前阶段**：**M1–M3、记忆进化 Wave 1–4 与 Horon 吸收 Wave 5–7 全部完成**；下一步进入 **F1 正式前端定稿与后端联调**。
- **架构总纲与生效契约**：[`notes/design/architecture-and-memory-spec.md`](notes/design/architecture-and-memory-spec.md)（v1.4）· [`notes/plan/memory-absorption-plan.md`](notes/plan/memory-absorption-plan.md)（Wave 1–4 已完成）· [`notes/plan/horon-memory-absorption-plan.md`](notes/plan/horon-memory-absorption-plan.md)（v2.1 · Wave 5–7 已完成）· [`notes/plan/m1-contracts.md`](notes/plan/m1-contracts.md) · [`notes/plan/m2-contracts.md`](notes/plan/m2-contracts.md) · [`notes/plan/m3-contracts.md`](notes/plan/m3-contracts.md)。
- **M1 / M2 / Wave 1–4 已落地交付项（摘要）**：
  - `src/core/`（含 `prompts.ts` 与 `prompts/*.md` 读时热加载）、`src/reflex/guard.ts`、`src/endocrine/`、`src/hippocampus/`、`src/llm/`、`src/frontstage/{performer,silent-worker,journal,solitary}.ts`、`src/loop/engine.ts`（环 1 实时交互环 + 环 2 自主心跳环 + 环 3 昼夜睡眠新陈代谢环）。
  - **LLM 提示词外置化 (`prompts/*.md` & `src/core/prompts.ts`)**：将全系统 4 器官 10 个提示词（含 `stance-cue-judge.md`）统一收敛至顶层 [`prompts/`](prompts/README.md)，带 `version` 与 `organ` frontmatter，读时现读不缓存、支持 `promptsDir` 沙箱覆写。
  - **记忆进化 Wave 1–4（2026-11-12，摘要）**：Z 式冲突待复核门、L7 颗粒度机检与睡眠环原子回滚；空档短路、会话去重与三层级联冷仓唤醒；IDF 实词打分、三通道 RRF 融合、二跳 Hub 抑制图扩散与 `recall-replay` 基准；30min 双向原话反馈链、`rapport.md` 条件收窄与双门控立场锚；跨午夜单调睡眠游标（`getUnsettledEventLogs`）与日记封底切分（`getCircadianDateStr`）。
  - **Horon 吸收二期 Wave 5–7（2026-11-13，摘要）**：
    1. **Wave 5.1–5.2 书腰索引与共现转移边 (`schemas.ts` · `compiler.ts` · `recall.ts` · `decay.ts` · `db.ts`)**：支持 `when_to_recall` + 反泛化门 `sanitizeWhenToRecall`、词法/IDF 融合与 `embedding_fingerprint` 变更清空陈旧 `embedding_json`；`memory_transitions` 事务化记录 30min 滑窗内跨轮实质召回批次共现（`step=0.35`, `γ=0.95`, `<0.05` 剪枝，无 `1.0` 封顶）并入桶 C 一跳联想。
    2. **Wave 6.1–6.3 门控精度与文本补丁 (`recall.ts` · `linter.ts` · `text-patch.ts` · `compiler.ts` · `evals/`)**：`isStanceCue` 非空档命中走 `endocrine` 路由二元复筛（`1200ms` 超时降级）；`memory_meta.audit_fingerprint` 仅在通过 L7 后落盘供增量跳过，L8 主题混装 `Warning`（全断言带锚 + `>=300B` + `>=3` 断言，绝不阻断睡眠环）；独立实现 `replaceUniqueNormalizedFragment`（不改全文 NFC）加固 `rapport.md` 条件收窄；补齐 `evals/{stance-cue-judge,memory-compiler}` 人工考卷。
    3. **Wave 7.1–7.2 推演探针与 CoW 快照 (`engine.ts` · `db.ts` · `http-server.ts`)**：`probeWhatIf()` 在 SQLite `SAVEPOINT` 内纯同步零副作用推演并暴露 `POST /api/observatory/what-if`；`memory_snapshots` 按需 Copy-on-Write 捕获当夜最早基线、自动清理 7 个睡眠日前快照并支持局部同步 `rollbackMemorySnapshot()` / `POST /api/observatory/rollback-snapshot`。
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
12. **Horon 吸收 Wave 5–7：书腰触发索引 + 共现转移边 + 两段式立场锚 + 指纹/L8 Warning + 归一化补丁 + `SAVEPOINT` 探针 + CoW 快照（✅ 已完成，2026-11-13）**

---

## 3. 验证结果与运行备忘（2026-11-13）

- **测试结果**：`ECHORE_DATA_DIR=~/.echore/test bun test` → **11 个测试文件、60/60 项测试（598 个断言）全绿通过**（`tests/horon-waves-5-7.test.ts` 12/12 在 `UTC` / `Asia/Shanghai` / `America/New_York` 三时区全绿）
- **类型检查**：`bun run typecheck` (`tsc --noEmit`) → **0 error**
- **服务层与仿真启动**：`ECHORE_DATA_DIR=~/.echore/test bun run serve`（默认监听 `127.0.0.1:3377`）· `ECHORE_DATA_DIR=~/.echore/test bun run simulate 4h`
- **已知问题**：`bun run test:tz` 下既有 `tests/llm-and-loop.test.ts:399` 在 `TZ=Asia/Shanghai` 会因固定 UTC 测试夹具时间戳落入 `night_owl` 跨午夜起居日而失败（与本次改动无关）；真实 embedding provider 尚未接入，Wave 5.1 向量路径端到端联调待接入后补测。
