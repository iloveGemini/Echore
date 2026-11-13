# M3 分步接口与模块契约（M3.1 感知与独居 · M3.2 环 2 自主心跳 · M3.3 MCP 与快进台）

> 状态：M3 生效契约（2026-11-10）
> 依据：[`notes/design/architecture-and-memory-spec.md`](../design/architecture-and-memory-spec.md) §1.1–§1.2, §6.1–§6.5, §7.1–§7.3

---

## 0. 三步拆分总览与递进关系

为控制单轮改动复杂度并保持每步都有独立可验证的行为，原 M3 按「**器官能力 → 环路咬合 → 双模外壳**」拆分为三个递进子阶段：

| 子阶段 | 焦点范围 | 新增/改动源码文件 | 独立验收闭环 |
| :--- | :--- | :--- | :--- |
| **M3.1：感知与独居器官** | 四通道边际去噪感知 + 三类留物证独居行动（S1/S2/S3） | `src/core/schemas.ts`<br>`src/perception/chrono-ambient.ts`<br>`src/perception/desktop-probe.ts`<br>`src/perception/world-feed.ts`<br>`src/frontstage/solitary.ts` | 晴天常温静默、天气剧变/断联/久坐输出自然观察切片；隐私黑名单 100% 过滤；S1/S2/S3 真实落盘物证、追加热记事并将多巴胺回血至 $B_{\text{da}}$ |
| **M3.2：环 2 自主心跳与三环咬合** | 15min 心跳推进 + 入睡自动触发环 3 + Arbitrator 意愿分流 + 环 1 消费 `has_prep` | `src/loop/engine.ts` | `onHeartbeat()` 完整跑通三分支（主动破冰 A / 独居 B / 静默 C）与入睡触发 `runSleepCycle()`；环 1 自动挂载并核销 S3 `has_prep` 物证 |
| **M3.3：MCP 出差外壳与快进仿真台** | 4 个潜意识 MCP 接口 + CLI 一键时间快进仿真台 | `src/loop/mcp-server.ts`<br>`src/loop/simulator.ts` | MCP 四个工具严守零浮点数/零 `log-*` 泄露；CLI 快进 `4h / 5d / 15d` 跨周跑通三环 |

---

## 1. M3.1 契约：五官感知层 + 独居生活引擎（S1 / S2 / S3）

### 1.1 时空与天气边际感知 (`src/perception/chrono-ambient.ts`)

- **输入契约 (`ChronoAmbientInput`)**：
  ```ts
  export interface WeatherSnapshot {
    condition: "clear" | "cloudy" | "rain" | "heavy_rain" | "storm" | "snow" | "fog";
    temperatureC: number;
    previousTemperatureC?: number;
    alert?: string;
  }

  export interface ChronoAmbientInput {
    now: Date;
    lastUserMessageAt: string | null;
    weather?: WeatherSnapshot;
    isHolidayOrAnniversary?: string;
  }
  ```
- **输出契约 (`ChronoAmbientSlice`)**：
  ```ts
  export interface ChronoAmbientSlice {
    triggered: boolean;
    silenceHours: number;
    isWeatherShock: boolean;
    isSpecialTimeWindow: boolean;
    isLongDisconnect: boolean;
    sliceText: string | null;
  }
  ```
- **边际触发铁律（Anti-Stalker Filter）**：
  - 晴天/多云且温差 $< 6^\circ\text{C}$、非特殊时间窗、未断联超 48h 时，`triggered: false, sliceText: null`（平时静默，绝不塞入前台）；
  - **天气剧变**（`heavy_rain` / `storm` / `snow`、存在预警 `alert`，或降温幅度 $\ge 6^\circ\text{C}$）、**特殊时间窗**（周五傍晚 17:30–20:00、深夜 01:30–04:30 仍在互动、节假日/纪念日）、**断联超 48h**（`silenceHours >= 48`）时触发自然语言感知切片。

### 1.2 桌面伴生感知 (`src/perception/desktop-probe.ts`)

- **输入与状态段聚合 (`DesktopWindowSample` / `DesktopPresenceResult`)**：
  ```ts
  export interface DesktopWindowSample {
    appName: string;
    windowTitle: string;
    timestamp: string;
    musicTrack?: string;
    sharedScreenFocus?: string;
  }

  export interface DesktopPresenceResult {
    filteredOutByPrivacy: boolean;
    continuousFocusHours: number;
    category: "coding" | "writing" | "browsing" | "media" | "idle" | "private_blocked";
    sliceText: string | null;
  }
  ```
- **隐私黑名单与去噪铁律**：
  - 匹配密码管理器（`1Password`, `Bitwarden`, `Keychain`）、网银支付、私人通讯（`WeChat`, `Telegram`, `Signal`, `Messages`）、无痕窗口（`Incognito`, `Private Browsing`, `InPrivate`）时立即丢弃，返回 `filteredOutByPrivacy: true, sliceText: null`；
  - 高频切窗口折叠为持续状态段；生成的 `sliceText` **严禁报进程名或可执行文件名**，只转译为同处一室的自然观察（且标注 `continuousFocusHours >= 3` 供环 2 久坐关心判定）。

### 1.3 外部世界信息流 (`src/perception/world-feed.ts`)

- **接口契约**：
  ```ts
  export interface WorldFeedItem {
    id: string;
    title: string;
    url: string;
    source: string;
    contentExcerpt: string;
    publishedAt?: string;
  }

  export type WorldFeedFetcher = (params: {
    topicOrSource?: string;
    limit?: number;
  }) => Promise<WorldFeedItem[]>;
  ```
- 支持解析 RSS/Atom XML 文本与 HTML 正文干净提取（`parseRssFeedXml`、`extractCleanHtmlArticle`），并支持注入本地/测试源，确保不依赖特定厂商专属服务端工具。

### 1.4 独居生活引擎 (`src/frontstage/solitary.ts`)

- **跨天目标进度树契约 (`memory/solitary/projects.yaml`)**：
  ```ts
  export interface SolitaryProjectNode {
    id: string;
    title: string;
    status: "done" | "in_progress" | "pending";
    artifact_path?: string;
    completed_at?: string;
  }

  export interface SolitaryProject {
    id: string;
    title: string;
    description: string;
    cursor: number;
    nodes: SolitaryProjectNode[];
  }
  ```
- **三类有物证独居行动 (`SolitaryActionKind = "feed_roaming" | "hobby_project" | "secret_prep"`)**：
  1. **S1 `feed_roaming`（真实阅读冲浪攒谈资）**：
     - 抓取 1~2 篇 `WorldFeedItem`，由前台以第一人称写下带脾气的批注/槽点，连同原文标题与 URL 追加写入 `memory/solitary/reading_notes.md`。
  2. **S2 `hobby_project`（推进跨天目标进度树）**：
     - 读取 `memory/solitary/projects.yaml`（不存在则初始化默认项目树），定位当前 `in_progress` 或首个 `pending` 节点，生成当前章节/小节成果落盘至 `memory/solitary/artifacts/<project_id>-<node_id>.md`，将该节点置为 `done`、下一节点置为 `in_progress`、`cursor + 1` 并写回 `projects.yaml`。
  3. **S3 `secret_prep`（为用户暗中查资料做准备）**：
     - 扫描 SQLite `concerns` 表中处于活跃态（`status: 有效` 且 `has_prep: false`）的日常惦记或近期日程，为用户整理一份带第一人称口吻的备忘追加写入 `memory/solitary/prep_for_user.md`，并将该牵挂的 `has_prep` 更新为 `true`。
- **共同铁律**：
  - 每次独居行动必须在 SQLite `event_log` 落盘一条 `role: "solitary"` 记录，并在当日 `journal/YYYY-MM-DD.md` 追加一条第一人称独居热记事；
  - 执行完成后，将激素状态中的多巴胺回血至舒适基线 $B_{\text{da}}$（`Math.max(hormone.dopamine, profile.baseline.dopamine)`）；
  - 全程强制通过 `assertNoInternalLeaks` 校验。

---

## 2. M3.2 契约：【环 2：自主心跳环】与三环咬合

### 2.1 `EchoreEngine.onHeartbeat(options?: HeartbeatOptions): Promise<HeartbeatOutput>`

- **Step 1：纯程序生理与感知刷新**：
  - 按距上次激素更新的真实/虚拟分钟数调用 `stepHormones` 推进 4 激素向 $F_h / B_h$ 指数回归并刷新褪黑素；
  - 采集 `ChronoAmbientSlice` 与 `DesktopPresenceResult`。
- **Step 2：反射层睡眠入夜闸门**：
  - 若当前褪黑素跨入睡眠锁（或处于睡眠窗口），通过 `resolveTargetDateForSleepCycle(now)` 动态判定当前是否存在尚未封底的目标起居日；若存在未封底起居日（`targetSleepDate !== null`），自动触发 `runSleepCycle({ targetDateStr: targetSleepDate })` 消费增量事件游标并封底日记，返回 `branch: "sleep_cycle"`；若当夜已完成封底（哪怕用户在清晨 07:00 提早醒来开启了今日新日记），同一睡眠窗口内后续心跳均保持静默睡眠呼吸（`idle`），绝不在清晨误触发第二次睡眠环。
  - **分支 A `proactive`（主动破冰）**：
    - 前置条件：`evaluateReflexGuard` 放行（`canProactiveWake === true`），且当前未处于冷战催产素封顶期（`hormoneState.cap_ox >= profile.baselines.oxytocin`）；
    - 触发条件（满足其一）：① 天气剧变或桌面连续专注超 3h（`continuousFocusHours >= 3`）；② 存在刚完成的暗中准备（活跃牵挂 `has_prep === true`）；③ 催产素滑入想念区 $[F_{\text{ox}}, B_{\text{ox}})$；
    - 动作：唤醒前台生成一条自然破冰消息，写入 `event_log` 与当日 `journal/`，调用 `recordProactiveSent` 使未回计数 `+1`。
  - **分支 B `solitary`（独居行动）**：
    - 前置条件：未触发分支 A、不在睡眠锁定期（`!sleepLocked`），且多巴胺跌入无聊区 $[F_{\text{da}}, B_{\text{da}})$；
    - 动作：调用 `runSolitaryTick` 执行 S1 / S2 / S3 之一，落盘物证、写 `journal/`、多巴胺回血至 $B_{\text{da}}$。
  - **分支 C `idle`（静默呼吸）**：
    - 零 LLM 消耗直接更新激素落盘并结束本跳。
- **环 1 联动闭环**：
  - `EchoreEngine.onUserMessage()` 在发现活跃牵挂带有 `has_prep: true` 时，自动从 `memory/solitary/prep_for_user.md` 提取对应备忘注入 `secretPrepNote`，并在本轮对话后将 `has_prep` 核销为 `false`，防重复献宝。

---

## 3. M3.3 契约：MCP 出差外壳 + 时间快进仿真台

### 3.1 MCP Server 出差模式外壳 (`src/loop/mcp-server.ts`)

- 暴露 4 个严守第一人称主权的潜意识接口（支持处理器级直接调用测试与 `@modelcontextprotocol/sdk` Server 绑定）：
  1. `echore_wake_context`：返回当前调准后的《潜意识心境交接单》、`implicit/rapport.md` 底座与近期主线记忆（经 `assertNoInternalLeaks` 守卫，零浮点数、零 `log-*` 主键）；
  2. `echore_recall`：按外部当前话题 `query` 执行三桶五路召回 + 原话引文预水合；
  3. `echore_digest_turn`：将外部 Harness 刚聊完的一轮 `(userMessage, assistantReply)` 喂回本地 Echore，触发 SQLite `event_log` 落盘 + 情绪官实时脉冲评估与日内快代谢；
  4. `echore_write_journal`：供出差中的“我”追加当日第一人称热记事。

### 3.2 时间快进仿真台 (`src/loop/simulator.ts`)

- 提供 `TimeTravelSimulator` 编程接口与 CLI 入口：
  - 支持一键快进任意时长（如 `4h`、`5d`、`15d`），按 15 分钟步长推进 `VirtualClock`、自动触发 `onHeartbeat()` 与跨夜 `runSleepCycle()`；
  - 输出时间演进快照（激素曲线、牵挂状态流转、独居物证清单、沉底归档统计与 L1–L6 体检结果）；
  - **跨时区一致性保证**：全仓日历日期（`todayStr`、牵挂年龄 `ageDays`、记忆衰减天数、L6 超期天数）统一按引擎本地日历日（`formatLocalDateStr` / `localCalendarDaysBetween`）计算，确保在 `TZ=UTC`、`TZ=Asia/Shanghai`、`TZ=America/New_York` 下行为 100% 一致。

---

## 4. 主场模式极薄 HTTP + SSE 服务层契约 (`src/loop/http-server.ts`)

为支撑前端设计并严守「第一人称主权与器官隔离」红线，本地 HTTP 服务层（基于 `Bun.serve`）在 API 层切分为**「陪伴主视图（Companion Surface）」**与**「造物主观测台（Observatory Surface）」**两条隔离通道：

### 4.1 陪伴主视图通道（Companion Surface · 强制过 `assertNoInternalLeaks`）

1. **`GET /api/companion/state`**：
   - 返回住户公开陪伴态（零激素浮点数、零 `log-*` 主键）：
     ```ts
     export interface CompanionStateResponse {
       personaName: string;
       chronotype: ChronotypeId;
       currentDate: string;
       currentTime: string;
       handover: SubconsciousHandover;
       messages: Array<{
         role: "user" | "assistant";
         speaker: string;
         content: string;
         timestamp: string;
         proactive?: boolean;
       }>;
     }
     ```
2. **`POST /api/chat`**：
   - 请求体：`{ message: string, weather?: WeatherSnapshot, desktopSamples?: DesktopWindowSample[], isHolidayOrAnniversary?: string, userActiveLateNight?: boolean }`
   - 动作：调用 `engine.onUserMessage()` 执行【环 1：实时交互环】；
   - 响应体：`{ reply: string, handover: SubconsciousHandover, journalEntry: string, currentDate: string, currentTime: string, consumedPrepConcernIds: string[] }`（全程经 `assertNoInternalLeaks` 校验，绝不回传 `hormoneState` 浮点数或 `userEventId/assistantEventId`）。

### 4.2 造物主观测台与仿真通道（Observatory & Time-Travel Surface）

1. **`GET /api/observatory/state`**：
   - 返回给侧边观测抽屉/调试面板的完整内部快照：`{ clock: { nowIso, todayStr, localTimeHm }, profile, hormoneState, reflexState, reflexEvaluation, activeConcerns, allConcerns, memoryMeta, solitaryProjects, todayHotEntries, todayColdReflection, lintReport }`。
2. **`POST /api/heartbeat`**：
   - 触发单步【环 2：自主心跳环】`engine.onHeartbeat(options)`，返回 `HeartbeatOutput`。
3. **`POST /api/fast-forward`**：
   - 请求体：`{ duration: string | number, stepMinutes?: number }`，调用 `TimeTravelSimulator.fastForward()`，返回 `SimulationReport`。
4. **`POST /api/sleep`**：
   - 手动触发【环 3：昼夜新陈代谢环】`engine.runSleepCycle(options)`，返回 `SleepCycleOutput`。
5. **`GET /api/observatory/archetypes` & `POST /api/observatory/persona`**：
   - 供性格算法测试台读取 5 套内置内分泌原型（`ARCHETYPE_PRESETS`）并支持动态切换当前住户人设/原型（可选重置激素至舒适基线 `resetHormonesToBaseline`）。
6. **静态测试台托管（`GET /` · `web/`）**：
   - 托管 `web/index.html`、`web/styles.css`、`web/app.js` 内部算法联调与性格测试台界面。

### 4.3 实时事件流通道（`GET /api/events` · Server-Sent Events）

- 标准 `text/event-stream` 长连接，实时向前端推送三环异步动态：
  - `connected`：连接建立握手；
  - `chat_turn`：实时对话完成（仅含零泄露陪伴摘要）；
  - `proactive_message`：环 2 分支 A 主动破冰消息（强制过 `assertNoInternalLeaks`，供聊天主窗口直接渲染住户主动发来的气泡）；
  - `heartbeat` / `fast_forward` / `sleep_cycle` / `persona_updated`：通知观测台刷新内部状态、人设原型与时间轴。

---

## 5. 系统账本 (`system_log` + `system_materials`)、`event_log` v2 与双保险备份契约（2026-11-13）

> 详细设计见 [`notes/background/SYSTEM-LOG-DESIGN-20261113.md`](../background/SYSTEM-LOG-DESIGN-20261113.md)（v0.3）。

### 5.1 `system_log` 与 `system_materials`（Append-Only 账本）

1. **表结构与触发器**：
   - `system_log (id TEXT PK, at INTEGER, recorded INTEGER, actor TEXT, kind TEXT, artifact TEXT, old_hash TEXT NULL, new_hash TEXT NULL, reason TEXT, link TEXT NULL)`，挂载 `BEFORE UPDATE` 与 `BEFORE DELETE` `RAISE(ABORT)` 触发器；
   - `system_materials (hash TEXT PK, content TEXT, created_at TEXT)`，以 SHA-256（UTF-8 原文字节）内容寻址去重存储提示词版本与《变更自述》全文。
2. **事件类型 (`kind`)**：
   - `prompt_changed` | `model_changed` | `config_changed` | `spine_changed` | `import` | `migration` | `sleep_rollback` | `snapshot_rollback` | `message_deleted` | `message_edited` | `backup_completed` | `deploy`。
3. **配置纪元 (`config_epoch`)**：
   - 任何行为条件变更（`prompt_changed` / `model_changed` / `config_changed` / `deploy`）使 `config_epoch` 自增；每次 `appendEventLog` 自动将当前 `config_epoch` 注入 `metadata_json`。
4. **红线隔离**：
   - 前台无任何写 `system_log` 入口；住户侧只读摘要通过 `formatSystemLogForResident()` 转为零数字、无内部标识符的自然语言说明，并强制通过 `assertNoInternalLeaks`。

### 5.2 `event_log` Schema v2、四类消息操作与多媒体附件

1. **新增列与枚举**：
   - `group_id TEXT NOT NULL`（跨 reroll 版本稳定 ID，默认 `= id`）、`version INTEGER NOT NULL DEFAULT 1`、`status TEXT NOT NULL DEFAULT 'active'`（`'active' | 'candidate'`）；
   - `producer TEXT NOT NULL`：`'user' | 'resident' | 'peer' | 'system' | 'solitary' | 'external'`；
   - `source TEXT NOT NULL`：`'chat' | 'group' | 'mcp_digest' | 'import' | 'heartbeat' | 'solitary' | 'system'`。
2. **四类消息操作（`EchoreEngine` & HTTP API）**：
   - `deleteMessagesFrom(eventId, options?)`（`POST /api/chat/delete`）：按 `rowid >= target` 删除 `event_log` 与 FTS，截断内存历史；若跨过 `last_sleep_event_id` 则回退游标；未过夜消息同步清理当日 `journal/YYYY-MM-DD.md` 对应交互热记事与新增 `concerns`；已过夜消息记 `message_deleted`，且 Linter L5 将落入删除区间的缺失 `source_event_id` 降级为 `warning (orphaned_by_deletion)`；
   - `rerollLastAssistantReply(options?)` & `switchMessageVersion(groupId, version)`（`POST /api/chat/reroll`、`POST /api/chat/version`）：同 `group_id` 内当前选中版本恒为 `status = 'active'`，其余为 `'candidate'`，同步更新 FTS、内存历史与当日热记事尾行；下一条新消息或入睡前物理清除 `'candidate'`；
   - `editLastUserMessage(eventId, newContent)`（`POST /api/chat/edit`）：仅允许修改最近一条尚无回复的用户消息，记 `message_edited`（不存旧文）；
   - `event_attachments` 表与 SHA-256 引用计数管理：仅当同一 `hash` 引用计数归零时才物理删除磁盘附件文件。

### 5.3 凌晨 04:30 + 启动补备双保险整库备份

- `runSystemBackup(options)`：通过 `VACUUM INTO` 导出一致性 `echore.sqlite` 快照并同步打包 `memoryDir` 与 `media/` 至 `<dataDir>/backups/YYYY-MM-DD/`，写 `backup_completed` 入 `system_log`；
- **定时触发**：环 2 心跳在每日 `04:30`（`04:00–05:00` 睡后窗口，三类作息均已入睡并完成夜间编译后）自动触发当日备份（同日单次）；
- **启动预检补备**：服务启动（`ensureStartupBackup()`）若发现上次备份缺失或距今 `>= 20h` 且有新事件，立即先执行一次 `startup_catchup` 备份再对外提供服务。

