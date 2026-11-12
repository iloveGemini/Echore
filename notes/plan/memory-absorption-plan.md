# Echore 后端记忆进化方案（v2 · 经代码对账与审计修正版）

> **状态**：v2 审定版（2026-11-12，已根据跨仓代码审计修正 9 处细节与推进顺序）
> **来源对照**：
> - **Echore 现行基座**：[`notes/design/architecture-and-memory-spec.md`](../design/architecture-and-memory-spec.md)（v1.3）· `src/hippocampus/{recall,compiler,decay,linter,pre-hydrator}.ts` · `src/loop/engine.ts`
> - **LMC-5 概念参考**（注：`v0.3.0+` 为 AGPL-3.0，仅参考公开架构思想与标准算法，严禁搬运代码）：三层级联兜底、Literal 专名通道、RRF 检索通道融合、Z 式冲突待复核门、二跳图扩散、夜间快照回滚
> - **Psyche 概念与实现参考**（作者自有 MIT 仓库）：`traces.md`（回想模糊时间感 + 体感停顿）、`anchor.md`（B 立场锚防迎合顺从）、`association.md`（`isIdle` 空档短路 + IDF 实词加权 + 不应期）、`review.md` & `reading-room.md`（`prev→acts→next` 双向原话反馈链 + 默契正反例演化）

---

## 0. 核心判断与红线（含许可证洁净室红线）

### 0.1 三套系统的优势拼图
1. **Echore 已有且领先的底座（保持不动）**：
   - **四岗位器官隔离与第一人称主权**：前台写 `journal/` 原肉，记忆官唯一编译结构化 `.md`，情绪官只写 SQLite 状态表与零数字交接单；`assertNoInternalLeaks`（`src/core/schemas.ts:322`）已拦截 `log-*` 与激素浮点数泄露。
   - **动态生理内分泌调节**：4 激素双锚点指数回归、冷战期催产素天花板封顶（$\text{Cap}_{\text{ox}}$）、三级牵挂注（T1/T2/T3）与出厂前四道门。
   - **L1–L6 符号与状态拓扑 Linter**：编译期确定性机检。
2. **从 LMC-5 吸收的架构思想**：
   - **Z 式冲突待复核门**（堵住 `compiler.ts:732–776` 同槽位无条件静默覆写旧文件的漏洞）、**三层级联兜底（Curated → FTS → Raw Events → 冷归档唤醒）**、**Literal 短专名直通车**、**检索通道 RRF 融合**、**睡眠环异常回滚**。
3. **从 Psyche 吸收的陪伴质感与机制**：
   - **回想时间模糊化与体感停顿（`traces.md`）**、**立场锚（`anchor.md` B）**、**空档输入短路（`isIdle`）与 IDF 实词检索**、**基于时间窗切段的 `prev → acts → next` 双向原话反馈链与默契正反例修订**。

### 0.2 四条工程红线
1. **许可证洁净室红线（AGPL-3.0 隔离）**：LMC-5 自 `v0.3.0` 起为 AGPL-3.0 协议，而 Echore 为 MIT 协议。**严禁从 LMC-5 复制或逐行翻译任何 Python 代码**（如 `atom_quality.py`、`recall_pipeline.py` 等）；仅借用通用算法（如标准 RRF 公式）与公开概念，在 Echore 中按自身契约独立编写 TypeScript 实现，并在文档中注明设计致敬。
2. **不退回静态情绪打分**：不引入静态 Russell `(valence, arousal)` 坐标或 11 维语义驱力计分板，坚持 Echore 的 4 激素生理调节 + 三级牵挂注。
3. **不引入外部重型数据库**：坚持 `bun:sqlite` + 本地 Markdown 记忆仓（Git 版本留痕）。
4. **不破坏第一人称主权**：新增的时间标签、证据角色标签、正反例计数均只作为潜意识材料或客观元数据，绝不代写前台“我”的台词。

---

## 1. 审计修正要点（v1 → v2 对账单）

| 审计项 | v1 草案问题 | v2 修正方案 |
| :--- | :--- | :--- |
| **1. AGPL 许可证边界** | 未标注 LMC-5 `v0.3.0` 的 AGPL-3.0 传染风险 | 写入 `§0.2` 第一红线：100% 洁净室独立实现，不翻译 LMC-5 源码 |
| **2. `compiler.ts:732` 静默覆盖洞** | 误称“Protected 锁”，且低估了 `compiler.ts:732–776` 确定性无条件把同槽位旧文件翻为 `已取代` 的破坏性 | 正名为 **Z 式冲突待复核门**，并调整为 **Wave 1 最高优先级止血项**：非显式 `supersedes` 或撞上 `allow_forget: false` 时严禁自动覆盖旧文件 |
| **3. 空档短路漏改 `decay.ts`** | 只写了改 `recall.ts`，漏了再巩固在 `decay.ts:164` | 在 `RecallResult` 透出 `isIdleQuery`，在 `decay.ts` (`reconsolidateRecalledMemories`) 及 `engine.ts`/`mcp-server.ts` 短路跳过刷分 |
| **4. RRF 通道误含标量先验** | 把 `time` 和 `strength` 两个固有标量也放进 RRF 排名，与桶 A 重复计分 | **RRF 仅融合 `sem`、`kw`、`graph` 三个真正的检索通道**；`time` 与 `strength` 保持小权重线性先验项 |
| **5. 会话去重来源与重提豁免** | 未说明折中来源，且缺少“用户点名重提”豁免 | 明确标注融合自 LMC-5 会话历史与 Psyche 不应期；新增 **显式回溯词（`刚说的/再讲一遍/刚才提到`）豁免去重** |
| **6. L7 机检阈值与去重** | 拍脑袋写 `>600` 且与 `assertNoInternalLeaks` 重复 | 泄漏检查继续交给 `assertNoInternalLeaks`；L7 只管 **Markdown 断言颗粒度**（单文件断言条数与单行字数上下限） |
| **7. 双向反馈链缺 `session` 列** | `event_log` 表无 `session` 列，无法直接照搬 Psyche `sessionOf()` | 采用 **相邻消息时间差 $\le 30\text{min}$** 作为隐式对话段边界切分 `prev → acts → next`，跨 30 分钟断档不强行配对 |
| **8. 桶 C 二跳阈值 `0.70` 失真** | Echore 普通新记忆初值仅 `0.75`，衰减两天即低于 `0.70`，会导致二跳形同虚设；Hub 缺定义 | 对齐 Echore `[0.12, 0.75]` 强度区间：**`Hop 1 >= 0.30`、`Hop 2 >= 0.50`**；Hub 按 **节点度数（入度+出度 $\ge 5$）+ `people/*`** 抑制中继 |
| **9. 缺回放 Harness 与施工顺序** | 按白天→夜间排，未先堵丢数据洞，且无召回回放基准 | 改为 **按风险排序（Wave 1 止血与回滚 → Wave 2 召回卫生与时间感 → Wave 3 评测集与 RRF/二跳 → Wave 4 复盘与立场锚）** |

---

## 2. 按风险重排的四波推进计划（Wave 1 – Wave 4）

### Wave 1：止血与夜间安全底座（Z 式防误取代 + 睡眠环 Git/SQLite 原子回滚 + L7 颗粒度）

#### 1.1 Z 式冲突待复核门（修复 `src/hippocampus/compiler.ts:732–776` 静默覆盖漏洞）
- **现状漏洞**：`compiler.ts:732–776` 在 `spec.status === "有效"` 时，只要新断言的 `谓词::[[subject]]#slot` 命中现有活跃文件 `activeSlotOwners`，不管 LLM 有没有填 `spec.supersedes`、也不管旧文件是不是 `allow_forget: false` 免死金牌，都会确定性地把旧文件改为 `status: 已取代`。
- **修复规则**：
  1. **免死金牌保护**：若旧文件 `allow_forget === false`（如人物核心定义、钉子记忆、T3 留疤），即使同槽位出现新值，**绝不自动将旧文件翻为 `已取代`**。
  2. **显式取代与品类门控**：
     - 仅当新记忆显式指定了 `spec.supersedes` 指向该旧文件，或属于高频客观状态品类（`category: "health" | "schedule"`）的同槽位状态更新时，才执行自动 `supersedes` 闭环；
     - 若属于 `preference | life_event` 且未显式声明 `supersedes` 却发生同槽位值冲突：旧文件保持 `有效`，新文件中的冲突共时谓词自动改写为非排他的 **`情境表态([[subject]]#slot, "...")`**（规避 L4 硬冲突报错），同时在 `NightlyCompileResult` 中记录 `pendingConflicts` 供观测台审阅。
  3. **编译器 Prompt 四分法**：在 `compiler.ts:349` 提示词中明确要求区分：`客观事实演进（填 supersedes）` vs `一时气话` vs `反话玩笑` vs `特定情境偏好（不填 supersedes）`。

#### 1.2 睡眠环原子回滚护栏（复用 Git + SQLite 事务快照 · `src/loop/engine.ts`）
- **现状漏洞**：`engine.ts:918–969` 在跑完 Step 2（改 SQLite `concerns`）、Step 3（改磁盘 `.md`）、Step 4（衰减改 `.md` 和 `memory_meta`）之后才跑 `runMemoryLinter`；一旦 Linter 报错抛出异常，磁盘 `.md` 和 SQLite 已经处于半改写的脏状态。
- **修复规则**（零额外存储开销）：
  - 在 `runSleepCycle()` 动刀前，记录当前内存/磁盘中所有 `.md` 文件快照映射（或 Git 工作区状态）与 SQLite 关键表（`concerns`、`memory_meta`、`hormone_state`）的睡前备份；
  - 若 Step 2–4 任意环节抛错或最终 `lintReport.passed === false`，**立即在 `catch` 块中恢复磁盘 `.md` 文件快照（及清理新增脏文件）并回滚 SQLite 状态表**，保证睡眠环具备严格的原子性（All-or-Nothing）。

#### 1.3 L7 记忆颗粒度机检（`src/hippocampus/linter.ts`）
- **职责边界**：主键与浮点数泄露继续由 `assertNoInternalLeaks` 负责；L7 专管编译产物的结构颗粒度：
  - 单文件 `## 断言` 条目数上限：`> 6` 条断言报错 `L7 Error: 单文件断言过载（too_coarse），请按事件拆分`；
  - 单条断言或 `## 前台原叙` 长度边界：剥离符号引用后有效字符数 `< 4`（过短碎片）或单文件正文 `> 600` 字符（未提炼流水账）报错拦截。

---

### Wave 2：召回卫生、三层级联兜底与时间体感（`recall.ts` + `decay.ts` + `clock.ts`）

#### 2.1 空档输入短路（`isIdleQuery`）与再巩固防刷分
- **改动文件**：`src/hippocampus/recall.ts`、`src/hippocampus/decay.ts`、`src/loop/engine.ts`、`src/loop/mcp-server.ts`
- **逻辑**（参考 Psyche `surface.ts:83`）：
  - 剥离标点、Emoji 与中文语气词（`嗯哦噢喔啊呀吗呢吧哈嘛啦呗嘞哇`）后，若剩余字数 $\le 1$ 或属于固定应答词（`好的/可以/收到/知道/知道了/行的/对的/是的/没事/在的/好吧/随便/ok`），判定 `isIdleQuery = true`。
  - `isIdleQuery === true` 时：
    - `recallMemories` 仅返回桶 A（近期生活主线 $\le 2$ 条），跳过桶 B 与桶 C；
    - `reconsolidateRecalledMemories`（`decay.ts:164`）检测到 `isIdleQuery` 时直接 `return`，不增加 `access_count`，也不加 `+0.05` 强度。

#### 2.2 会话内防复读（Session Recall Dedup）与“点名重提”豁免
- **改动文件**：`src/hippocampus/recall.ts`、`src/loop/engine.ts`
- **设计**（折中融合 LMC-5 `RecallInjectionHistory` 与 Psyche `refractory`）：
  - `EchoreEngine` 维护本会话最近 3 轮已注入桶 B/C 的记忆 ID 集合 `recentSessionRecalledIds`（若相邻消息间隔 $> 2\text{h}$ 则自动清空）。
  - **显式重提豁免**：当用户消息命中回溯意图正则 `/刚(?:才)?说|再(?:讲|说)一遍|前面提|上面那|上次说/` 或命中 Literal 专名引号时，本轮禁用去重降权。
  - 正常闲聊轮次中，桶 B/C 对已在 `recentSessionRecalledIds` 中的候选施加后置/降权（乘 `0.40`），优先浮现排在第 4~8 名的新鲜相关记忆；同轮内容归一化指纹相同的条目仅占 1 个槽位。

#### 2.3 三层级联兜底 + Literal 专名通道 + `已沉底` 冷仓回血激活
- **改动文件**：`src/hippocampus/recall.ts`、`src/hippocampus/decay.ts`、`src/core/db.ts`
- **阈值对齐**：统一对齐桶 B 现成的 `0.30` 语义阈值（不另造 `0.35`）：
  1. **Stage 1（主路）**：`status: 有效 | 僵持待解` 的结构化 Markdown。
  2. **Stage 2（Literal 专名 & 当日原话兜底）**：当用户查询含引号 `「…」/"…"`、含检索触发词 `记得|说过|提到|关于`，或 Stage 1 桶 B 最高分 `< 0.30` 时，调用 `db.searchEventLogsFts(query)`（排除当前轮刚写入的消息）与当日 `journal/YYYY-MM-DD.md` 热记事，最多附带 2 条 `[当时原话线索]`。
  3. **Stage 3（`已沉底` 冷仓唤醒闭环）**：当 Stage 1 桶 B 无命中（`< 0.30`）时，扫描 `status: 已沉底` 的归档 Markdown 文件；若命中（`sem >= 0.30` 或实词精确命中），将其作为 `[翻出的旧记忆]` 召回，并在 `reconsolidateRecalledMemories` 中将其 YAML 与 SQLite `status` 恢复为 `有效`、强度重置为 `(INITIAL_MEMORY_STRENGTH + ARCHIVAL_STRENGTH_THRESHOLD) / 2`（即 `(0.75 + 0.12) / 2 = 0.435`），实现总纲 §4.4 的冷库重激活闭环。

#### 2.4 回想时刻自然粗化（`vagueWhen`）与停顿体感提示（`gapHint`）
- **改动文件**：`src/core/clock.ts`、`src/hippocampus/pre-hydrator.ts`、`src/hippocampus/recall.ts`
- **逻辑**（参考 Psyche `traces.md` §3.2）：
  - `formatVagueWhen(isoOrDate, now)`：今天按自然日 8 时段输出 `今天凌晨/早上/上午/中午/下午/傍晚/晚上/深夜`；昨天/前天输出 `昨天深夜`；7 天内输出 `MM-DD（周X）时段`；更早输出 `YYYY-MM-DD`。
  - `formatGapHint(deltaMs)`：`< 10m` 不插；`10–30m` `（过了一会儿）`；`30–60m` `（过了半个多小时）`；`≥ 60m` `（隔了约 N 小时）`；`≥ 24h` `（隔了约 N 天）`。

---

### Wave 3：召回回放评测 Harness + IDF/RRF 融合 + 二跳图扩散（`recall.ts` + `tests/`）

#### 3.1 召回回放黄金评测集（`tests/recall-replay.test.ts`）
- **目标**：不做无基准的“玄学调参”。基于测试记忆库构造 20~25 条覆盖 5 类典型场景的 Replay 夹具：
  1. 短专名/罕见词混在长句中（检验 IDF vs 旧版 `hits/qTokens` 稀释）；
  2. 低分准确语义命中 vs 高强度普通一跳邻居（检验 RRF 防图节点霸榜）；
  3. 二跳关联回忆与度数 $\ge 5$ 的 Hub 节点防泛滥；
  4. 连续 3 轮同话题追问 vs 点名重提（检验会话去重与豁免）；
  5. `已沉底` 冷门记忆被精准追问时的唤醒与回血。

#### 3.2 IDF 实词字面打分 + 三检索通道 RRF 融合
- **IDF 字面打分**：剥离日常停用词后，按候选文档集计算命中词的 $\text{IDF}(t) = \ln\bigl((N + 1) / (\text{df}(t) + 1)\bigr)$ 占比。
- **三检索通道 RRF + 标量先验**：
  - 仅对 **`sem`、`kw`、`graph` 三个真正的查询相关通道**计算加权 RRF（仅对通道得分 $> 0$ 的候选计入该通道排名，$k = 60$，通道权重 $w_{\text{sem}} = 1.0, w_{\text{kw}} = 1.0, w_{\text{graph}} = 0.8$），归一化得到检索相关性分 $S_{\text{rel}} \in [0, 1]$；
  - 最终混排分保留 `time` 与 `strength` 作为轻量先验：
    $$S_{\text{total}} = 0.80 \cdot S_{\text{rel}} + 0.10 \cdot S_{\text{time}} + 0.10 \cdot S_{\text{strength}}$$

#### 3.3 桶 C 二跳图扩散与度数 Hub 抑制
- **强度门槛（对齐 Echore `[0.12, 0.75]` 区间）**：
  - **边过滤**：仅沿共时有效谓词扩散；`历史背景 / 曾用状态` 等历时谓词边权重乘 `0.4`；
  - **Hop 1**：目标记忆 `strength >= 0.30`，图得分 $= \text{strength} \times 0.85$；
  - **Hop 2**：要求一跳中继节点不是 `people/*` 且**总度数（入度+出度）$< 5$**（非 Hub 节点），且二跳目标记忆 `strength >= 0.50`，图得分 $= \text{strength} \times 0.55$。

---

### Wave 4：睡前双向原话反馈链、`rapport.md` 正反例与双门控立场锚

#### 4.1 基于 30min 时间窗的双向原话反馈链（`prev → acts → next`）
- **改动文件**：`src/frontstage/journal.ts`、`src/hippocampus/compiler.ts`
- **切段逻辑**（解决 `event_log` 无 `session` 列问题）：
  - 扫描当日 `event_log`，当相邻两条消息时间差 $> 30\text{min}$ 时视为自然断段；
  - 在同一连续段内，机械配对「用户前一句 `prev` → 住户回复 `acts` → 用户紧接着的下一句 `next`（间隔 $\le 30\text{min}$）」，作为未美化的原始反馈证据递给睡前自省与夜间编译器。

#### 4.2 `implicit/rapport.md` 正反例验证与条件收窄
- **改动文件**：`src/hippocampus/compiler.ts`、`src/core/schemas.ts`
- **机制**：支持编译器在夜间根据 `prev → acts → next` 原话反馈，对已有 `rapport.md` 默契条目进行**条件收窄改写（`revises_rule_prefix`）**（如发现原默契在某场景下出现反例，将其适用条件收窄并更新 `[src: log-xxx]`），防止单次印象变成永久刻板偏见。

#### 4.3 双门控 B 立场锚（Stance Anchor · 防闲聊顺从）
- **改动文件**：`src/hippocampus/recall.ts`
- **双门控防误报设计**：
  1. **门控 1（用户句式 = 评价主张词 + 征询/反问词同时出现）**：要求用户消息同时命中评价词（`觉得|认为|喜欢|讨厌|烦|无聊|没意思|好看|难看|蠢`）与反问/征询词（`对吧|是不是|对不对|你说呢|怎么看|吧？|呢？`），单字面出现不触发；
  2. **门控 2（话题重叠度门槛）**：候选记忆必須同时满足 `hasStance`（`## 前台原叙` 含第一人称明确态度词或属于 `rapport.md` 边界）**且**与当前查询存在实质话题重叠（`sem > 0.30` 或 `kw > 0.25`）。
  - 同时满足双门控时，赋予立场锚加分并豁免会话去重，确保住户记得自己之前的鲜明态度。

---

## 3. 验收标准

1. **Wave 1 验收**：测试同槽位未声明 `supersedes` 时旧文件不被误杀为 `已取代`；测试睡眠环 Linter 失败时磁盘 `.md` 与 SQLite 100% 原子回滚至睡前状态。
2. **Wave 2 验收**：测试 `"嗯"` / `"好的"` 不触发桶 B/C 与 `decay.ts` 再巩固加分；测试连续同话题去重与 `"刚说的再讲一遍"` 豁免；测试 `已沉底` 记忆被追问时唤醒并回血至 `0.435`；测试 `vagueWhen` 与 `gapHint` 时间渲染。
3. **Wave 3 验收**：`tests/recall-replay.test.ts` 黄金回放集全绿，验证 IDF + RRF 相比旧版线性加权消除图节点霸榜与长句专名稀释。
4. **Wave 4 验收**：测试 30min 时间窗切段的 `prev → acts → next` 提取、默契条件收窄修订、以及双门控立场锚在施压语境下召回住户历史态度且在普通闲聊中零误报。
