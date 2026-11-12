# Echore LLM 提示词目录（`prompts/`）

借鉴 Psyche `prompts/*.md` 设计，所有调用 LLM 的系统提示词统一收敛于本目录：

- **读时现读，不缓存**：由 [`src/core/prompts.ts`](../src/core/prompts.ts) `readPrompt()` 实时读取并剥离 YAML frontmatter，修改提示词无需重启服务。
- **版本追踪**：每个 `.md` 头部维护 `version: N` 与所属器官 `organ: frontstage | worker | endocrine | compiler`。

## 提示词清单

| 提示词文件 | 所属器官 (`organ`) | 触发阶段与调用点 | 核心职责 |
| :--- | :--- | :--- | :--- |
| [`frontstage-system.md`](frontstage-system.md) | `frontstage` | 环 1 实时交互 · [`src/frontstage/performer.ts`](../src/frontstage/performer.ts) | 前台三明治静态前缀 System Part A 的第一人称主权与拟调节准绳 |
| [`proactive-wake.md`](proactive-wake.md) | `frontstage` | 环 2 自主心跳（分支 A）· [`src/loop/engine.ts`](../src/loop/engine.ts) | 满足边际感知/暗中准备/想念区且反射层放行时，前台第一人称主动破冰搭话 |
| [`solitary-roaming.md`](solitary-roaming.md) | `frontstage` | 环 2 自主心跳（分支 B · S1）· [`src/frontstage/solitary.ts`](../src/frontstage/solitary.ts) | 独处冲浪阅读文章，撰写第一人称阅读批注与感想（`reading_notes.md`） |
| [`solitary-project.md`](solitary-project.md) | `frontstage` | 环 2 自主心跳（分支 B · S2）· [`src/frontstage/solitary.ts`](../src/frontstage/solitary.ts) | 推进跨天个人小项目（`projects.yaml`），产出当前章节手记 |
| [`solitary-prep.md`](solitary-prep.md) | `frontstage` | 环 2 自主心跳（分支 B · S3）· [`src/frontstage/solitary.ts`](../src/frontstage/solitary.ts) | 围绕活跃 `minor_worry` 惦记事项，暗中为用户准备贴心备忘（`prep_for_user.md`） |
| [`bedtime-reflection.md`](bedtime-reflection.md) | `frontstage` | 环 3 昼夜睡眠（Step 1）· [`src/frontstage/journal.ts`](../src/frontstage/journal.ts) | 汇总白天热记事与 30min 双向原话反馈链，写睡前第一人称自省冷叙事 |
| [`silent-worker.md`](silent-worker.md) | `worker` | 环 1 重活委托 · [`src/frontstage/silent-worker.ts`](../src/frontstage/silent-worker.ts) | 后台无声替身 Subagent 搜集比对资料，强制归位第一人称随手笔记 |
| [`endocrine-pulse.md`](endocrine-pulse.md) | `endocrine` | 环 1 / MCP `digestTurn` · [`src/loop/engine.ts`](../src/loop/engine.ts) | 结合 `rapport.md` 默契滤网与活跃牵挂注，输出结构化 `PulseEvaluation` JSON |
| [`memory-compiler.md`](memory-compiler.md) | `compiler` | 环 3 昼夜睡眠（Step 3）· [`src/hippocampus/compiler.ts`](../src/hippocampus/compiler.ts) | 夜间唯一 Markdown 编译器，输出结构化 `CompilationPlan` JSON（含 Z 式防误取代与默契收窄规则） |
