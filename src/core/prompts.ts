/**
 * 提示词文件（prompts/*.md）：frontmatter 里写 `version: N` 与 `organ: ...`，正文给模型看。
 *
 * 借鉴 Psyche `src/core/prompts.ts`：
 * - 读时现读，不缓存：开发与调优期改了 `prompts/*.md` 立即生效，无需重启进程。
 * - 支持传入自定义 `promptsDir`（供单测或独立沙箱覆写）。
 * - 文件不存在时返回空串与 `version: 0`。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROMPTS_DIR = join(import.meta.dir, "../../prompts");

export type PromptFileName =
  | "frontstage-system.md"
  | "proactive-wake.md"
  | "solitary-roaming.md"
  | "solitary-project.md"
  | "solitary-prep.md"
  | "bedtime-reflection.md"
  | "silent-worker.md"
  | "endocrine-pulse.md"
  | "memory-compiler.md"
  | "stance-cue-judge.md";

export interface PromptDoc {
  name: string;
  text: string;
  version: number;
  organ?: string;
}

/** 拆 frontmatter：正文去掉 frontmatter，版本号取 `version:`，岗位取 `organ:` */
export function parsePrompt(raw: string, name = ""): PromptDoc {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { name, text: raw.trim(), version: 0 };
  const fm = m[1] ?? "";
  const v = fm.match(/^version:\s*(\d+)\s*$/m);
  const organ = fm.match(/^organ:\s*(\S+)\s*$/m);
  return {
    name,
    text: raw.slice(m[0].length).trim(),
    version: v ? Number(v[1]) : 0,
    ...(organ?.[1] ? { organ: organ[1] } : {}),
  };
}

export function readPrompt(
  name: PromptFileName | (string & {}),
  dir = PROMPTS_DIR,
): PromptDoc {
  const filePath = join(dir, name);
  return existsSync(filePath)
    ? parsePrompt(readFileSync(filePath, "utf8"), name)
    : { name, text: "", version: 0 };
}

/** 列出提示词目录下所有 `.md` 提示词文档（排除 README.md） */
export function listPrompts(dir = PROMPTS_DIR): PromptDoc[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((f) => readPrompt(f, dir));
}
