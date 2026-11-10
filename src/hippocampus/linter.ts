import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { EchoreDatabase } from "../core/db.ts";
import {
  type MemoryFrontmatter,
  MemoryFrontmatterSchema,
} from "../core/schemas.ts";

export type LintRuleId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

export interface LintIssue {
  rule: LintRuleId;
  file: string;
  message: string;
}

export interface LintReport {
  passed: boolean;
  issues: LintIssue[];
  scannedFiles: number;
}

export interface ParsedMemoryFile {
  relPath: string; // e.g. "events/2026-11-05-ankle-healed.md"
  symbolKey: string; // e.g. "events/2026-11-05-ankle-healed"
  frontmatter: MemoryFrontmatter;
  body: string;
  rawContent: string;
}

const SYNCHRONIC_PREDICATES = new Set([
  "当前状态",
  "挂钩",
  "身份",
  "关联状态",
  "偏好",
  "位置",
]);

const DIACHRONIC_EXEMPT_PREDICATES = new Set([
  "历史背景",
  "结转",
  "依据",
  "曾用状态",
]);

function walkMarkdownFiles(baseDir: string, subDir = ""): string[] {
  const target = path.join(baseDir, subDir);
  if (!fs.existsSync(target)) return [];
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const rel = path.posix.join(subDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "journal" || entry.name === "solitary") {
        // journal/ 为前台自由热记事与冷叙事原稿，solitary/ 为独居原始产物，非结构化断言编译区
        continue;
      }
      results.push(...walkMarkdownFiles(baseDir, rel));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(rel);
    }
  }
  return results;
}

export function loadStructuredMemoryFiles(
  memoryDir: string,
): ParsedMemoryFile[] {
  const relPaths = walkMarkdownFiles(memoryDir);
  const parsed: ParsedMemoryFile[] = [];

  for (const relPath of relPaths) {
    const absPath = path.join(memoryDir, relPath);
    const rawContent = fs.readFileSync(absPath, "utf8");
    const gm = matter(rawContent);
    const frontmatter = MemoryFrontmatterSchema.parse(gm.data);
    const symbolKey = relPath.replace(/\.md$/, "");
    parsed.push({
      relPath,
      symbolKey,
      frontmatter,
      body: gm.content,
      rawContent,
    });
  }
  return parsed;
}

function daysBetween(dateStr: string, now: Date): number {
  const start = new Date(`${dateStr}T00:00:00Z`).getTime();
  const current = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.floor((current - start) / (24 * 3600 * 1000));
}

/**
 * §5 元规则：六项可机检守卫（Memory CI Linter L1~L6）
 */
export function runMemoryLinter(params: {
  memoryDir: string;
  db: EchoreDatabase;
  now: Date;
}): LintReport {
  const { memoryDir, db, now } = params;
  const issues: LintIssue[] = [];
  const files = loadStructuredMemoryFiles(memoryDir);

  const bySymbol = new Map<string, ParsedMemoryFile>();
  const byId = new Map<string, ParsedMemoryFile>();
  for (const f of files) {
    bySymbol.set(f.symbolKey, f);
    byId.set(f.frontmatter.id, f);
  }

  // Track supersedes targets for L3
  const supersededByMap = new Map<string, string[]>();
  // Track synchronic assertions for L4: key = "predicate::[[subject]]#slot" -> Array<{ value, file }>
  const synchronicSlotValues = new Map<
    string,
    Array<{ value: string; file: string; id: string }>
  >();

  for (const f of files) {
    const { frontmatter, body, relPath } = f;
    const isActiveFile =
      frontmatter.status === "有效" || frontmatter.status === "僵持待解";

    // L1: 未定义符号拦截 — 扫描所有 [[path/symbol]]
    const symbolMatches = body.matchAll(/\[\[([^\]#]+)(?:#[^\]]+)?\]\]/g);
    for (const match of symbolMatches) {
      const targetSymbol = match[1]?.trim();
      if (!targetSymbol) continue;
      if (!bySymbol.has(targetSymbol)) {
        issues.push({
          rule: "L1",
          file: relPath,
          message: `L1 Error: 引用了未定义符号 [[${targetSymbol}]]（请先创建定义档）`,
        });
      }
    }

    // Parse predicate lines in body: - 谓词(参数...)
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) continue;

      const predMatch = trimmed.match(/^-\s*([^\s(（]+)\s*\((.+)\)\s*(?:\[src:\s*([^\]]+)\])?$/);
      if (!predMatch) continue;

      const predicateName = predMatch[1]!;
      const argsRaw = predMatch[2]!;

      // L2: 共时失效状态引用拦截
      if (
        isActiveFile &&
        !DIACHRONIC_EXEMPT_PREDICATES.has(predicateName) &&
        SYNCHRONIC_PREDICATES.has(predicateName)
      ) {
        const refMatches = argsRaw.matchAll(/\[\[([^\]#]+)(?:#[^\]]+)?\]\]/g);
        for (const rm of refMatches) {
          const refSym = rm[1]?.trim();
          if (!refSym) continue;
          const targetFile = bySymbol.get(refSym);
          if (
            targetFile &&
            (targetFile.frontmatter.status === "已取代" ||
              targetFile.frontmatter.status === "已沉底")
          ) {
            issues.push({
              rule: "L2",
              file: relPath,
              message: `L2 Error: 活跃文件 [${frontmatter.id}] 的共时谓词 ${predicateName}() 仍指向${targetFile.frontmatter.status}状态 [${targetFile.frontmatter.id}]`,
            });
          }
        }
      }

      // L4: 同符号有效断言冲突
      // Match pattern: 谓词([[subject]]#slot, value)
      if (frontmatter.status === "有效" && SYNCHRONIC_PREDICATES.has(predicateName)) {
        const slotArgMatch = argsRaw.match(
          /^\s*(\[\[[^\]]+\]\]#[^,\s]+)\s*,\s*(.+)$/,
        );
        if (slotArgMatch) {
          const subjectSlot = slotArgMatch[1]!.trim();
          const assertedValue = slotArgMatch[2]!.trim();
          const slotKey = `${predicateName}::${subjectSlot}`;
          const existing = synchronicSlotValues.get(slotKey) ?? [];
          existing.push({
            value: assertedValue,
            file: relPath,
            id: frontmatter.id,
          });
          synchronicSlotValues.set(slotKey, existing);
        }
      }
    }

    // L3 recording
    if (frontmatter.supersedes) {
      const targetId = frontmatter.supersedes;
      const list = supersededByMap.get(targetId) ?? [];
      list.push(frontmatter.id);
      supersededByMap.set(targetId, list);

      const oldFile = byId.get(targetId);
      if (!oldFile) {
        issues.push({
          rule: "L3",
          file: relPath,
          message: `L3 Error: [${frontmatter.id}] 宣告取代不存在的记录 [${targetId}]`,
        });
      } else if (oldFile.frontmatter.status !== "已取代") {
        issues.push({
          rule: "L3",
          file: relPath,
          message: `L3 Error: [${targetId}] 仍为“${oldFile.frontmatter.status}”，但已被 [${frontmatter.id}] 宣告取代`,
        });
      }
    }

    // L5: 原文指针完备性
    if (relPath.startsWith("events/") || relPath.startsWith("concerns/")) {
      const srcId = frontmatter.source_event_id;
      if (!srcId || !srcId.startsWith("log-")) {
        issues.push({
          rule: "L5",
          file: relPath,
          message: `L5 Error: [${frontmatter.id}] 缺失合法的 source_event_id 原文指针`,
        });
      } else if (!db.getEventLogById(srcId)) {
        issues.push({
          rule: "L5",
          file: relPath,
          message: `L5 Error: [${frontmatter.id}] 的 source_event_id [${srcId}] 在 SQLite Event Log 中不存在`,
        });
      }
    } else if (relPath === "implicit/rapport.md") {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("- ")) continue;
        const srcMatch = trimmed.match(/\[src:\s*(log-[^\]]+)\]\s*$/);
        if (!srcMatch) {
          issues.push({
            rule: "L5",
            file: relPath,
            message: `L5 Error: rapport.md 规则行缺失 [src: log-xxx] 行级溯源: "${trimmed}"`,
          });
        } else {
          const logId = srcMatch[1]!.trim();
          if (!db.getEventLogById(logId)) {
            issues.push({
              rule: "L5",
              file: relPath,
              message: `L5 Error: rapport.md 引用的 [${logId}] 在 SQLite Event Log 中不存在`,
            });
          }
        }
      }
    }

    // L6: 牵挂注分级流转体检
    if (relPath.startsWith("concerns/") || frontmatter.type === "牵挂注") {
      const tier = frontmatter.tier;
      const ageDays = daysBetween(frontmatter.date, now);
      if (tier === "minor_worry" && frontmatter.status === "有效" && ageDays >= 7) {
        issues.push({
          rule: "L6",
          file: relPath,
          message: `L6 Gate: T1 日常微澜 [${frontmatter.id}] 已满 ${ageDays} 天仍为“有效”，需推入冷写归档为“已淡化”`,
        });
      } else if (tier === "conflict") {
        if (frontmatter.status === "有效" && ageDays >= 5) {
          issues.push({
            rule: "L6",
            file: relPath,
            message: `L6 Gate: T2 冲突牵挂 [${frontmatter.id}] 已满 ${ageDays} 天，需从急性期切换为“僵持待解(冷战封顶)”`,
          });
        } else if (frontmatter.status === "僵持待解" && ageDays >= 21) {
          issues.push({
            rule: "L6",
            file: relPath,
            message: `L6 Gate: T2 冲突牵挂 [${frontmatter.id}] 已僵持 ${ageDays} 天未解，需结转为“已结痂(T3)”并写入 rapport.md 雷区`,
          });
        }
      }
    }
  }

  // L3 reverse check: any file with status === "已取代" must be pointed to by at least one file
  for (const f of files) {
    if (f.frontmatter.status === "已取代") {
      const pointers = supersededByMap.get(f.frontmatter.id);
      if (!pointers || pointers.length === 0) {
        issues.push({
          rule: "L3",
          file: f.relPath,
          message: `L3 Error: [${f.frontmatter.id}] 状态为“已取代”，但没有任何新文件通过 supersedes 指向它`,
        });
      }
    }
  }

  // L4 check for conflicting active values on the same subject#slot
  for (const [slotKey, assertions] of synchronicSlotValues.entries()) {
    const distinctValues = Array.from(new Set(assertions.map((a) => a.value)));
    if (distinctValues.length > 1) {
      const subjectSlot = slotKey.split("::")[1]!;
      issues.push({
        rule: "L4",
        file: assertions[0]!.file,
        message: `L4 Merge Conflict: ${subjectSlot} 同时存在多个互斥的有效状态: [${distinctValues.join(", ")}]`,
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    scannedFiles: files.length,
  };
}
