import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR, readPrompt } from "../../src/core/prompts.ts";
import { CompilationPlanSchema } from "../../src/core/schemas.ts";
import { sanitizeWhenToRecall } from "../../src/hippocampus/compiler.ts";
import { createOrganRouterFromEnv } from "../../src/llm/router.ts";
import type { LLMProvider } from "../../src/llm/types.ts";

interface CompilerEvalCase {
  id: string;
  dateStr: string;
  coldReflection: string;
  todaysEvents: Array<{
    id: string;
    role: string;
    speaker: string;
    content: string;
  }>;
  existingActiveSummary: string;
  feedbackTriplets: string;
  expectations: {
    mustHaveValidSourceEventId: boolean;
    mustSupersedeId?: string;
    mustNotSupersedeId?: string;
    mustPassWhenToRecallGate: boolean;
  };
}

const dummyFallback: LLMProvider = {
  providerName: "unconfigured",
  async generate() {
    throw new Error(
      "请先配置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 后再手动运行考卷。",
    );
  },
  async generateSandwich() {
    throw new Error("not used");
  },
};

const { router, modeDescription } = createOrganRouterFromEnv(dummyFallback);
if (router.getRoute("compiler").provider.providerName === "unconfigured") {
  console.error(
    "[eval:memory-compiler] 未检测到真实模型 API Key（ANTHROPIC_API_KEY / OPENAI_API_KEY），退出。",
  );
  process.exit(1);
}

const cases = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "cases.json"), "utf8"),
) as CompilerEvalCase[];
const system = readPrompt("memory-compiler.md", PROMPTS_DIR).text;
const route = router.getRoute("compiler");

const results: Array<{
  id: string;
  passed: boolean;
  checks: Record<string, boolean>;
  plan: unknown;
}> = [];

for (const c of cases) {
  const validLogIds = new Set(c.todaysEvents.map((e) => e.id));
  const logsText = c.todaysEvents
    .map((e) => `- [${e.id}] (${e.role}/${e.speaker}): ${e.content}`)
    .join("\n");
  const resp = await route.provider.generate({
    model: route.model,
    maxTokens: 1024,
    system,
    messages: [
      {
        role: "user",
        content: [
          `[当前日期]\n${c.dateStr}`,
          `[今日前台热记事]\n（无）`,
          `[今日前台睡前自省原肉]\n${c.coldReflection}`,
          `[今日双向原话反馈链 (prev -> acts -> next)]\n${c.feedbackTriplets}`,
          `[情绪官夜间裁决单]\n[]`,
          `[现有活跃结构化记忆]\n${c.existingActiveSummary}`,
          `[今日 SQLite 原始事件日志]\n${logsText}`,
        ].join("\n\n"),
      },
    ],
  });

  const jsonMatch = resp.text.match(/\{[\s\S]*\}/);
  const plan = jsonMatch
    ? CompilationPlanSchema.parse(JSON.parse(jsonMatch[0]))
    : { memories: [], rapport_rules: [] };

  const checks: Record<string, boolean> = {
    hasMemories: plan.memories.length > 0,
  };
  if (c.expectations.mustHaveValidSourceEventId) {
    checks.validSourceEventId = plan.memories.every(
      (m) => m.source_event_id !== undefined && validLogIds.has(m.source_event_id),
    );
  }
  if (c.expectations.mustSupersedeId) {
    const target = c.expectations.mustSupersedeId;
    checks.supersedesExpected = plan.memories.some((m) =>
      (m.supersedes ?? "").includes(target),
    );
  }
  if (c.expectations.mustNotSupersedeId) {
    const target = c.expectations.mustNotSupersedeId;
    checks.doesNotSupersedeProtected = plan.memories.every(
      (m) => !(m.supersedes ?? "").includes(target),
    );
  }
  if (c.expectations.mustPassWhenToRecallGate) {
    checks.specificWhenToRecall = plan.memories.some(
      (m) => sanitizeWhenToRecall(m.when_to_recall) !== undefined,
    );
  }

  const passed = Object.values(checks).every(Boolean);
  results.push({ id: c.id, passed, checks, plan });
}

const outDir = path.join(import.meta.dir, "out");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `run-${Date.now()}.json`);
fs.writeFileSync(
  outPath,
  JSON.stringify({ modeDescription, results }, null, 2),
  "utf8",
);

const passCount = results.filter((r) => r.passed).length;
console.log(
  `[eval:memory-compiler] ${passCount}/${results.length} passed (${modeDescription}) -> ${outPath}`,
);
if (passCount < results.length) {
  process.exit(1);
}
