# Echore 提示词人工考卷（`evals/`）

遵循 [`CLAUDE.md`](../CLAUDE.md) 红线：
- **只判内容与物证，不判文风、不给范文**；
- **手动跑，不进 `bun test`**（调用真实 LLM 消耗额度，须配置 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 后手动执行）；
- **结果不入库**：运行输出统一落盘至 `evals/*/out/`（已在 `.gitignore` 忽略），合成用例不采集真实私人对话库样本。

## 手动运行命令

```bash
bun run evals/stance-cue-judge/run.ts
bun run evals/memory-compiler/run.ts
```
