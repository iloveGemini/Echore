# Genesis 初始化与住户记忆仓标准文件工具契约（v0.3 · 收窄实时写边界版）

> **状态**：v0.3 已完成落地（2026-11-13，标准 `glob / grep / read / write / edit` 五件套、白天写边界收窄与 Genesis 双向取名初始化全部通过三时区 73/73 测试）
> **前置基座**：
> - [`notes/design/architecture-and-memory-spec.md`](../design/architecture-and-memory-spec.md)（v1.4）
> - [`notes/plan/m1-contracts.md`](m1-contracts.md) · [`notes/plan/m3-contracts.md`](m3-contracts.md) · [`notes/plan/frontend-plan.md`](frontend-plan.md)
> - [`prompts/frontstage-system.md`](../../prompts/frontstage-system.md)（v4 第一人称通用提示词）

---

## 0. 核心设计演进与守卫边界

让住户**像操作自己的私人笔记库一样**查阅与记录，对外暴露标准的 5 个文件工具（`glob` / `grep` / `read` / `write` / `edit`），同时严格遵守**「需要跨轮语义校验与 Z-gate 的结构化断言绝不在白天实时写入」**原则：

1. **工作区即 `memoryDir`（沙箱路径）**：模型入参一律写相对路径（如 `people/self.md`、`journal/2026-11-13.md`）。底层拦截一切 `..` 路径穿越、`.git/` 与 `echore.sqlite` 访问。
2. **读前脱敏钩子（Zero `log-*` Exposure）**：`read` 与 `grep` 返回给模型前，自动剥离 `source_event_id: log-...`、`[src: log-...]` 与内部哈希指纹，防止撞爆 `assertNoInternalLeaks`。
3. **写权限严守「两支笔协议」与 `source_event_id` 物证神圣性**：
   - **为什么白天禁写 `events/*.md` 与 `implicit/rapport.md`**：写前钩子只验格式不验真假，若在聊天当下允许写 `events/` 或 `rapport.md` 并自动填当轮 `source_event_id`，会把未经 30min 双向反馈链（`prev -> acts -> next`）、四分法与 Z-gate 核验的半截话甚至编造当成“编译器已核验出处”，且无 CoW 快照回滚。
   - **因此白天只开放两块无需跨轮事实裁决与独居物证核验的区域**：
     1. `journal/YYYY-MM-DD.md`（`write` / `edit`）：前台第一人称随手热记事（“肉”），无需 `source_event_id`；若当轮前台已主动写入当日日记，引擎不再重复追加机械热记事；当天 Stage 2 召回实时可读，夜间入睡后由 `memory-compiler` 结合反馈链正式提炼进 `events/` 与 `rapport.md`；
     2. `people/self.md` 与 `people/user.md`（**仅限 `edit` 局部修改**）：L5 本就豁免 `people/` 初始档的 `source_event_id`；仅用于双方商定新名字或更新称呼、代词、关系时即时改写对应行，**工具层绝不自动伪造或注入 `source_event_id`**。
   - **`events/*.md`、`implicit/rapport.md`、`concerns/*.md`、`solitary/**`、`INDEX.md` 对白天前台工具一律只读**（`solitary/**` 独居物证仅由环 2 `runSolitaryTick` 真实执行后落盘，防止对话时当场补写假物证；若尝试写入，明确提示先记入今日 `journal/YYYY-MM-DD.md`）。
4. **写后像 IDE 一样即时 Linter + 联动同步钩子**：
   - `edit` 修改 `people/self.md` 或 `people/user.md` 时，落盘前先在内存预检 **L1 / L4 / L7 + `assertNoInternalLeaks`**（格式不合规直接拒绝写盘并返回修正提示）；
   - 通过后原子落盘，触发 `syncSingleMemoryMetaFile`，并自动解析姓名/称呼/代词/关系变更，联动更新 SQLite `resident_state`、`system_log` 与 SSE `persona_updated` 事件。
5. **Prompt Cache 稳定（§6.6）**：这 5 个工具以固定字母序常驻 `staticPrefix.tools`，不随轮次增减。

---

## 1. 标准文件工具五件套（`src/frontstage/memory-tools.ts`）

通过 `createFrontstageMemoryTools(ctx)` 生成，作为标准 `ZodTool` 挂载到前台工具环：

| 工具名 | 职责 | 入参 Schema（Zod） | 底层透明钩子与返回 |
| :--- | :--- | :--- | :--- |
| **`glob`** | 按模式列举记忆仓文件 | `{ pattern?: string }`（默认 `"**/*.md"`） | 过滤 `.git/`；返回相对路径列表，附带文件 `status` 与模糊时间（不含 `log-*`） |
| **`grep`** | 全文检索记忆仓（含 `已沉底` 冷库） | `{ pattern: string, path?: string, include_archived?: boolean, regex?: boolean, limit?: number }` | 排除 `.git/`；默认字面子串匹配（`regex: true` 时启用正则）；匹配前剥离 `source_event_id` / `[src: log-*]`；返回命中路径、行号与脱敏片段（默认上限 30 条） |
| **`read`** | 读取单个记忆/档案/日记文件 | `{ path: string, offset?: number, limit?: number }` | 校验沙箱路径；剥离 `log-*` 溯源标记与内部字段；单次输出截断上限 4000 字符（支持分页续读） |
| **`write`** | 创建或覆写日常日记（仅限 `journal/YYYY-MM-DD.md`） | `{ path: string, content: string }` | 拦截只读区（含 `solitary/`）与 `people/` 整文件覆写；校验 `assertNoInternalLeaks` |
| **`edit`** | 精确局部替换（支持 `journal/` 及 `people/{self,user}.md`） | `{ path: string, old_string: string, new_string: string }` | 归一化唯一片段替换；若目标为 `people/{self,user}.md` 则跑 L1/L4/L7 预检并触发身份联动同步 |

### 1.1 分区权限与透明钩子行为表（`write` & `edit`）

| 目录 / 文件 | 允许操作 | 透明预处理与 Linter 守卫 | 写后联动副作用 |
| :--- | :--- | :--- | :--- |
| **`journal/YYYY-MM-DD.md`** | `write` / `edit` | 校验日期命名；`assertNoInternalLeaks` 校验 | 立即落盘第一人称随手记事（触发 `onJournalWritten` 抑制当轮重复机械热记事，当天 Stage 2 召回可检出，夜间供编译器提炼） |
| **`people/self.md`** | **仅限 `edit`**（禁 `write` 覆写） | 保留原文件 `id` / `type` / `allow_forget: false`（不伪造 `source_event_id`）；跑 L1/L4/L7 | 从正文解析住户姓名变化（`身份([[people/self]]#姓名, ...)` 等）$\rightarrow$ **原子更新 `resident_state`（`name` + `naming_state: "settled"`）+ 记入 `system_log (config_changed, actor: "agent")` + SSE 广播 `persona_updated`** + `syncSingleMemoryMetaFile` |
| **`people/user.md`** | **仅限 `edit`**（禁 `write` 覆写） | 同上，保留保护字段并跑 L1/L4/L7 | 若解析到 `user_name` / `user_pronoun` / `relationship` 变化 $\rightarrow$ 同步更新 `resident_state` 与 `system_log` + `syncSingleMemoryMetaFile` |
| **`events/*.md` · `implicit/rapport.md` · `concerns/*.md` · `solitary/**` · `INDEX.md`** | **只读（拒绝白天聊天工具写入）** | 拒绝写入并提示：`solitary/**` 由独居时段沉淀，`events/` 与 `rapport.md` 由夜间睡眠核验沉淀，白天请先记入当日 `journal/YYYY-MM-DD.md` | 无 |

### 1.2 错误自愈机制（IDE 式 Linter 反馈）
- 如果模型用 `edit` 修改 `people/self.md` 或 `people/user.md` 时写出了不合规格式（例如断言超过 6 条触发 L7 `too_coarse`，或引用了未定义符号 `[[people/xxx]]` 触发 L1），工具**不落盘**，直接把脱敏后的报错返回给模型，由模型在同一轮工具循环内（`maxToolSteps = 6`）自行修好再试。

---

## 2. Genesis 初始化契约（含双向取名机制）

### 2.1 SQLite 状态持久化（`src/core/db.ts` · `src/core/schemas.ts`）

新增单行表 `resident_state`（`id INTEGER PRIMARY KEY CHECK (id = 1)`）：

```ts
export type GenesisStatus = "pending" | "completed";
export type NamingMode = "co_create" | "user_fixed";
export type NamingState = "pending" | "settled";

export interface ResidentStateRecord {
  genesis_status: GenesisStatus;
  naming_mode: NamingMode;
  naming_state: NamingState;
  persona_config: PersonaConfig; // 含 name, user_name, user_pronoun, relationship, core_persona, archetype, chronotype, sliders, mood_action_slots
  initialized_at: string | null;
  updated_at: string;
}
```

- **启动加载策略（兼容现有单测与 CLI）**：
  - `EchoreEngine` 构造时若显式传入 `options.persona` 且库内尚无 `resident_state`，按传入配置运行（向后兼容全部现有单测与仿真台）；
  - HTTP 服务启动（`startEchoreServer`）时优先读取 `db.getResidentState()`：若已 `completed`，恢复持久化人设（不再使用硬编码 `"林栖"`）；若 `pending`，停在「门口（Threshold）」待初始化。

### 2.2 门口四步初始化输入契约（`GenesisInitRequest`）

```ts
export const GenesisInitRequestSchema = z.object({
  // Step 1: 用户与关系起点（不默认“伴侣”）
  user_name: z.string().trim().min(1).max(32).default("用户"),
  user_pronoun: z.string().trim().min(1).max(16).default("他"),
  relationship: z.string().trim().min(1).max(32).default("初识"), // 前端预设：初识(默认) / 朋友 / 室友 / 搭子 / 自定义

  // Step 2: 内分泌底色与作息（沿用三阶协议 L0/L1/L2）
  archetype: z.union([ArchetypeIdSchema, ArchetypeBlendSchema]),
  chronotype: ChronotypeIdSchema.default("regular"),
  sliders: PersonaSlidersSchema.optional(),
  mood_action_slots: MoodActionSlotsSchema.partial().optional(),
  core_persona: z.string().trim().optional(),

  // Step 3: 双向取名机制
  naming_mode: z.enum(["co_create", "user_fixed"]).default("co_create"),
  resident_name: z.string().trim().max(32).optional(), // 仅 user_fixed 必填；co_create 忽略并锁定为 "Echore"
});
```

### 2.3 出生落盘流程（`engine.initializeGenesis(input)`）

1. **校验与命名定态**：
   - `naming_mode === "user_fixed"` 时校验 `resident_name` 非空，置 `naming_state = "settled"`；
   - `naming_mode === "co_create"` 时锁定初始代号 `"Echore"`，置 `naming_state = "pending"`。
2. **事务初始化 SQLite**：
   - 写入 `resident_state`（`genesis_status = "completed"`）；
   - 按解析后的原型基线重置 `hormone_state`；
   - 写入 `system_log`（`actor: "user"`, `kind: "config_changed"`, `artifact: "genesis:init"`）。
3. **渲染初始记忆仓（`memoryDir`）**：
   - 复制并渲染 `memory_template/`：
     - `people/self.md`：写入固定断言格式 `身份([[people/self]]#姓名, <name>)`（`co_create` 时写 `Echore`，并在 `## 前台原叙` 注明目前暂用代号、还没取正式名字）、`date: todayStr`、`allow_forget: false`；
     - `people/user.md`：写入 `称呼([[people/user]]#姓名, <user_name>)`、`代词([[people/user]]#代词, <user_pronoun>)`、`关系([[people/user]]#关系, <relationship>)`、`date: todayStr`、`allow_forget: false`；
     - `INDEX.md`：更新出生日期；
   - 调用 `syncMemoryMetaFromFiles` + `runMemoryLinter` 确保出生即全绿。
4. **首句破冰生成**：
   - 基于当前时刻与可选天气感知，调用一次前台生成住户的第一句自然开场白并记入 `event_log`（无系统欢迎弹窗腔）。

### 2.4 对话中双向取名闭环（`co_create` → `settled`）

```text
[Genesis: co_create]
  resident_name = "Echore", naming_state = "pending"
        │
        ▼ (dynamicTail 注入待取名隐式提示，仅当 naming_state === "pending" && 轮数 <= 15)
[聊天共创 / 用户起名 / 住户自提]
  例：用户说“以后就叫你小满吧” 或 住户说“那我叫林栖好不好？”
        │
        ▼ (前台像改项目文件一样直接 edit / write `people/self.md`)
  edit({
    path: "people/self.md",
    old_string: "身份([[people/self]]#姓名, Echore)",
    new_string: "身份([[people/self]]#姓名, 小满)"
  })
        │
        ▼ (edit 工具底层透明钩子原子完成)
  1. 校验格式并自动更新 source_event_id = currentUserEventId → 跑 L1/L4/L7 → 写盘 people/self.md
  2. 钩子解析出姓名变更 → 同步 SQLite resident_state (name: "小满", naming_state: "settled")
  3. 写 system_log (kind: "config_changed", actor: "agent") + syncSingleMemoryMetaFile
  4. SSE 广播 persona_updated（前端顶栏/档案卡即时刷新为「小满」）
        │
        ▼ (下一轮起)
  Part A `{resident_name}` 自动变为「小满」，dynamicTail 撤下待取名提示，Static Prefix 恢复稳定缓存
```

- **夜间双保险**：若住户在白天对话里已经和用户商定了名字但忘了调 `edit` 写文件，当晚环 3 的 `memory-compiler.md` 在编译 `people/self.md` 姓名变更时同样触发 `resident_state` 同步（`naming_state -> "settled"`）。

---

## 3. HTTP / SSE 与提示词联动接口清单

### 3.1 新增与调整的 HTTP 接口（`src/loop/http-server.ts`）
- `GET /api/genesis/status`：返回 `{ genesisStatus, namingMode, namingState, residentName, userName, relationship }`（过 `assertNoInternalLeaks`）。
- `POST /api/genesis/init`：接收 `GenesisInitRequestSchema`，执行出生落盘并返回初始化状态与首句破冰消息；已完成 Genesis 时默认拒绝重复覆盖。
- `GET /api/companion/state`：补充 `genesisStatus`、`namingState`、`userName`、`relationship` 供前端判断停留在「门口」还是进入「对话间」。

### 3.2 提示词联动调整
1. **`prompts/frontstage-system.md`**：在 `# 我的记忆和时间体感` / `# 我顺手办事的方式` 补充标准文件工具使用感知（可以用手边的 `glob / grep / read` 翻自己之前的日记与记忆文件，也可以用 `write / edit` 在聊天当下记下对方的重要近况、习惯或共同定下的名字——具体怎么写进哪类文件直接顺着仓库原有格式来，但绝不向对方报文件名或工具名）。
2. **`src/frontstage/performer.ts`**：
   - `buildDynamicSubconsciousBlock`：当 `naming_state === "pending"` 且历史对话轮数 $\le 15$ 时，在动态尾部附带待取名提示（提醒目前暂用代号 `Echore`，若一起定了正式名字可以直接改写 `people/self.md`）；
   - `assembleSandwichRequest`：将 `glob / grep / read / write / edit` 与 `silent_worker` 合并入 `staticPrefix.tools` 并按字母序排列。

---

## 4. 验证标准（Acceptance Checklist）

1. **标准工具沙箱与脱敏单测**：`read` / `grep` 读出 `events/*.md` 与 `implicit/rapport.md` 时 **0 泄露** `log-*` 主键；传入 `../` 或 `.git/` 路径被拒绝。
2. **写边界与 `source_event_id` 保护单测**：白天尝试 `write` / `edit` 写入 `events/*.md`、`implicit/rapport.md`、`concerns/*.md` 或 `INDEX.md` 时一律被拒绝并提示记入 `journal/YYYY-MM-DD.md`；尝试用 `write` 整文件覆写 `people/self.md` 被拒绝；写入 `journal/YYYY-MM-DD.md` 与 `solitary/*` 正常生效；全程不自动伪造 `source_event_id`。
3. **取名闭环与 L1/L7 预检单测**：`co_create` 模式初始化为 `"Echore"` $\rightarrow$ 前台调用 `edit` 修改 `people/self.md` 的 `#姓名` 为 `"小满"`（若写入违规 L1/L7 断言则拒绝并不落盘） $\rightarrow$ 断言文件落盘过 L1–L7、`resident_state` 同步为 `"settled"`、`system_log` 记入 `config_changed`、下一轮 `Part A` 变为 `"我是小满。"`。
4. **关系起点与持久化单测**：Genesis 默认关系为 `"初识"`（不预设 `"伴侣"`）；重启 `EchoreEngine` / `EchoreHttpApp` 后从 SQLite 恢复完整 `resident_state`。
5. **全仓回归**：`ECHORE_DATA_DIR=~/.echore/test bun run test:tz` 与 `bun run typecheck` 全绿。
