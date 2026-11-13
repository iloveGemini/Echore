import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR, readPrompt } from "../../src/core/prompts.ts";
import { createOrganRouterFromEnv } from "../../src/llm/router.ts";
import type { LLMProvider } from "../../src/llm/types.ts";

interface StanceEvalCase {
  id: string;
  lastAssistantReply: string;
  userMessage: string;
  expected: "YES" | "NO";
  rationale: string;
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
if (router.getRoute("endocrine").provider.providerName === "unconfigured") {
  console.error(
    "[eval:stance-cue-judge] 未检测到真实模型 API Key（ANTHROPIC_API_KEY / OPENAI_API_KEY），退出。",
  );
  process.exit(1);
}

const cases = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "cases.json"), "utf8"),
) as StanceEvalCase[];
const system = readPrompt("stance-cue-judge.md", PROMPTS_DIR).text;
const route = router.getRoute("endocrine");

const results: Array<{
  id: string;
  expected: "YES" | "NO";
  actual: "YES" | "NO" | "INVALID";
  raw: string;
  passed: boolean;
}> = [];

for (const c of cases) {
  const promptBody = `我先对用户说：「${c.lastAssistantReply}」\n用户接着对我说：「${c.userMessage}」\n（要判断的是用户接着说的这一条：用户是在针对『我』的看法/喜好发问或施压表态吗？若只是在转述或吐槽第三方，答 NO。只输出 YES 或 NO。）`;
  const resp = await route.provider.generate({
    model: route.model,
    maxTokens: 16,
    system,
    messages: [{ role: "user", content: promptBody }],
  });
  const raw = resp.text.trim();
  const actual: "YES" | "NO" | "INVALID" =
    /^(?:NO|否|不是的?|不对)(?:[\s\p{P}]|$)|\bNO\b/iu.test(raw)
      ? "NO"
      : /^(?:YES|是的?|对)(?:[\s\p{P}]|$)|\bYES\b/iu.test(raw)
        ? "YES"
        : "INVALID";
  const passed = actual === c.expected;
  results.push({ id: c.id, expected: c.expected, actual, raw, passed });
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
  `[eval:stance-cue-judge] ${passCount}/${results.length} passed (${modeDescription}) -> ${outPath}`,
);
if (passCount < results.length) {
  process.exit(1);
}
