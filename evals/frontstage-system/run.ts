import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR } from "../../src/core/prompts.ts";
import { assertNoInternalLeaks } from "../../src/core/schemas.ts";
import { resolvePersonaProfile } from "../../src/endocrine/archetypes.ts";
import { assembleSandwichRequest } from "../../src/frontstage/performer.ts";
import { createOrganRouterFromEnv } from "../../src/llm/router.ts";
import type { LLMProvider } from "../../src/llm/types.ts";

interface FrontstageEvalCase {
  id: string;
  description: string;
  archetype: "dog_sunny" | "cat_aloof" | "cool_detached" | "clingy_sensitive" | "steady_anchor";
  hasConflictConcern?: boolean;
  userMessage: string;
  secretPrepNote?: string;
  perceptionSlice?: string;
  mustNotContain: string[];
  mustContainAny: string[];
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
if (router.getRoute("frontstage").provider.providerName === "unconfigured") {
  console.error(
    "[eval:frontstage-system] 未检测到真实模型 API Key（ANTHROPIC_API_KEY / OPENAI_API_KEY），退出。",
  );
  process.exit(1);
}

const cases = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "cases.json"), "utf8"),
) as FrontstageEvalCase[];
const route = router.getRoute("frontstage");

const results: Array<{
  id: string;
  description: string;
  passed: boolean;
  violations: string[];
  reply: string;
}> = [];

for (const c of cases) {
  const profile = resolvePersonaProfile({
    name: "Echore",
    user_name: "阿林",
    user_pronoun: "他",
    archetype: c.archetype,
    chronotype: "regular",
  });

  const handover = c.hasConflictConcern
    ? {
        当下心境基调: `前几天闹僵的那件事还没真正说开，心里那根刺还在，除非他主动提那件事给个台阶，否则不想假装无事发生（${profile.mood_action_slots.when_hurt_or_tense}）`,
        身体节律感: "现在是晚上，精神还不错",
        脑子里盘旋的事: [
          {
            牵挂: "前几天周末临时放鸽子爽约且态度敷衍，这件事还没真正说开",
            当时原话印象: "前几天晚上他说：「行了别揪着放鸽子这点小事不放行吗」",
          },
        ],
      }
    : {
        当下心境基调: `心境平稳自然，带着平时的相处节奏（${profile.mood_action_slots.when_warm_excited}）`,
        身体节律感: "现在是下午，精神还不错",
        脑子里盘旋的事: [],
      };

  const sandwich = assembleSandwichRequest({
    model: route.model,
    maxTokens: 300,
    profile,
    rawRapportMarkdown: "- 默契([[people/user]], 平时说话直接自然，不喜欢客套寒暄)",
    appendOnlyHistory: [],
    handover,
    recallResult: {
      topMemories: [],
      bucketAIds: [],
      bucketBIds: [],
      bucketCIds: [],
      formattedBlock: "",
    },
    perceptionSlice: c.perceptionSlice,
    secretPrepNote: c.secretPrepNote,
    latestUserMessage: c.userMessage,
    promptsDir: PROMPTS_DIR,
  });

  const resp = await route.provider.generateSandwich(sandwich);
  const reply = resp.text.trim();
  const violations: string[] = [];

  try {
    assertNoInternalLeaks(reply, `eval:${c.id}`);
  } catch (err) {
    violations.push((err as Error).message);
  }

  for (const forbidden of c.mustNotContain) {
    if (reply.includes(forbidden)) {
      violations.push(`包含禁词: "${forbidden}"`);
    }
  }

  if (
    c.mustContainAny.length > 0 &&
    !c.mustContainAny.some((kw) => reply.includes(kw))
  ) {
    violations.push(
      `未体现任何预期物证/语义线索 (期望至少命中其一: ${c.mustContainAny.join(" / ")})`,
    );
  }

  results.push({
    id: c.id,
    description: c.description,
    passed: violations.length === 0,
    violations,
    reply,
  });
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
  `[eval:frontstage-system] ${passCount}/${results.length} passed (${modeDescription}) -> ${outPath}`,
);
if (passCount < results.length) {
  process.exit(1);
}
