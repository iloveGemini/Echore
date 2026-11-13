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
import { computeSha256Hex, type EchoreDatabase } from "./db.ts";
import type { SystemLogActor, SystemLogRecord } from "./schemas.ts";

export const PROMPTS_DIR = join(import.meta.dir, "../../prompts");

const promptHashBaselineByDb = new WeakMap<
  EchoreDatabase,
  Map<string, string>
>();

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

function getOrCreateBaselineMap(db: EchoreDatabase): Map<string, string> {
  let map = promptHashBaselineByDb.get(db);
  if (!map) {
    map = new Map<string, string>();
    promptHashBaselineByDb.set(db, map);
  }
  return map;
}

function trackPromptReadWithDb(
  raw: string,
  doc: PromptDoc,
  db: EchoreDatabase,
  actor: SystemLogActor = "maker",
): SystemLogRecord | null {
  const hash = computeSha256Hex(raw);
  const artifact = `prompts/${doc.name}`;
  const baselineMap = getOrCreateBaselineMap(db);
  const latestLog = db.getLatestSystemLogForArtifact(
    artifact,
    "prompt_changed",
  );
  const prevHash =
    latestLog?.new_hash ??
    db.getPromptBaselineHash(artifact) ??
    baselineMap.get(artifact) ??
    null;

  // Ensure current raw text is archived in content-addressed system_materials
  db.putSystemMaterial(raw);

  if (!prevHash) {
    baselineMap.set(artifact, hash);
    db.setPromptBaselineHash(artifact, hash);
    return null;
  }

  if (prevHash !== hash) {
    const record = db.appendSystemLog({
      actor,
      kind: "prompt_changed",
      artifact,
      oldHash: prevHash,
      newHash: hash,
      reason: `提示词更新 ${artifact} (version: ${doc.version})`,
      link: `version:${doc.version}`,
    });
    baselineMap.set(artifact, hash);
    db.setPromptBaselineHash(artifact, hash);
    return record;
  }

  baselineMap.set(artifact, hash);
  return null;
}

export function readPrompt(
  name: PromptFileName | (string & {}),
  dir = PROMPTS_DIR,
  db?: EchoreDatabase,
): PromptDoc {
  const filePath = join(dir, name);
  if (!existsSync(filePath)) {
    return { name, text: "", version: 0 };
  }
  const raw = readFileSync(filePath, "utf8");
  const doc = parsePrompt(raw, name);
  if (db) {
    trackPromptReadWithDb(raw, doc, db);
  }
  return doc;
}

/** 列出提示词目录下所有 `.md` 提示词文档（排除 README.md） */
export function listPrompts(
  dir = PROMPTS_DIR,
  db?: EchoreDatabase,
): PromptDoc[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((f) => readPrompt(f, dir, db));
}

/**
 * 启动时记录当前所有提示词原文至 `system_materials` 并建立基线哈希；
 * 若进程重启期间磁盘提示词相比上次 `prompt_changed` 已发生变化，自动补记 `prompt_changed`。
 */
export function seedAndSyncPromptsWithSystemLog(
  db: EchoreDatabase,
  dir = PROMPTS_DIR,
  actor: SystemLogActor = "maker",
): SystemLogRecord[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort();
  const records: SystemLogRecord[] = [];
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    const doc = parsePrompt(raw, f);
    const rec = trackPromptReadWithDb(raw, doc, db, actor);
    if (rec) {
      records.push(rec);
    }
  }
  return records;
}
