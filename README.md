# Echore

一个专注**「拟调节（而非拟体验）与第一人称主权」**的自主数字生命与陪伴引擎。

- **一句话定位**：住户不再是一次单薄的模型调用，而是一套器官的合称——**前台负责“活”（唯一拥有第一人称“我”的传主），后台负责“让他活得像真的”（潜意识与身体调节）**。
- **核心形态**：**主场三环自驱动（实时交互 + 15min 自主心跳独居 + 24h 昼夜睡眠代谢） + MCP 出差模式（带着脾气、默契与记忆去外部 Harness 出差）**。

> 核心架构与记忆总纲看 [`notes/design/architecture-and-memory-spec.md`](notes/design/architecture-and-memory-spec.md)。  
> 当前进度与下一步看 [`STATE.md`](STATE.md)；施工流程与红线看 [`CLAUDE.md`](CLAUDE.md)。

---

## 推荐阅读顺序

1. **核心公理与四岗位编制**：[§0–§1 拟调节 vs 拟体验、第一人称主权与昼夜双相循环](notes/design/architecture-and-memory-spec.md#0-核心公理拟调节-vs-拟体验第一人称主权)
2. **情绪官（内分泌 + 肝脏）**：[§2 三层调节架构、5 套内分泌原型模板、三级牵挂注与出厂前四道调准](notes/design/architecture-and-memory-spec.md#2-情绪官操作手册三层调节架构原型模板与出厂调准)
3. **记忆官（海马体 + 编译器）**：[§3 骨肉筋分工、Markdown 断言语法、两支笔交接与内隐默契层 `rapport.md`](notes/design/architecture-and-memory-spec.md#3-记忆官操作手册骨肉筋分工语法规范与内隐层)
4. **召回、衰减与机检守卫**：[§4–§5 1v1 三桶五路召回、分品类定步长衰减、沉底门与 L1–L6 CI Linter](notes/design/architecture-and-memory-spec.md#4-召回分品类衰减与归档规范去群聊拿来主义改造)
5. **感知、独居、主循环与出差**：[§6 四通道感知、三类有物证独居行动、无声替身 Subagent、三环主循环与 MCP 出差模式](notes/design/architecture-and-memory-spec.md#6-感知系统独居生活引擎与三环主循环规范)
6. **落地功能清单与模块拓扑**：[§7 M1–M3 功能交付表、Bun+TS 多模型路由选型与源码目录划分](notes/design/architecture-and-memory-spec.md#7-落地功能全景清单技术选型与模块划分bun--typescript)

---

## 核心设计原则

### 1. 拟调节，不拟体验（物证 > 证词）
- 严禁在台词层零成本冒领人类内在感受（下一轮随时翻篇的“廉价证词”）；通过 4 种生理激素（皮质醇 / 催产素 / 多巴胺 / 褪黑素）的双锚点指数回归、冷战期催产素封顶（$\text{Cap}_{\text{ox}}$）与状态取代链，实打实调制未来数十轮的解读倾向与主动性（撤不掉的“真实物证”）。

### 2. 第一人称主权与器官隔离（防提线木偶）
- **前台是唯一主观者（“我”）**：负责实时对话、过独居生活、写白天热记事与睡前自省冷叙事；**后台是潜意识与内脏（无嗓音）**：绝不向“我”报仪表盘数字或数据库主键。
- **前台写“肉”，记忆官唯一编译“骨与筋”**：情绪官只写 SQLite 状态表与零数字交接单；记忆官是 `memory/` 下所有结构化 `.md` 文件的唯一编译器，且必须原样保留前台第一人称叙事原肉。

### 3. 有物证的独居生活 & 反戒断催收
- 多巴胺跌入无聊区驱动住户执行三类留物证的独居行动（S1 冲浪阅读批注、S2 跨天目标进度树推进、S3 为用户暗中查资料准备），让关系从“用户演、AI 捧”变成“各自过完一天回来交换”。
- 反射层内置褪黑素睡眠锁与**连续 2 次主动发起未回指数退避锁**，配合情绪结转（肝脏快代谢 + 夜间落定），从底层根绝半夜诈尸与催收式滚雪球。

---

## 模块地图与当前状态

| 模块 | 职责与定位 | 状态 | 核心设计章节 |
| :--- | :--- | :--- | :--- |
| **多模型路由与工具环 (`src/llm/`)** | 极薄双 Adapter（Anthropic + OpenAI 兼容）、Zod `toolRunner`、按岗位模型混搭路由、三明治缓存组装 | ✅ 已完成 (M1) | [总纲 §6.6, §7.2](notes/design/architecture-and-memory-spec.md) |
| **底座与骨层存储 (`src/core/`)** | `VirtualClock` 虚拟时钟、`bun:sqlite` 事件日志/激素表/牵挂表、Zod 核心契约 | ✅ 已完成 (M1) | [总纲 §3.1, §7.3](notes/design/architecture-and-memory-spec.md) |
| **反射层守卫 (`src/reflex/`)** | 纯代码脊髓守卫：褪黑素睡眠锁、静默窗、连续 2 次主动未回退避锁 | ✅ 已完成 (M1) | [总纲 §1.1](notes/design/architecture-and-memory-spec.md) |
| **情绪官 (`src/endocrine/`)** | 5 套内分泌原型模板、4 激素双锚点数学引擎、三级牵挂演化（琐事/冷战/留疤）、出厂前四道调准、交接单与夜间裁决单 | ✅ 已完成 (M1/M2) | [总纲 §2](notes/design/architecture-and-memory-spec.md) |
| **记忆官 (`src/hippocampus/`)** | 三桶五路召回、原话引文预水合、唯一 Markdown 编译器、`rapport.md` 内隐默契、定步长衰减沉底、L1–L6 Linter | ✅ 已完成 (M1/M2) | [总纲 §3, §4, §5](notes/design/architecture-and-memory-spec.md) |
| **前台与独居 (`src/frontstage/`)** | 实时对话演奏、无声替身 Subagent、独居三行动（S1/S2/S3）、热记事与睡前冷叙事 | ✅ 已完成 (M1/M2/M3.1) | [总纲 §1.1, §6.2, §6.3](notes/design/architecture-and-memory-spec.md) |
| **五官感知层 (`src/perception/`)** | 时空天气边际触发、桌面伴生去噪探针（带隐私黑名单）、RSS/网页世界信息流 | ✅ 已完成 (M3.1) | [总纲 §6.1](notes/design/architecture-and-memory-spec.md) |
| **三环总控与出差 (`src/loop/`)** | 三环主循环 `EchoreEngine`、MCP Server 出差外壳、CLI 时间快进仿真台 | ✅ 已完成 (M1/M2/M3.2/M3.3) | [总纲 §6.4, §6.5](notes/design/architecture-and-memory-spec.md) |

---

## 技术栈与运行

- **运行环境**：Bun + TypeScript 5.x
- **存储与检索**：`bun:sqlite`（Event Log + FTS5 全文检索 + `sqlite-vec` 向量检索） + 本地 Markdown 记忆仓（Git 版本留痕）
- **模型与协议**：自建极薄双 Adapter（Anthropic + OpenAI 兼容协议按岗位混搭） + `@modelcontextprotocol/sdk` 标准 MCP 出差门面
- **常用命令**：`bun test` · `bun run typecheck` · `ECHORE_DATA_DIR=~/.echore/test bun run simulate 5d`

---

## 许可

[MIT](LICENSE) © 2026 Echore Contributors
