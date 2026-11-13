import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { localCalendarDaysBetween } from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
  type MemoryFrontmatter,
  MemoryFrontmatterSchema,
} from "../core/schemas.ts";

export type LintRuleId =
  | "L1"
  | "L2"
  | "L3"
  | "L4"
  | "L5"
  | "L6"
  | "L7"
  | "L8";

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  rule: LintRuleId;
  severity: LintSeverity;
  file: string;
  message: string;
}

export interface LintReport {
  passed: boolean;
  issues: LintIssue[];
  scannedFiles: number;
  skippedUnchangedFiles?: number;
}

export const L8_MIN_BYTES = 300;
export const L8_MIN_SYNCHRONIC_ASSERTIONS = 3;

export function computeAuditFingerprint(
  relPath: string,
  rawContent: string,
): string {
  const hash = Bun.hash.crc32(`${relPath}\0${rawContent}`);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function computeEmbeddingFingerprint(
  whenToRecall: string | undefined,
  body: string,
): string {
  const cue = whenToRecall?.trim() ?? "";
  const hash = Bun.hash.crc32(`${cue}\0${body.trim()}`);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ParsedMemoryFile {
  relPath: string; // e.g. "events/2026-11-05-ankle-healed.md"
  symbolKey: string; // e.g. "events/2026-11-05-ankle-healed"
  frontmatter: MemoryFrontmatter;
  body: string;
  rawContent: string;
}

const SINGLE_VALUED_SYNCHRONIC_PREDICATES = new Set([
  "当前状态",
  "身份",
  "位置",
]);

const DIACHRONIC_EXEMPT_PREDICATES = new Set([
  "历史背景",
  "结转",
  "依据",
  "曾用状态",
  "情境表态",
]);

export const MAX_ASSERTIONS_PER_FILE = 6;
export const MAX_STRUCTURED_BODY_CHARS = 600;
export const MIN_ASSERTION_SEMANTIC_CHARS = 4;

function countSemanticChars(rawArgs: string): number {
  const withoutRefs = rawArgs
    .replace(/\[\[[^\]]+\]\]/g, " ")
    .replace(/\[src:\s*[^\]]+\]/gi, " ")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  return Array.from(withoutRefs).length;
}

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

export function parseStructuredMemoryFile(
  memoryDir: string,
  relPath: string,
): ParsedMemoryFile | null {
  const absPath = path.join(memoryDir, relPath);
  if (!fs.existsSync(absPath)) return null;
  const rawContent = fs.readFileSync(absPath, "utf8");
  const gm = matter(rawContent);
  const frontmatter = MemoryFrontmatterSchema.parse(gm.data);
  const symbolKey = relPath.replace(/\.md$/, "");
  return {
    relPath,
    symbolKey,
    frontmatter,
    body: gm.content,
    rawContent,
  };
}

export function loadStructuredMemoryFiles(
  memoryDir: string,
): ParsedMemoryFile[] {
  const relPaths = walkMarkdownFiles(memoryDir);
  const parsed: ParsedMemoryFile[] = [];

  for (const relPath of relPaths) {
    const file = parseStructuredMemoryFile(memoryDir, relPath);
    if (file) {
      parsed.push(file);
    }
  }
  return parsed;
}

function daysBetween(dateStr: string, now: Date): number {
  return localCalendarDaysBetween(dateStr, now);
}

/**
 * §5 元规则：六项可机检守卫 + L7 颗粒度 + L8 主题内聚 Warning（Memory CI Linter L1~L8）
 */
export function runMemoryLinter(params: {
  memoryDir: string;
  db: EchoreDatabase;
  now: Date;
  incrementalOnly?: boolean;
}): LintReport {
  const { memoryDir, db, now, incrementalOnly = false } = params;
  const issues: LintIssue[] = [];
  const files = loadStructuredMemoryFiles(memoryDir);
  let skippedUnchangedFiles = 0;

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
    const { frontmatter, body, relPath, rawContent } = f;
    const isActiveFile =
      frontmatter.status === "有效" || frontmatter.status === "僵持待解";
    const metaForFingerprint = incrementalOnly
      ? db.getMemoryMeta(frontmatter.id)
      : null;
    const currentFingerprint = computeAuditFingerprint(relPath, rawContent);
    const skipPerFileContentChecks =
      incrementalOnly &&
      metaForFingerprint?.audit_fingerprint !== undefined &&
      metaForFingerprint.audit_fingerprint === currentFingerprint;
    if (skipPerFileContentChecks) {
      skippedUnchangedFiles += 1;
    }

    // L1: 未定义符号拦截 — 扫描所有 [[path/symbol]]
    const symbolMatches = body.matchAll(/\[\[([^\]#]+)(?:#[^\]]+)?\]\]/g);
    for (const match of symbolMatches) {
      const targetSymbol = match[1]?.trim();
      if (!targetSymbol) continue;
      if (!bySymbol.has(targetSymbol)) {
        issues.push({
          rule: "L1",
          severity: "error",
          file: relPath,
          message: `L1 Error: 引用了未定义符号 [[${targetSymbol}]]（请先创建定义档）`,
        });
      }
    }

    // Parse predicate lines in body: - 谓词(参数...)
    const isGranularityCheckedFile =
      relPath !== "INDEX.md" && relPath !== "implicit/rapport.md";
    let assertionBulletCount = 0;
    let perFileContentHasError = false;

    if (
      !skipPerFileContentChecks &&
      isGranularityCheckedFile &&
      body.trim().length > MAX_STRUCTURED_BODY_CHARS
    ) {
      perFileContentHasError = true;
      issues.push({
        rule: "L7",
        severity: "error",
        file: relPath,
        message: `L7 Error: [${frontmatter.id}] 正文长度 ${body.trim().length} 字符超过 ${MAX_STRUCTURED_BODY_CHARS} 字上限（too_coarse），请提炼为原子记忆`,
      });
    }

    const l8CandidateAssertions: Array<{
      entities: Set<string>;
      slotRoots: Set<string>;
    }> = [];

    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) {
        continue;
      }

      const isBullet = trimmed.startsWith("- ");
      const predMatch = trimmed.match(
        /^(?:-\s*)?([^\s(（#>-]+)\s*\((.+)\)\s*(?:\[src:\s*([^\]]+)\])?$/,
      );
      if (!predMatch) {
        if (
          !skipPerFileContentChecks &&
          isBullet &&
          isGranularityCheckedFile
        ) {
          assertionBulletCount += 1;
          perFileContentHasError = true;
          issues.push({
            rule: "L7",
            severity: "error",
            file: relPath,
            message: `L7 Error: [${frontmatter.id}] 断言行未遵循“谓词(参数)”格式（needs_rewrite）: "${trimmed}"`,
          });
        }
        continue;
      }

      assertionBulletCount += 1;
      const predicateName = predMatch[1]!;
      const argsRaw = predMatch[2]!;

      if (
        !skipPerFileContentChecks &&
        isGranularityCheckedFile &&
        countSemanticChars(argsRaw) < MIN_ASSERTION_SEMANTIC_CHARS
      ) {
        perFileContentHasError = true;
        issues.push({
          rule: "L7",
          severity: "error",
          file: relPath,
          message: `L7 Error: [${frontmatter.id}] 断言参数内容过短空洞（needs_rewrite）: "${trimmed}"`,
        });
      }

      // L2: 共时失效状态引用拦截（除历时溯源豁免谓词外，所有共时谓词均不得指向已取代/已沉底文件）
      if (isActiveFile && !DIACHRONIC_EXEMPT_PREDICATES.has(predicateName)) {
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
              severity: "error",
              file: relPath,
              message: `L2 Error: 活跃文件 [${frontmatter.id}] 的共时谓词 ${predicateName}() 仍指向${targetFile.frontmatter.status}状态 [${targetFile.frontmatter.id}]`,
            });
          }
        }
      }

      // L8: 收集 events/*.md 与 concerns/*.md 的共时断言实体与 #slot 锚点
      if (
        !skipPerFileContentChecks &&
        (relPath.startsWith("events/") || relPath.startsWith("concerns/")) &&
        !DIACHRONIC_EXEMPT_PREDICATES.has(predicateName)
      ) {
        const entities = new Set<string>();
        const slotRoots = new Set<string>();
        const anchorMatches = argsRaw.matchAll(
          /\[\[([^\]#]+)\]\](?:#([^\s,，)]+))?/g,
        );
        for (const am of anchorMatches) {
          const sym = am[1]?.trim();
          if (sym && sym !== "people/user" && sym !== "people/self") {
            entities.add(sym);
          }
          const rawSlot = am[2]?.trim();
          if (rawSlot) {
            const root = rawSlot.split(/[_:/-]/)[0]?.trim() || rawSlot;
            slotRoots.add(root);
          }
        }
        l8CandidateAssertions.push({ entities, slotRoots });
      }

      // L4: 同符号有效断言冲突
      // Match pattern: 谓词([[subject]]#slot, value) 或单值共时谓词([[subject]], value)
      if (
        frontmatter.status === "有效" &&
        !DIACHRONIC_EXEMPT_PREDICATES.has(predicateName)
      ) {
        const slotArgMatch = argsRaw.match(
          /^\s*(\[\[[^\]]+\]\](?:#[^,\s]+)?)\s*,\s*(.+)$/,
        );
        if (slotArgMatch) {
          const subjectSlot = slotArgMatch[1]!.trim();
          const hasExplicitSlot = subjectSlot.includes("#");
          if (
            hasExplicitSlot ||
            SINGLE_VALUED_SYNCHRONIC_PREDICATES.has(predicateName)
          ) {
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
    }

    if (!skipPerFileContentChecks && isGranularityCheckedFile) {
      if (assertionBulletCount === 0) {
        perFileContentHasError = true;
        issues.push({
          rule: "L7",
          severity: "error",
          file: relPath,
          message: `L7 Error: [${frontmatter.id}] 缺失任何结构化断言行（needs_rewrite）`,
        });
      } else if (assertionBulletCount > MAX_ASSERTIONS_PER_FILE) {
        perFileContentHasError = true;
        issues.push({
          rule: "L7",
          severity: "error",
          file: relPath,
          message: `L7 Error: [${frontmatter.id}] 单文件包含 ${assertionBulletCount} 条断言（超过 ${MAX_ASSERTIONS_PER_FILE} 条上限，too_coarse），请按独立事件拆分`,
        });
      }
    }

    if (!skipPerFileContentChecks) {
      db.setMemoryAuditFingerprint(
        frontmatter.id,
        perFileContentHasError ? null : currentFingerprint,
      );
    }

    // L8 Warning: 单文件主题混装健康度检测（仅 Warning，不阻断 passed）
    if (
      !skipPerFileContentChecks &&
      (relPath.startsWith("events/") || relPath.startsWith("concerns/")) &&
      Buffer.byteLength(body.trim(), "utf8") >= L8_MIN_BYTES &&
      l8CandidateAssertions.length >= L8_MIN_SYNCHRONIC_ASSERTIONS
    ) {
      const anchored = l8CandidateAssertions.filter(
        (a) => a.entities.size > 0 || a.slotRoots.size > 0,
      );
      if (anchored.length === l8CandidateAssertions.length) {
        const parent = anchored.map((_, idx) => idx);
        const find = (x: number): number => {
          while (parent[x] !== x) {
            parent[x] = parent[parent[x]!]!;
            x = parent[x]!;
          }
          return x;
        };
        const union = (a: number, b: number): void => {
          const ra = find(a);
          const rb = find(b);
          if (ra !== rb) parent[rb] = ra;
        };
        for (let i = 0; i < anchored.length; i++) {
          for (let j = i + 1; j < anchored.length; j++) {
            const a = anchored[i]!;
            const b = anchored[j]!;
            const sharesEntity = Array.from(a.entities).some((e) =>
              b.entities.has(e),
            );
            const sharesSlot = Array.from(a.slotRoots).some((s) =>
              b.slotRoots.has(s),
            );
            if (sharesEntity || sharesSlot) {
              union(i, j);
            }
          }
        }
        const roots = new Set(anchored.map((_, idx) => find(idx)));
        if (roots.size >= 2) {
          issues.push({
            rule: "L8",
            severity: "warning",
            file: relPath,
            message: `L8 Warning: [${frontmatter.id}] 正文达 ${Buffer.byteLength(body.trim(), "utf8")}B 且含 ${roots.size} 个互不相连的实体/#slot 主题分量（topic_drift），建议视情况拆分`,
          });
        }
      }
    }

    // L3 recording
    if (frontmatter.supersedes) {
      const targetIds = frontmatter.supersedes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const targetId of targetIds) {
        const list = supersededByMap.get(targetId) ?? [];
        list.push(frontmatter.id);
        supersededByMap.set(targetId, list);

        const oldFile = byId.get(targetId);
        if (!oldFile) {
          issues.push({
            rule: "L3",
            severity: "error",
            file: relPath,
            message: `L3 Error: [${frontmatter.id}] 宣告取代不存在的记录 [${targetId}]`,
          });
        } else if (oldFile.frontmatter.status !== "已取代") {
          issues.push({
            rule: "L3",
            severity: "error",
            file: relPath,
            message: `L3 Error: [${targetId}] 仍为“${oldFile.frontmatter.status}”，但已被 [${frontmatter.id}] 宣告取代`,
          });
        }
      }
    }

    // L5: 原文指针完备性
    if (relPath.startsWith("events/") || relPath.startsWith("concerns/")) {
      const srcId = frontmatter.source_event_id;
      if (!srcId || !srcId.startsWith("log-")) {
        issues.push({
          rule: "L5",
          severity: "error",
          file: relPath,
          message: `L5 Error: [${frontmatter.id}] 缺失合法的 source_event_id 原文指针`,
        });
      } else if (!db.getEventLogById(srcId)) {
        if (db.isEventIdDeletedInSystemLog(srcId)) {
          issues.push({
            rule: "L5",
            severity: "warning",
            file: relPath,
            message: `L5 Warning (orphaned_by_deletion): [${frontmatter.id}] 的 source_event_id [${srcId}] 对应原始消息已被删除，标为孤儿记忆`,
          });
        } else {
          issues.push({
            rule: "L5",
            severity: "error",
            file: relPath,
            message: `L5 Error: [${frontmatter.id}] 的 source_event_id [${srcId}] 在 SQLite Event Log 中不存在`,
          });
        }
      }
    } else if (relPath === "implicit/rapport.md") {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("- ")) continue;
        const srcMatch = trimmed.match(/\[src:\s*(log-[^\]]+)\]\s*$/);
        if (!srcMatch) {
          issues.push({
            rule: "L5",
            severity: "error",
            file: relPath,
            message: `L5 Error: rapport.md 规则行缺失 [src: log-xxx] 行级溯源: "${trimmed}"`,
          });
        } else {
          const logId = srcMatch[1]!.trim();
          if (!db.getEventLogById(logId)) {
            if (db.isEventIdDeletedInSystemLog(logId)) {
              issues.push({
                rule: "L5",
                severity: "warning",
                file: relPath,
                message: `L5 Warning (orphaned_by_deletion): rapport.md 引用的 [${logId}] 对应原始消息已被删除，标为孤儿规则`,
              });
            } else {
              issues.push({
                rule: "L5",
                severity: "error",
                file: relPath,
                message: `L5 Error: rapport.md 引用的 [${logId}] 在 SQLite Event Log 中不存在`,
              });
            }
          }
        }
      }
    }

    // L6: 牵挂注分级流转体检
    if (relPath.startsWith("concerns/") || frontmatter.type === "牵挂注") {
      const tier = frontmatter.tier;
      if (!tier || tier === "normal") {
        issues.push({
          rule: "L6",
          severity: "error",
          file: relPath,
          message: `L6 Gate: 牵挂注 [${frontmatter.id}] 缺失合法的 tier 分级（需为 minor_worry | conflict | scar）`,
        });
      } else {
        const ageDays = daysBetween(frontmatter.date, now);
        if (
          tier === "minor_worry" &&
          frontmatter.status === "有效" &&
          ageDays >= 7
        ) {
          issues.push({
            rule: "L6",
            severity: "error",
            file: relPath,
            message: `L6 Gate: T1 日常微澜 [${frontmatter.id}] 已满 ${ageDays} 天仍为“有效”，需推入冷写归档为“已淡化”`,
          });
        } else if (tier === "conflict") {
          if (frontmatter.status === "有效" && ageDays >= 5) {
            issues.push({
              rule: "L6",
              severity: "error",
              file: relPath,
              message: `L6 Gate: T2 冲突牵挂 [${frontmatter.id}] 已满 ${ageDays} 天，需从急性期切换为“僵持待解(冷战封顶)”`,
            });
          } else if (frontmatter.status === "僵持待解" && ageDays >= 21) {
            issues.push({
              rule: "L6",
              severity: "error",
              file: relPath,
              message: `L6 Gate: T2 冲突牵挂 [${frontmatter.id}] 已僵持 ${ageDays} 天未解，需结转为“已结痂(T3)”并写入 rapport.md 雷区`,
            });
          }
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
          severity: "error",
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
        severity: "error",
        file: assertions[0]!.file,
        message: `L4 Merge Conflict: ${subjectSlot} 同时存在多个互斥的有效状态: [${distinctValues.join(", ")}]`,
      });
    }
  }

  return {
    passed: issues.every((i) => i.severity !== "error"),
    issues,
    scannedFiles: files.length,
    ...(incrementalOnly ? { skippedUnchangedFiles } : {}),
  };
}
