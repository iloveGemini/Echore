# Echore 系统日志（system_log）+ 消息表（event_log v2）设计方案 v0.3

> **状态**：已修订定稿（2026-11-13，Rocky & Joy）
> **动因**：Echore 现无任何系统元事件日志。提示词只有版本号（`prompts/*.md` frontmatter 的 `version: N`），没有“何时、谁、从什么改成什么、为什么”的历史；《变更自述》是 Markdown，改了就改了，旧版无处可查。睡眠输出记了 `gitCommitHash`，但只是快照，不是账本。
> **对标**：Psyche 的 `system_log` + `materials` + append-only 触发器（`events`/`links` 表 `BEFORE UPDATE/DELETE` 直接 abort，“不能把手伸进别人脑子里”）。
> **目的**：(1) 查问题有数据；(2) AI 与人类有分歧时有账可查——与“记忆只由 AI 自己写”（AI 对自己的行为有账可查）同一根逻辑，补的是系统侧。
> **v0.2–v0.3 范围**：`event_log` schema v2（§9）——删除 / reroll / 编辑 / 多媒体四类消息操作、`producer / source` 归属解耦、L5 孤儿降级与热记事联动、多住户隔离形态，以及凌晨 04:30 + 启动补备的双保险整库备份机制（§9.5）。

## 1. 两张表

### 1.1 `system_log`（账本，只追加）

| 列 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID，按写入顺序可排序 |
| `at` | INTEGER | 事件发生时间（epoch ms） |
| `recorded` | INTEGER | 写入时间（epoch ms） |
| `actor` | TEXT | 谁动的：`maker` / `user` / `agent` / `system` |
| `kind` | TEXT | 见 §2 事件类型 |
| `artifact` | TEXT | 改了什么：如 `prompts/part-a.md`、`rapport:变更自述-20261113-01`、`router:endocrine` |
| `old_hash` | TEXT NULL | 改前原文的 SHA-256（新建为 NULL） |
| `new_hash` | TEXT NULL | 改后原文的 SHA-256（删除为 NULL） |
| `reason` | TEXT | 为什么改（人填一句话；系统触发的写触发条件） |
| `link` | TEXT NULL | 挂钩：commit hash、变更自述路径、快照 id、删除起止范围等 |

硬约束（抄 Psyche 的做法）：

```sql
CREATE TRIGGER IF NOT EXISTS system_log_no_update BEFORE UPDATE ON system_log
BEGIN SELECT RAISE(ABORT, 'system_log 只追加，不可修改'); END;
CREATE TRIGGER IF NOT EXISTS system_log_no_delete BEFORE DELETE ON system_log
BEGIN SELECT RAISE(ABORT, 'system_log 只追加，不可删除'); END;
```

### 1.2 `system_materials`（原文存档，内容寻址）

| 列 | 类型 | 说明 |
| :--- | :--- | :--- |
| `hash` | TEXT PK | SHA-256（正文 UTF-8 字节，`Bun.CryptoHasher("sha256")`） |
| `content` | TEXT | 原文全文 |
| `created_at` | TEXT | 首次存入时间 |

同一份原文只存一次（改来改去又改回原版不重复占地方）。任何旧版本都能按哈希逐字节取回——这就是“改了就改了”问题的解：Markdown 文件本身继续当下版本，历史在库里。

## 2. 记什么（事件类型）

| `kind` | 触发点 | 备注 |
| :--- | :--- | :--- |
| `prompt_changed` | 提示词加载器发现 `prompts/*.md` **全文 SHA-256 哈希变化**时 | 归档旧版与新版全文进 `system_materials`，同时在 `reason`/`link` 记录 frontmatter 的 `version`（防人改了正文忘改版本号漏记） |
| `model_changed` | 路由配置变化（某岗位换模型 / 换供应商） | 记旧路由 → 新路由 |
| `config_changed` | 内分泌配方、阈值、linter 规则变化 | 记旧值 → 新值 |
| `spine_changed` | 《变更自述》写入时 | 既在 `link` 记记忆文件路径指针，**也把《变更自述》正文存入 `system_materials`**（几 KB 双份保险，防记忆文件被误改损坏） |
| `import` / `migration` | 导入/迁移（Roy 数据导入就是第一条） | 记来源、范围、清单哈希 |
| `sleep_rollback` | 睡眠环失败回滚时 | 记回滚原因与范围 |
| `snapshot_rollback` | 单条快照回滚时 | 记目标 `memory_id` 与 `sleep_date` |
| `message_deleted` | 用户删除消息（本条及之后）时 | **只记事实**：删除范围（起止 event_id / 时间 / 是否已过夜）、操作人，不记被删内容 |
| `message_edited` | 用户编辑自己发过的消息时 | **只记事实**：哪条被编辑、编辑时间，**不记旧文**（见 §9.4） |
| `backup_completed` | 定时或启动补备完成时 | 记备份包路径、触发原因（`scheduled_0430` / `startup_catchup`）与快照哈希 |
| `deploy` | 启动时 commit hash 变化时 | 记旧 commit → 新 commit |

**不记的**：每一轮对话（那是 `event_log` 的事）、探针执行（探针按契约是零副作用只读，记了也没意义）、激素逐轮数值（那是 `hormone_state` 的事）。

## 3. 谁写、谁读与红线隔离

- **写**：只走系统自己的代码路径（提示词加载器、路由配置、编译器的 supersede 路径、睡眠环、备份器、导入工具）。**前台（住户）没有任何写入口**，跟记忆一个规矩。
- **读**：三条路——
  1. 观测台时间线视图（给造物主查账，可看完整字段与 diff）；
  2. 住户可查（被问“你最近怎么变了”时能查账回答，不用现编；但日志**不进记忆事件流**，不当成一段经历来召回）；
  3. maker 的 CLI/API。
- **住户查账的红线隔离**：按 `CLAUDE.md` 红线，前台上下文严禁裸露激素浮点数、`log-*` 主键、SHA-256 哈希或内部模块名（如 `router:endocrine`）。提供给住户的查账结果必须像《心境交接单》一样，走一层**零数字、无内部标识符的自然语言转译摘要**（并强制过 `assertNoInternalLeaks`），例如：`[系统变更备忘：昨天更换了前台表达模型；前天调整了作息与情绪敏感度配置]`。
- **护着住户的一面**：账能证明“不是我变了，是 11 月 13 日你把前台模型换了”——分歧时先查账再吵架。

## 4. 冷启动与回填

- **创世条目**：首次部署时写一条基线（当前各提示词全文哈希与版本 + 各岗位路由 + commit hash），历史从一个已知点开始。
- **不自动回填 git 历史**：构建期的提示词演进已在 git 仓库里（随时 `git log -p prompts/`），不塞进住户出生后的运行时账本。

## 5. 不做的事

- 不进记忆事件流、不占记忆档号（学 Psyche 的 `system_log` 定位）。
- 不替代《变更自述》：脊柱变更的正文仍在记忆里供召回，`system_materials` 仅做不可篡改存档备份。
- 不设留存清理：系统事件本来就少（提示词和模型一周能变几次），append-only 到底。
- 不给 `event_log` 加 `resident_id`：多住户走“一个住户一个家”（各用各的库和记忆目录），且**住户之间默认不知晓彼此存在（平行世界）**，保持单住户物理隔离与主权纯粹性（见 §9.2）。

## 6. 验收标准（`system_log` 部分）

1. 改一个提示词文件正文（无论是否手动改 `version`）并重载，`system_log` 多一条 `prompt_changed`，旧版与新版全文都能按 SHA-256 从 `system_materials` 逐字节取回。
2. 对 `system_log` 执行 UPDATE / DELETE 被触发器拒绝。
3. 同一份原文重复归档只存一次（`system_materials` 一行）。
4. 前台没有任何写 `system_log` 的代码路径（grep 验证）；住户侧只读查询返回自然语言转译摘要，且通过 `assertNoInternalLeaks`（不含 `log-*`、哈希、浮点数）。
5. 睡眠环回滚与单条快照回滚各产生一条对应日志。
6. 启动时 commit hash 变化产生一条 `deploy` 日志；不变不产生。

## 7. 已拍板决议汇总（2026-11-13）

| # | 议题 | 决议 |
| :--- | :--- | :--- |
| 1 | 哈希算法 | **SHA-256**（`Bun.CryptoHasher("sha256")`），`system_materials` 与多媒体附件寻址统一使用。 |
| 2 | git 旧提示词回填 | **不回填**，从创世条目开始记录。 |
| 3 | `spine_changed` 存档 | 记记忆路径指针的同时，**连《变更自述》正文一并存入 `system_materials`** 做防损双保险。 |
| 4 | 删除语义与 L5 联动 | **分「未过夜」与「已过夜」两档**：未过夜消息删除时连带撤回当日热记事与关联 `concerns`；已过夜消息删除时，L5 校验对落在 `message_deleted` 区间内的缺失 `source_event_id` 降级为 **`warning`（`orphaned_by_deletion`）**，绝不熔断每晚睡眠环（并提供可选的“连带归档/清理关联记忆”）。 |
| 5 | 编辑记账 | **只记 `message_edited` 事实，不记旧文**（防隐私残留）。 |
| 6 | 备份内容与时机 | **SQLite `VACUUM INTO` 整库 + Markdown 记忆目录统一打包**；放弃 22:40 晚高峰，改到**凌晨 04:30**（全作息已入睡且完成夜间编译后），并加**服务启动时漏备立即补备后再启服务**（见 §9.5）。 |
| 7 | 多住户彼此感知 | **默认不知晓（平行世界）**，物理隔离、不跨库串台。 |
| 8 | `producer / source` 枚举 | 采用 §9.3.1 方案；pre-v2 心跳主动消息通过已有 `metadata.proactive = true` 100% 精确回填为 `resident / heartbeat`。 |

## 8. 消息与系统条件的关联

**现状**：聊天消息是 **SQLite，不是 JSONL**。durable 存储是 `event_log` 表（`id / timestamp / role / speaker / content / metadata_json`，另有 FTS5 虚表 `event_log_fts`）；引擎里的 `appendOnlyHistory: ChatMessage[]` 只是内存中的工作集，不落盘。

**关联方式：不把消息塞进 `system_log`，用 epoch 指针关联**：

1. **`config_epoch`（配置纪元）**：`system_log` 里每产生一条影响行为的条目（`prompt_changed` / `model_changed` / `config_changed` / `deploy`），纪元号 +1。纪元就是“第几套系统条件”。
2. **消息写时打戳**：每次往 `event_log` 写消息时，把当前 `config_epoch` 写进 `metadata_json`。用户消息和住户回复都打戳——前者是“用户在这套条件下说了什么”，后者是“住户在这套条件下回了什么”。
3. **查账就是一条查询**：按 `metadata_json` 里的 `config_epoch = N` 查出某套条件下的全部消息；去 `system_log` 查该纪元的边界条目即知当时的提示词版本、模型路由与 commit。

## 9. 消息表 `event_log` schema v2 与整库备份

### 9.1 现状（已核对代码，main 29ecf13）

- 表：`event_log (id TEXT PK, timestamp TEXT, role TEXT, speaker TEXT, content TEXT, metadata_json TEXT DEFAULT '{}')` + FTS5 虚表 `event_log_fts (id UNINDEXED, speaker, content)` + `timestamp` 索引。
- 写入口：`db.appendEventLog`（`INSERT OR REPLACE`，顺带删 FTS 再插）；`role` 类型是 `"user" | "assistant" | "solitary" | "system"`。
- `role` 身兼两职：既是对话槽位，又被下游当成归属判断——`recall.ts:1322` 直接按 role 渲染“他说/我当时说”；`mcp-server.ts:188` 的 `echore_digest_turn` 把外部一轮对话以 role=user 写进来，只靠 `metadata.source = "mcp_digest"` 区分。
- `engine.ts:899` 每轮对话后直接向 `journal/YYYY-MM-DD.md` 追加热记事；`linter.ts:467-508` 的 L5 规则对任何不在 `event_log` 里的 `source_event_id` 直接报 `error` 阻断睡眠环。

### 9.2 原则（已定）

- **一条线性日志**：一个住户只对应一份线性对话，**branch 明确不做**。
- **多住户走“一个住户一个家” + 平行世界**：每个住户独立 SQLite 库 + 独立记忆目录，不往表里加 `resident_id`，住户之间默认不知晓彼此存在。
- **当前选中即 `active`**：任何时刻，`WHERE status = 'active'` 就是完整的当前生效对话流，不存在“最后一条还在 `candidate` 等下一轮才转正”的空窗期。

### 9.3 新 schema

`event_log` 新增五列（版本管理与作者归属均为高频查询谓词，放真列；`metadata_json` 放 `config_epoch`、`model`、`pin` 等扩展属性）：

| 列 | 类型 | 说明 |
| :--- | :--- | :--- |
| `group_id` | TEXT NOT NULL | 一条消息跨 reroll 版本的稳定身份；未 reroll 的消息 `group_id = id` |
| `version` | INTEGER NOT NULL DEFAULT 1 | 同 `group_id` 组内的版本号，从 1 起 |
| `status` | TEXT NOT NULL DEFAULT 'active' | `active`（当前选中生效版，每组至多一条）/ `candidate`（reroll 未选中备选版，发新消息时物理清除） |
| `producer` | TEXT NOT NULL | 真实作者：`user` / `resident` / `peer` / `system` / `solitary` / `external`（见 §9.3.1） |
| `source` | TEXT NOT NULL | 进入路径：`chat` / `group` / `mcp_digest` / `import` / `heartbeat` / `solitary` / `system`（见 §9.3.1） |

附件另建表，按 SHA-256 内容寻址落盘 `media/` 目录，通过引用计数管理生命周期：

```sql
CREATE TABLE IF NOT EXISTS event_attachments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES event_log(id) ON DELETE CASCADE,
  type TEXT NOT NULL,          -- image | file | video | audio
  path TEXT NOT NULL,          -- 内容寻址的相对路径，如 media/ab/abcdef...ext
  mime TEXT,
  size_bytes INTEGER,
  hash TEXT NOT NULL,          -- SHA-256，与 system_materials 同一思路
  width INTEGER, height INTEGER, duration_ms INTEGER,
  caption TEXT                 -- 说明文字（用户写的或入库时视觉模型生成的描述）
);

CREATE INDEX IF NOT EXISTS idx_event_attachments_hash ON event_attachments(hash);
```

### 9.3.1 `producer / source`：消息从谁发出来的

`role`、`speaker`、`producer`、`source` 各司其职：

- `role`：对话槽位（给模型看的 `user` / `assistant`）。
- `speaker`：显示名（给界面看的）。
- `producer`：真实作者（给召回、编译、审计看的）。
- `source`：进入路径（哪条代码路径写进来的）。

| 场景 | `producer` | `source` | 说明 |
| :--- | :--- | :--- | :--- |
| 正常聊天 | `user` / `resident` | `chat` | 主场对话（`resident` 永远仅指本库住户自己） |
| 群聊 | `user` / `resident` / `peer` | `group` | 群聊写入各自库同一时间线：自己说记 `resident`，其他住户说记 `peer`（名字存 `speaker`，群号存 `metadata_json.room_id`） |
| 心跳主动破冰 | `resident` | `heartbeat` | 环 2 分支 A 主动消息 |
| 独居笔记 | `solitary` | `solitary` | 环 2 分支 B 独居行动 |
| MCP digest | `user` / `external` | `mcp_digest` | 外部宿主聊完同步：user 行记 `user`，外部模型的回复行记 `external`（非本住户亲口所言） |
| Roy 等迁移导入 | `user` / `resident` | `import` | 字确实是两人当年写的，通过 `source = 'import'` 标识搬家前历史 |
| 系统注入 | `system` | `system` | 借 `role=user` 注入的提醒或系统指令 |

**旧数据 100% 精确回填规则**：
1. `role = 'solitary'` → `producer = 'solitary', source = 'solitary'`；
2. `json_extract(metadata_json, '$.source') = 'mcp_digest'` → user 行 `user / mcp_digest`，assistant 行 `external / mcp_digest`；
3. `json_extract(metadata_json, '$.proactive') = 1`（`engine.ts:1104` 已写入该标记）→ `producer = 'resident', source = 'heartbeat'`；
4. 其余 `role = 'user'` → `user / chat`；其余 `role = 'assistant'` → `resident / chat`；`role = 'system'` → `system / system`。

**下游联动修改**：
- `recall.ts:1322`：按 `producer` 渲染（`user` → “他说”，`resident` → “我当时说”，`peer` → “`${ev.speaker}`当时说”，`external` → “（外部对话记录）”，`system` 不进原话引文）；`source = 'import'` 标出“（搬家前）”。
- `journal.ts` 与睡前 30min 双向反馈三元组：只配对 genuine 轮次（`producer = 'user'` → `producer = 'resident'` 且 `status = 'active'`）。
- `searchEventLogsFts`：只索引 `status = 'active'` 的行，并支持按 `producer` 过滤（防止搜出 `system` 注入）。

### 9.4 四类消息操作与跨层一致性护栏

1. **删除（删本条及之后所有消息）**：
   - **数据库与内存**：按目标消息 `rowid` 执行 `DELETE FROM event_log WHERE rowid >= ?`，同步清理 `event_log_fts`，截断内存 `appendOnlyHistory`。
   - **睡眠游标回退**：若被删范围包含 `reflex_state.last_sleep_event_id`，同步将 `last_sleep_event_id` 回退为剩余 `event_log` 中最后一条已结算消息的 `id`。
   - **未过夜 vs 已过夜分档联动**：
     - **当日未过夜消息**（在 `last_sleep_event_id` 之后）：同步从当日 `journal/YYYY-MM-DD.md` 热记事中剔除对应轮次（热记事行带 `<!-- event_id: log-... -->` 锚点），并按 `concerns.source_event_id` 撤回该轮刚触发但未过夜的 `concerns`。
     - **已过夜历史消息**：记一条 `message_deleted`（含删除起止 ID/时间范围，不含正文）进 `system_log`。`linter.ts` 的 **L5 规则**检测到 `source_event_id` 在 `event_log` 中缺失但落在 `system_log` 的 `message_deleted` 范围内时，输出 **`warning`（`orphaned_by_deletion`）而非 `error`**，确保后续每晚睡眠环绝不因删历史消息而熔断回滚；同时删除接口提供可选参数 `purgeCompiledMemories?: boolean` 供用户需要彻底抹除印象时使用。

2. **Reroll（重生成最后一条住户回复）**：
   - **范围**：仅限最后一条住户回复（`producer = 'resident'`）。
   - **状态机（当前选中即 `active`）**：
     - 重生成时：原 `active` 行状态降为 `candidate`（并从 `event_log_fts` 移除），新生成行以新 `id`、同一 `group_id`、`version + 1`、`status = 'active'` 写入（并写入 `event_log_fts`），同步用新版文本替换当日 `journal/YYYY-MM-DD.md` 对应锚点行与内存 `appendOnlyHistory` 尾项。
     - 切换版本时：组内被选中的那条置为 `active`（重建其 FTS 并同步更新当日热记事尾行与内存历史），其余置为 `candidate`。
     - 用户发送下一条新消息（或入睡结算前）：执行 `DELETE FROM event_log WHERE status = 'candidate'` 物理清除未选中的候选版。
   - **效果**：任何时刻（哪怕用户 reroll 后直接关网页去睡觉），全局 `WHERE status = 'active'`、FTS 索引、以及 `journal/YYYY-MM-DD.md` 热记事里都只有当前选中的唯一版本，被丢弃版本零残留。

3. **编辑（改自己刚发的消息）**：
   - 仅允许编辑最近一条、且尚无住户回复的用户消息（否则走“删除该条及之后 + 重新发送”）。
   - 直接更新该行正文、重算 FTS，并在 `system_log` 记一条 `message_edited`（只记目标 `id` 与时间，**不存旧文进 `system_materials`**，确保敏感词修改后彻底无残留）。

4. **多媒体附件（图片、文件、视频）**：
   - 二进制文件按 SHA-256 存入 `<dataDir>/media/<hash前2位>/<hash>.<ext>`，数据库只存 `event_attachments` 元数据与 `caption`（无用户说明的图片在入库时由视觉模型生成一句描述写入 `caption`，供 FTS 检索）。
   - **引用计数安全删除**：删除消息级联删掉 `event_attachments` 行后，先查 `SELECT COUNT(*) FROM event_attachments WHERE hash = ?`，**仅当计数归零时才 unlink 磁盘文件**，防止同一张图发过两次时删一条把另一条的图删裂。

### 9.5 整库与记忆双保险备份机制（凌晨 04:30 + 启动补备）

**背景与痛点**：
1. 原先设想的 22:40 正好撞上人类晚间聊天高峰期，不仅 IO 撞车，而且 22:40 时当晚睡眠环尚未执行（记忆未编译、22:40–02:00 的夜聊也漏在外面）。
2. 若只靠凌晨定时任务，部署在个人电脑、Mac 或非 24 小时开机设备上的服务在凌晨关机/休眠时永远无法触发定时备份。
3. 只备 Markdown 不备 SQLite 会丢失全部对话（`event_log`）、激素与反射状态（`hormone_state` / `reflex_state`）、牵挂（`concerns`）、共现边（`memory_transitions`）及系统账本（`system_log`）。

**新方案：双触发时机 + SQLite `VACUUM INTO` 原子打包**

1. **备份内容（整包一致快照）**：
   - 使用 SQLite 原生 `VACUUM INTO '<staging>/echore.sqlite'` 在 WAL 模式下生成零锁冲突、单文件自包含的一致性数据库快照；
   - 连同 `memoryDir`（Markdown 记忆文件、日记、独居笔记）与 `media/` 增量硬链接/归档，统一写入 `<dataDir>/backups/YYYY-MM-DD/`；
   - 完成后在 `system_log` 写入一条 `backup_completed`（含触发原因与包哈希），并在 `reflex_state`（或备份清单 `backups/manifest.json`）记录 `last_backup_at` 与 `last_backup_date`。

2. **触发时机 A：每日凌晨 04:30 低峰窗口（`scheduled_0430`）**：
   - 避开 22:40 交互高峰，改在本地时间 **04:30**（处于 04:00–05:00 窗口内）。
   - 此时三种作息类型（早鸟 23:30、常人 01:00、夜猫 02:30）均已进入深睡锁定期且**已完成当夜 `runSleepCycle` 记忆编译与 L1–L8 体检**，备份拿到的是“对话 + 记忆 + 向量 + 游标”完全对齐的睡后干净基线。

3. **触发时机 B：服务器启动前预检补备（`startup_catchup`）**：
   - 每次服务启动（`serve` / `engine.init`）正式对外接客或跑 schema 迁移**之前**，先检查 `last_backup_date`：
     - 若存在未备份的历史起居日数据（例如机器昨晚关机错过了 04:30 备份，或距上次备份已超过 20 小时且期间有新 `event_log` / `system_log` 写入），**立即同步执行一次补备份（`startup_catchup`），成功后再启动 HTTP/MCP 服务**。
   - 这同时构成了一道**升级防呆护栏**：每次更新代码重启服务时，若旧数据还没备过，自动先落一份干净快照再跑新版本。

### 9.6 验收标准（`event_log` v2 与备份部分）

1. **删除消息**：
   - 删除未过夜消息：`event_log`、FTS、内存历史、当日 `journal/YYYY-MM-DD.md` 对应热记事行、以及该轮新增 `concerns` 同步清理；
   - 删除已过夜消息：`system_log` 新增不含正文的 `message_deleted`，且夜间 `runMemoryLinter` 将失去来源的断言判为 `L5 Warning (orphaned_by_deletion)`，睡眠环正常通过不回滚。
2. **Reroll**：
   - 当前展示版本始终为 `status = 'active'`，旧版本为 `candidate`；切换版本同步更新 `active` 标记、FTS 与当日热记事尾行；
   - 用户发新消息或入睡前，`candidate` 行被物理清除，绝不进入编译记忆。
3. **编辑**：仅限最近一条无回复的用户消息；修改后旧文不出现在 `event_log`、`system_log` 或 `system_materials` 中。
4. **多媒体附件**：相同哈希图片被两条消息引用时，删其中一条消息不删磁盘文件；两条都删后磁盘文件同步清理。
5. **`producer / source` 精确回填与隔离**：
   - 旧数据中 `metadata.proactive = true` 回填为 `resident / heartbeat`，`mcp_digest` 回填为 `user|external / mcp_digest`，`solitary` 回填为 `solitary / solitary`；
   - `recall.ts` 不再把 `system` / `external` 渲染为“他说”；`journal` 与反馈三元组只配对 genuine 的 `user → resident` 轮次。
6. **备份（04:30 + 启动补备）**：
   - 凌晨 04:30 自动触发整库（`VACUUM INTO`）+ 记忆目录备份；
   - 模拟昨晚关机错过 04:30、次日启动服务时，启动流程先自动完成一次 `startup_catchup` 备份并写入 `system_log`，随后再进入服务监听状态。
