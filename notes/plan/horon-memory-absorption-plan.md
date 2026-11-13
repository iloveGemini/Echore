# Echore 记忆系统进化方案二期：Horon 机制吸收计划（Wave 5 – Wave 7 · v2 审阅修订版）

> **状态**：v2.1 定稿（2026-11-13，已解决 `HORON-ABSORPTION-REVIEW-V2-20261113.md` 全部 4 项遗留收尾项）
> **前置基座**：
> - **Echore 现行实现**：[`notes/design/architecture-and-memory-spec.md`](../design/architecture-and-memory-spec.md)（v1.4）· [`notes/plan/memory-absorption-plan.md`](memory-absorption-plan.md)（Wave 1–4 已落地）· `src/hippocampus/{recall,compiler,decay,linter,pre-hydrator}.ts` · `src/core/{db,schemas}.ts` · `src/loop/engine.ts`
> - **Horon 对照基座**（`Dataojitori/horon`，`Apache-2.0 + 附加署名条件`）：借用其认知/检索**结构形状**（触发书腰、共现转移衰减、两段门控、指纹审计、`SAVEPOINT` 探针、最早基线快照、位置映射补丁），针对 Echore 的陪伴对象（LLM 编译记忆、被动召回批次、用户输入）做本土化独立实现。

---

## 0. 核心边界与审阅修正对账单（v1 → v2）

### 0.1 许可证洁净室与工程卫生红线
1. **洁净室独立实现**：Horon 采用 `Apache-2.0` 附加对外产品署名条款（`LICENSE` 头部 + `NOTICE`），而 Echore 为纯 `MIT`。**严禁复制或逐行翻译 Horon 任何源码，字符映射表等功能性常量亦按 Unicode 标准独立编写**。
2. **器官隔离红线**：不引入前台 CLI 记忆读写工具、不向陪伴前台注入 `Circuit: AND(...)` 电路状态码、不引入动态脚本沙盒插件。

### 0.2 审阅意见修正对账单（v1 → v2）

| 审阅项 | v1 草案问题 | v2 修正方案 |
| :--- | :--- | :--- |
| **1. Wave 5.2 常数与信号源说明** | 误把改编后的 `0.25` 步长与 `1.0` 封顶当成 Horon 原样（Horon 实为显式 `read_concept`、步长 `0.8`、无封顶） | 明确区分 Horon（显式阅读、`step=0.8`、无封顶）与 Echore 改编（30min 被动召回批次噪声更高，取 `PASSIVE_TRANSITION_STEP = 0.35`）；**去掉写入时的人为 `1.0` 硬封顶**（靠 $\gamma^{r_k}$ 自然收敛，仅在桶 C 算分时归一） |
| **2. Wave 7.1 `SAVEPOINT` 并发与边界** | ① `SAVEPOINT` 内若 `await` 异步 embedding 会吞掉并发请求的写入；② 列出的纯函数跑不出“入睡”场景；③ 漏了 `recentSessionRecalledIds` 内存态污染 | ① **硬性规定 `SAVEPOINT` 块内纯同步零 `await`**（embedding 必须在开启 `SAVEPOINT` 前算完）；② **移除“入睡”场景承诺，禁调生成式 LLM 与磁盘写入**；③ 探针禁改任何引擎内存态，验收断言内存态不变 |
| **3. Wave 6.2 L8 阻塞睡眠环风险** | L8 用含糊的“词面重合为 0”启发式且作为 Error 会触发 `runSleepCycle()` 整夜回滚；缺最小字节门槛 | ① **`LintIssue` 引入 `severity: "error" \| "warning"`，L8 降级为 `warning`（不触发睡眠环回滚）**；② 补 `< 300B`（UTF-8）与 `< 3` 条断言免检下限；③ 废除“词面重合为 0”，改为非泛化实体与 `#slot` 连通分量分裂检测，并补同事件零词面重合不误报单测 |
| **4. Wave 5.1 书腰向量路径与质量门** | 漏提 `meta.embedding` 路径；`1.20x` 加权位置不清；LLM 批量生成书腰无反泛化质量门 | ① 双路径齐备：接入 `EmbeddingProvider` 与 `OpenAICompatAdapter.embed()`，记忆编码源文本统一为 `when_to_recall ? `${when_to_recall}\n${summary}` : summary`，`when_to_recall` 变更时自动清空旧 `embedding_json` 并在睡眠环增量重算；未配置向量模型时走词法语义与 IDF 双路径；② 去掉含糊的 `1.20x`，改为显式线性组合；③ 新增**泛化套话黑名单与最小实词质量门** |
| **5. Wave 6.1 歧义预筛漏报与模型钉死** | 二段复筛前又套了一层“歧义词正则”，导致反讽/未进词表转述漏检；未指定复筛模型槽位 | ① **去掉歧义词正则预筛**（只要 `isStanceCue` 命中且启用了复筛器，每次均走二元复筛）；② 钉死走 `router.ts` 现有的 **`endocrine` 轻量快速模型槽位**（禁走 `frontstage`），`1200ms` 超时降级 |
| **6. Wave 6.3 补丁语义与补丁外字节** | 混淆了 Horon 的 `try_normalized_patch` 与 `find_patch_spans`；未防范全文前置 NFC 改写补丁外字节 | ① 注明中文引号/破折号为 Echore 独立规则；② 统一收敛为单函数 `replaceUniqueNormalizedFragment`（严格要求**唯一命中**）；③ **禁止对全文做前置 NFC 重写**，验收断言替换区间外字节 100% 不变 |
| **7. Wave 7.2 快照留存与捕获方式** | 无跨夜留存清理策略（每夜无限累积）；未写明事前全量还是 Copy-on-Write | ① 明确采用 **Copy-on-Write 按需捕获**（仅在编译器/衰减器实际写文件前记 `UNIQUE(memory_id, sleep_date)` 基线）；② 新增 **7 个睡眠日留存策略**，睡眠环尾部自动清理过期快照 |

---

## 1. 分阶段实施方案与契约变更（Wave 5 – Wave 7）

### Wave 5：检索与联想进化（触发书腰 + 隐式共现边）

#### 5.1 触发情境书腰 `when_to_recall`（`schemas.ts` · `compiler.ts` · `recall.ts` · `decay.ts`）
- **机制对照**：借用 Horon `concepts.when_to_read`（`_MAX_WHEN_TO_READ_LEN = 500`）“将触发场景与正文事实分离索引”的思想；但 Horon 节点由 Agent 手写，而 Echore 记忆由夜间编译器批量生成，因此 Echore 收紧长度上限并增加**反泛化质量门**。
- **契约改动 (`src/core/schemas.ts`)**：
  - `MemoryFrontmatterSchema` 与 `CompiledMemorySpecSchema` 新增可选字段：
    ```ts
    when_to_recall: z.string().min(6).max(120).optional(),
    ```
- **反泛化质量门 (`src/hippocampus/compiler.ts` · `sanitizeWhenToRecall`)**：
  - 编译器接收 LLM 产出的 `when_to_recall` 后执行确定性清洗：
    1. 剥离套话前缀/泛化词（`/当?(?:日常|平时|随便|普通|一般)?(?:聊天|闲聊|对话|说话|聊到生活|提到用户|任何时候|每次对话)时?/gu`）及标点空白；
    2. 若剩余有效实词字符数 `< 4`，或整句长度 `< 6` / `> 120`，判定为无效泛化书腰，**直接丢弃置为 `undefined`**（不生成保底废话，宁缺毋滥）；
    3. `writeUpdatedFrontmatter`（`decay.ts:78`）写回 YAML 时保真保留合法的 `when_to_recall`。
- **向量路径与词法打分契约 (`src/llm/` · `src/hippocampus/recall.ts` · `src/hippocampus/decay.ts` · `src/loop/engine.ts`)**：
  1. **向量路径（`EmbeddingProvider` + 增量回填 + 实时查询嵌入）**：
     - `src/llm/types.ts` 定义 `EmbeddingProvider`（`embed(texts, options): Promise<number[][]>`），`OpenAICompatAdapter` 实现 `POST ${baseURL}/embeddings`，`OrganModelRouter` 提供可选 `embedding` 槽位（支持 `ECHORE_EMBEDDING_MODEL` / `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` 或复用 `OPENAI_API_KEY`）；
     - 记忆编码源文本由 `buildMemoryEmbeddingText(file)` 统一生成为 `when_to_recall ? `${when_to_recall}\n${summary}` : summary`；`syncMemoryMetaFromFiles`（`decay.ts`）以独立的 `embedding_fingerprint`（基于 `when_to_recall` 与正文哈希）判断变更并主动清空旧 `embedding_json`（纯 `status` 变更不误清空）；
     - `hydrateMissingMemoryEmbeddings` 扫描活跃且 `embedding === undefined` 的记忆批量生成向量并写回 `memory_meta.embedding_json`（在 `runSleepCycle()` 通过 Linter 后自动增量执行，异常降级不阻断睡眠环）；
     - `EchoreEngine.onUserMessage`（非空档时与 `verifyStanceCueWithOrgan` 并行，带超时降级）与 `POST /api/observatory/what-if`（在进入 `SAVEPOINT` 前同步点外完成）自动计算 `queryEmbedding` 传入 `recallMemories`。
  2. **词法语义路径（当前默认生效路径）**：
     - 设查询与 `file.body` 的词袋余弦为 $S_{\text{body}} = \text{computeLexicalSemanticSimilarity}(\text{query}, \text{body})$；
     - 若存在 `when_to_recall`，计算书腰余弦 $S_{\text{cue}} = \text{computeLexicalSemanticSimilarity}(\text{query}, \text{when\_to\_recall})$，最终词法语义分定义为：
       $$S_{\text{sem}} = \max\bigl(S_{\text{body}},\; 0.85 \cdot S_{\text{cue}} + 0.15 \cdot S_{\text{body}}\bigr) \in [0, 1]$$
  3. **IDF 实词路径（`computeIdfKeywordScores`）**：
     - 候选文档的检索文本定义为 `when_to_recall ? `${when_to_recall}\n${file.body}` : file.body`，直接复用现有 IDF 公式计算 $S_{\text{kw}} \in [0, 1]$，不再叠加额外倍数。
  4. **前台零泄露**：`extractBodySections` 与 `formattedBlock` 绝不输出 `when_to_recall`。

#### 5.2 时序共现注意力转移边 `memory_transitions`（`db.ts` · `decay.ts` · `recall.ts` · `engine.ts`）
- **与 Horon 原型的差异说明**：
  - Horon（`backend/_db_query.py:19-21, 690-798`）追踪的是同 session 下 `cli_audit_log` 中 Agent 主动调用的 `read_concept`（显式阅读信号信噪比高，故 `_AUTO_TRANSITION_STEP = 0.8`，且权重无上限）；
  - Echore 陪伴前台不调 CLI，信号源改编为**同会话 30min 滑窗内跨轮被动召回的实质批次**（桶 B/C 命中项）。因被动召回比显式精读噪声更高，Echore 将单步增量调低为 `PASSIVE_TRANSITION_STEP = 0.35`，其余防污染拓扑（同批不互连、来源去重、回溯 3 批、$\gamma^{r_k}$ 按相关性缩放衰减、`< 0.05` 剪枝、**写入不设 `1.0` 硬封顶**）与 Horon 对齐。
- **SQLite 表结构 (`src/core/db.ts`)**：
  ```sql
  CREATE TABLE IF NOT EXISTS memory_transitions (
    from_memory_id TEXT NOT NULL,
    to_memory_id   TEXT NOT NULL,
    weight         REAL NOT NULL DEFAULT 0.0,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (from_memory_id, to_memory_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_transitions_from
    ON memory_transitions(from_memory_id, weight DESC);
  ```
- **共现转移学习 (`src/hippocampus/decay.ts` · `recordMemoryTransitions`)**：
  - **常数定义**：`TRANSITION_DECAY_GAMMA = 0.95`、`TRANSITION_PRUNE_THRESHOLD = 0.05`、`PASSIVE_TRANSITION_STEP = 0.35`、`TRANSITION_WINDOW_MS = 30 * 60 * 1000`；
  - **防污染门控**：
    1. `isIdleQuery === true` 时跳过；
    2. 仅提取当轮 `bucket === "bucket_b_topic" || bucket === "bucket_c_graph"` 的实质召回记忆 ID 列表 `currentBatchIds`（排除桶 A 固定主线）；若为空则跳过；
    3. **同批不互连 & 来源去重**：回溯内存滑窗中最近最多 3 个历史批次（相邻批次间隔 $> 30\text{min}$ 则在该处截断），已出现在 `currentBatchIds` 或更近历史批次中的 ID 不再作为旧批次的来源节点 `from_id`；
  - **更新公式**：对回溯第 $k \in \{1, 2, 3\}$ 批（$r_k = 0.5^{k-1} \in \{1.0, 0.5, 0.25\}$）的每个有效来源 `from_id`，记本轮目标批大小为 $N = \text{currentBatchIds.length}$：
    1. 衰减该源节点所有既有出边：`weight = weight * Math.pow(0.95, r_k)`；
    2. 剪枝：`DELETE FROM memory_transitions WHERE from_memory_id = ? AND weight < 0.05`；
    3. 累加新边：`new_weight = w0 + (0.35 * r_k) / N`（无硬封顶）。
- **桶 C 隐式一跳扩散 (`src/hippocampus/recall.ts`)**：
  - 对桶 A / 桶 B 选中的每个种子记忆 `seedId`，查询 `memory_transitions` 中 `weight >= 0.20` 的前 3 条出边目标；
  - 若目标处于活跃态且 `strength >= HOP1_MIN_STRENGTH (0.30)`，计算隐式图得分（此处将 `weight` 归一到 `[0, 1]` 区间参与算分）：
    $$S_{\text{trans}} = \text{strength}_{\text{target}} \times \min(1.0, \text{weight}) \times 0.70$$
    并入 `graphScores`（与显式符号边取 `Math.max`）。

---

### Wave 6：门控精度与记忆健康度（两段式二元复筛 + 指纹/L8 Warning + 唯一命中补丁）

#### 6.1 「正则初筛 + 轻量二元复筛」两段式门控（`recall.ts` · `engine.ts`）
- **与 Horon Jev 的异同说明**：
  - Horon 的 Jev 主要挂在 `tool_call / model_message / user_message` 上判输出违规或特定意图，且**每次正则初筛命中都送 Jev 复筛**（不设二道歧义正则）；
  - Echore 此处用于加固 `recall.ts` 的立场锚门控 `isStanceCue(query)`（判用户输入是否在向住户施压表态，过滤“转述同事/网友言论、反问吐槽第三方”等字面误报）。
- **两段式流水线（去除歧义词预筛）**：
  1. **Stage 0（纯正则初筛）**：执行 `isStanceCue(query)`（评价词 + 施压反问词同时命中）。未命中直接返回 `false`（日常 90%+ 轮次零开销）；
  2. **Stage 1（异步二元复筛，每次 Stage 0 命中均执行，保持 `recallMemories` 纯同步）**：
     - 当 `isStanceCue(query) === true` 时，`EchoreEngine.onUserMessage` 在调用同步的 `recallMemories` 之前执行异步二元复筛 `verifyStanceCueWithOrgan`（不再用“他说/同事”等正则做二次预筛），再将布尔结果经 `stanceCueOverride` 传入 `recallMemories`；
     - **模型路由钉死**：固定使用 `router.getRoute("endocrine")`（`DEFAULT_ORGAN_MODELS.endocrine` 轻量快速模型槽位，`maxTokens: 16`，**严禁调用 `frontstage` 主模型**），提示词外置至 `prompts/stance-cue-judge.md`，并支持外部注入测试桩 `stanceBinaryVerifier`；
     - **输入格式**：附带住户上一条回复（末尾最多 500 字）作为上文：
       ```text
       我先对用户说：「{lastAssistantReply}」
       用户接着对我说：「{userMessage}」
       （要判断的是用户接着说的这一条：用户是在针对『我』的看法/喜好发问或施压表态吗？若只是在转述或吐槽第三方，答 NO。只输出 YES 或 NO。）
       ```
     - **超时与降级**：设置 `1200ms` 超时保护；若未注入复筛器、超时或解析失败，100% 自动回退采用 Stage 0 正则结果。

#### 6.2 指纹跳过 (`audit_fingerprint`) 与 L8 跑题健康度 `Warning`（`db.ts` · `linter.ts` · `engine.ts`）
- **1. 增量指纹 (`src/core/db.ts` · `src/hippocampus/linter.ts`)**：
  - `memory_meta` 表新增列 `audit_fingerprint TEXT`（计算 `Bun.hash.crc32(`${relPath}\0${rawContent}`).toString(16).padStart(8, "0")`）与 `embedding_fingerprint TEXT`；
  - `audit_fingerprint` 仅在 `runMemoryLinter` 确认单文件无 L7 错误时落盘（L7 报错或文件经 `syncMemoryMetaFromFiles` 检测到改写时清空），确保 `incrementalOnly` 绝不跳过未体检或存在 L7 错误的脏文件。
- **2. Linter 分级机制与 L8 `Warning` 降级 (`src/hippocampus/linter.ts`)**：
  - `LintIssue` 新增字段 `severity: "error" | "warning"`（L1–L7 为 `"error"`，L8 为 `"warning"`）；
  - `LintReport.passed` 定义为 `issues.every((i) => i.severity !== "error")`——**确保 L8 Warning 仅作为观测台与编译报告的健康度读数（对齐 Horon `content_scope_audit` “是健康度读数而非硬阻断”的设计），绝不触发 `runSleepCycle()` 的睡眠环抛错回滚**。
- **3. L8 触发条件（带字节下限，废除“词面重合为 0”）**：
  - **免检门槛**：仅检查 `events/*.md` 与 `concerns/*.md` 中正文 UTF-8 字节数 $\ge 300\text{ B}$ 且共时断言条数 $\ge 3$ 的文件（小节点直接跳过）；
  - **连通分量判据**：提取每条共时断言中的 `#slot` 槽位名与非泛化实体引用（排除 `[[people/user]]` 和 `[[people/self]]`）。若单文件内各断言均带有显式 `#slot` 或非泛化实体，且它们构成 $\ge 2$ 个完全无公共实体、且属于不同一级 `#slot` 前缀的孤立子集，则记录一条 `L8 Warning (topic_drift)`（同事件多侧面断言即使词面零重合，只要共享同一事件实体或同一 `#slot` 均不报警）。

#### 6.3 唯一命中归一化位置映射补丁（`src/hippocampus/text-patch.ts` · `compiler.ts`）
- **与 Horon `text_patch.py` 的边界说明**：
  - Horon 分为 `try_normalized_patch`（唯一命中，但会前置把全文转 NFC）与 `find_patch_spans`（支持 `...` 多段）；且其映射表不含中文引号 `「」『』`；
  - Echore 独立实现 `replaceUniqueNormalizedFragment(source, targetPattern, replacement)`，专为解决 `compiler.ts:233` 中 `revises_rule_prefix` 就地收窄 `rapport.md` 时的标点/空白微差失配，并遵守两条硬约束：
    1. **补丁外字节 100% 不变**：**不对 `source` 全文做前置 NFC 替换**；逐字符扫描构造规范化串 `normStr` 与原串 UTF-16 代码单元偏移映射 `posMap: number[]`（将中英文弯直引号 `“”‘’「」『』`、全半角破折号 `—–―－` 映射为 ASCII 等价符，折叠行内连续空格并忽略行尾空白）；
    2. **严格唯一命中**：若 `targetPattern` 含单处 `...`，拆为首尾规范化锚点并在**同一行内**匹配；无论是否含 `...`，**仅当全文严格唯一命中 1 处时**，按 `posMap` 切出原串 `[origStart, origEnd)` 进行切片替换，确保替换区间外的每一个字节（含 NFD 字符或换行符）原封不动；命中 0 处或 $\ge 2$ 处均返回 `null`。

---

### Wave 7：可观测性与容错工程细节（`SAVEPOINT` 同步探针 + Copy-on-Write 基线快照）

#### 7.1 SQLite `SAVEPOINT` 零副作用同步探针（`src/loop/engine.ts` · `src/loop/http-server.ts`）
- **三项硬性安全契约（修复并发回滚与状态泄漏风险）**：
  1. **`SAVEPOINT` 内严禁任何 `await`**：探针方法签名为同步执行核心（若调用方需传 `queryEmbedding`，必须在进入 `SAVEPOINT` **之前**计算完毕作为参数传入）。从 `SAVEPOINT echore_what_if_probe` 到 `ROLLBACK TO echore_what_if_probe; RELEASE echore_what_if_probe;` 全程在单次同步调用栈内闭环完成，事件循环绝不让出控制权，彻底杜绝并发请求写入被连带回滚；
  2. **收敛探针范围（禁入睡编译、禁调 LLM、禁写磁盘 `.md`）**：
     - 探针仅支持预览**「假设此刻收到某条用户消息 / 假设静默流逝 N 分钟」**下的：激素演化值（`stepHormones`）、三桶召回列表（`recallMemories`）与《潜意识心境交接单》（`buildSubconsciousHandover`）；
     - **不包含“立刻入睡”场景**，探针内不调用任何生成式 LLM，也不触碰磁盘 `.md` 文件（避免全目录文件重写与 mtime 抖动）；
  3. **引擎内存态零污染**：探针读取 `new Set(this.recentSessionRecalledIds)` 传入 `recallMemories`，但**绝不修改** `this.recentSessionRecalledIds`、`this.recentSubstantiveRecallBatches`、`this.lastUserTurnAtMs` 或 `this.appendOnlyHistory`。

#### 7.2 Copy-on-Write 单文件基线快照与 7 日留存（`src/core/db.ts` · `src/hippocampus/compiler.ts`）
- **SQLite 表结构 (`src/core/db.ts`)**：
  ```sql
  CREATE TABLE IF NOT EXISTS memory_snapshots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sleep_date       TEXT NOT NULL,
    memory_id        TEXT NOT NULL,
    rel_path         TEXT NOT NULL,
    original_content TEXT,                  -- 新建文件前为 NULL
    is_creation      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    UNIQUE(sleep_date, memory_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_snapshots_date ON memory_snapshots(sleep_date);
  ```
- **捕获方式（Copy-on-Write 按需记录最早基线）**：
  - 不做事前全量表拷贝；仅当 `runNightlyCompiler` 或 `runDailyMemoryDecayAndArchive` 准备在磁盘新建、覆写或翻转某个 `.md` 文件前，调用 `db.captureMemorySnapshotOnWrite({ sleepDate, memoryId, relPath, currentDiskContent })`：
    - 若 `(sleep_date, memory_id)` 已存在快照，直接返回 `false`（保留当夜第一次修改前的最早基线）；
    - 若不存在，插入快照（磁盘原文件不存在则 `original_content = NULL, is_creation = 1`，否则存入原文件全文）。
- **留存清理策略（Retention = 最近 7 个睡眠日）**：
  - 在 `runSleepCycle()` 成功通过 Linter 并提交游标后，自动清理早于最近 7 个睡眠日的历史快照：
    ```sql
    DELETE FROM memory_snapshots
    WHERE sleep_date NOT IN (
      SELECT DISTINCT sleep_date FROM memory_snapshots ORDER BY sleep_date DESC LIMIT 7
    );
    ```
- **单条回滚接口**：`engine.rollbackMemorySnapshot(sleepDate, memoryId)` 读取对应快照行，若 `is_creation === 1` 则删除该 `.md` 文件与 `memory_meta` 行，否则还原 `original_content` 并调用 `syncMemoryMetaFromFiles` 局部同步，之后删除该快照行。

---

## 2. 验收标准（含审阅补充断言）

1. **Wave 5 验收**：
   - **5.1 书腰**：测试记忆正文写“脚踝拆绷带”、`when_to_recall` 写“当聊到周末爬山或剧烈运动时”，查询“周末去爬山吗”在向量路径（`EmbeddingProvider` 编码 `${when_to_recall}\n${summary}`）、词法路径与 IDF 路径下均能召回该记忆；测试纯泛化书腰（“日常闲聊时”）被 `sanitizeWhenToRecall` 过滤丢弃；测试 `when_to_recall` 绝不出现在前台 `formattedBlock` 中；测试 `embedding_fingerprint` 变更时清理旧 `embedding_json` 并由 `hydrateMissingMemoryEmbeddings` 仅重算脏条目。
   - **5.2 共现边**：测试两条无共同 `[[symbol]]` 的记忆在 30min 内跨轮先后被实质召回后，按 `PASSIVE_TRANSITION_STEP = 0.35` 建立无硬封顶转移边并在后续单独命中源记忆时由桶 C 召回目标记忆；测试空档输入与同轮共现不建边。
2. **Wave 6 验收**：
   - **6.1 两段门控**：测试每次 `isStanceCue` 命中均触发 `stanceBinaryVerifier`（无歧义词预筛漏网），转述句 `"有人说那部电影很难看，是不是很离谱"` 被复筛拦截不触发立场锚，且超时/报错时自动降级回退至正则结果。
   - **6.2 指纹与 L8 Warning**：测试未改动文件命中 `audit_fingerprint`；测试 L8 对混装两个孤立 `#slot` 的 $\ge 300\text{B}$ 文件产出 `severity: "warning"` 且 **`lintReport.passed` 仍为 `true`（绝不导致 `runSleepCycle` 抛错回滚）**；**误报回归测试**：测试同一事件下 3 条词面零重合但共享同一主体/槽位的断言不报 L8 Warning。
   - **6.3 归一化补丁**：测试 `revises_rule_prefix` 在中英文引号、破折号、多余空格及单处 `...` 锚定下唯一命中并替换目标行；**副作用回归测试**：断言被替换行以外的所有前缀/后缀字节（含特殊 Unicode 字符）在替换前后逐字节 100% 一致。
3. **Wave 7 验收**：
   - **7.1 `SAVEPOINT` 探针**：测试 `probeWhatIf` 全程同步执行后，不仅 SQLite 各表与磁盘 `.md` 逐字节不变，且 **`engine` 内存态（`recentSessionRecalledIds`、`recentSubstantiveRecallBatches`、`lastUserTurnAtMs`、`appendOnlyHistory`）在调用前后 100% 不变**。
   - **7.2 单文件基线快照**：测试 Copy-on-Write 在同一睡眠夜多次改写同一文件时仅保留最早基线；测试 `rollbackMemorySnapshot` 仅还原目标文件而不影响同夜其他编译产物；测试跨超过 7 个睡眠日后旧快照被自动清理。
