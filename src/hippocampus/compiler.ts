import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  formatLocalDateStr,
  localCalendarDaysBetween,
} from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type ChronotypeId,
  type CompilationPlan,
  CompilationPlanSchema,
  type CompiledMemorySpec,
  type EndocrineNightVerdict,
  type EventLogRecord,
  type MemoryFrontmatter,
  type RapportRuleSpec,
} from "../core/schemas.ts";
import {
  extractColdReflectionForDate,
  extractFeedbackTriplets,
  extractHotEntriesForDate,
} from "../frontstage/journal.ts";
import type { OrganModelRouter } from "../llm/router.ts";
import {
  syncMemoryMetaFromFiles,
  writeUpdatedFrontmatter,
} from "./decay.ts";
import {
  type LintReport,
  loadStructuredMemoryFiles,
  type ParsedMemoryFile,
  runMemoryLinter,
} from "./linter.ts";

export interface NightlyCompilerParams {
  memoryDir: string;
  db: EchoreDatabase;
  router?: OrganModelRouter;
  now: Date;
  dateStr: string;
  verdict: EndocrineNightVerdict;
  coldReflection: string;
  planOverride?: CompilationPlan;
  /** 是否允许显式取代受保护的钉子记忆（allow_forget: false 的非短期状态记忆 / 符号定义档），默认 false */
  allowSupersedeProtected?: boolean;
  chronotype?: ChronotypeId;
  /** 可选直接注入本轮睡眠待编译的增量事件集（默认由 db.getUnsettledEventLogs 游标获取） */
  todaysEvents?: EventLogRecord[];
}

export type SlotConflictReason =
  | "protected_nail_memory"
  | "unconfirmed_preference_or_event_collision";

export interface PendingSlotConflict {
  slotKey: string;
  existingId: string;
  existingFile: string;
  incomingId: string;
  incomingFile: string;
  incomingValue: string;
  reason: SlotConflictReason;
}

export interface NightlyCompileResult {
  writtenFiles: string[];
  supersededIds: string[];
  updatedConcernIds: string[];
  addedRapportRules: string[];
  pendingConflicts: PendingSlotConflict[];
  lintReport: LintReport;
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

function isProtectedNailFile(file: ParsedMemoryFile): boolean {
  if (
    file.relPath.startsWith("people/") ||
    file.frontmatter.type === "符号定义" ||
    file.frontmatter.type === "内隐默契" ||
    file.frontmatter.tier === "scar"
  ) {
    return true;
  }
  if (!file.frontmatter.allow_forget) {
    // 客观短期状态品类（health / schedule 的伤病、日程流转）允许按状态演进正常闭环取代；
    // 其余（preference / life_event / chat）一旦标为 allow_forget: false 即为不可自动覆写的钉子记忆
    return (
      file.frontmatter.category !== "health" &&
      file.frontmatter.category !== "schedule"
    );
  }
  return false;
}

function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "item";
}

function escapePredicateText(text: string): string {
  return text
    .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
    .replace(/["\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExistingNarrative(body: string): string | null {
  const quoteLines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^>\s*/, "").trim())
    .filter(Boolean);
  return quoteLines.length > 0 ? quoteLines.join(" ") : null;
}

function formatCompiledMarkdownBody(
  assertions: string[],
  frontstageNarrative: string,
): string {
  const normalizedAssertions = assertions.map((a) => {
    const trimmed = a.trim().replace(/\s*\[src:\s*log-[^\]]+\]/gi, "");
    return trimmed.startsWith("- ") ? trimmed : `- ${trimmed}`;
  });

  const cleanNarrative = frontstageNarrative
    .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
    .replace(/^>\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  assertNoInternalLeaks(cleanNarrative, "compiler.frontstageNarrative");

  return [
    "## 断言",
    ...normalizedAssertions,
    "",
    "## 前台原叙",
    `> ${cleanNarrative}`,
    "",
  ].join("\n");
}

function writeCompiledMarkdownFile(params: {
  memoryDir: string;
  relPath: string;
  frontmatter: MemoryFrontmatter;
  assertions: string[];
  frontstageNarrative: string;
}): void {
  const absPath = path.join(params.memoryDir, params.relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const body = formatCompiledMarkdownBody(
    params.assertions,
    params.frontstageNarrative,
  );
  writeUpdatedFrontmatter(absPath, params.frontmatter, body);
}

/**
 * 追加规则行到 `implicit/rapport.md` 对应章节，确保附带合法 `[src: log-xxx]` 且不重复
 */
export function appendRapportRulesToFile(params: {
  memoryDir: string;
  db: EchoreDatabase;
  rules: RapportRuleSpec[];
  now: Date;
}): string[] {
  const { memoryDir, db, rules, now } = params;
  if (rules.length === 0) return [];

  const rapportPath = path.join(memoryDir, "implicit", "rapport.md");
  fs.mkdirSync(path.dirname(rapportPath), { recursive: true });
  if (!fs.existsSync(rapportPath)) {
    const initRapport = [
      "---",
      "id: imp-rapport",
      "type: 内隐默契",
      `date: ${formatLocalDateStr(now)}`,
      "status: 有效",
      "category: preference",
      "allow_forget: false",
      "---",
      "",
      "## 专属称呼与黑话",
      "",
      "## 语感与边界默契",
      "",
      "## 结痂雷区",
      "",
    ].join("\n");
    fs.writeFileSync(rapportPath, initRapport, "utf8");
  }

  let raw = fs.readFileSync(rapportPath, "utf8");
  const added: string[] = [];

  for (const rule of rules) {
    if (!db.getEventLogById(rule.source_event_id)) {
      continue;
    }

    const baseLine = rule.predicate_line
      .trim()
      .replace(/^-\s*/, "")
      .replace(/\s*\[src:\s*[^\]]+\]\s*$/, "")
      .trim();
    const formattedLine = `- ${baseLine} [src: ${rule.source_event_id}]`;

    // Wave 4.2: 若指定了 revises_rule_prefix（默契反例条件收窄/分化），就地替换原规则行并更新 [src: log-xxx]
    if (rule.revises_rule_prefix?.trim()) {
      const targetPrefix = rule.revises_rule_prefix
        .trim()
        .replace(/^-\s*/, "");
      const lines = raw.split(/\r?\n/);
      const matchIdx = lines.findIndex((l) => {
        const t = l.trim();
        return t.startsWith("- ") && t.includes(targetPrefix);
      });
      if (matchIdx !== -1) {
        lines[matchIdx] = formattedLine;
        raw = lines.join("\n");
        added.push(formattedLine);
        continue;
      }
    }

    if (raw.includes(baseLine) || raw.includes(formattedLine)) {
      continue;
    }

    const sectionHeader = `## ${rule.section}`;
    const idx = raw.indexOf(sectionHeader);
    if (idx !== -1) {
      const insertPos = idx + sectionHeader.length;
      raw = `${raw.slice(0, insertPos)}\n${formattedLine}${raw.slice(insertPos)}`;
    } else {
      raw = `${raw.trimEnd()}\n\n${sectionHeader}\n${formattedLine}\n`;
    }
    added.push(formattedLine);
  }

  if (added.length > 0) {
    const parsed = matter(raw);
    const updatedFm: MemoryFrontmatter = {
      id: String(parsed.data.id ?? "imp-rapport"),
      type: "内隐默契",
      date: formatLocalDateStr(now),
      status: "有效",
      category: "preference",
      allow_forget: false,
    };
    writeUpdatedFrontmatter(rapportPath, updatedFm, parsed.content);
  }

  return added;
}

/**
 * 修正活跃文件中指向 `已取代` 或 `已沉底` 目标的共时谓词（转为历时谓词 `历史背景` 或指向新符号），确保 L2 闭合
 */
export function reconcileSynchronicLinksToInactiveFiles(params: {
  memoryDir: string;
  supersededReplacementMap?: Map<string, string>; // oldSymbolKey -> newSymbolKey
}): void {
  const { memoryDir, supersededReplacementMap = new Map() } = params;
  const files = loadStructuredMemoryFiles(memoryDir);
  const bySymbol = new Map<string, ParsedMemoryFile>();
  for (const f of files) {
    bySymbol.set(f.symbolKey, f);
  }

  for (const f of files) {
    if (f.relPath === "INDEX.md" || f.relPath === "implicit/rapport.md") {
      continue;
    }
    const isActive =
      f.frontmatter.status === "有效" || f.frontmatter.status === "僵持待解";
    if (!isActive) continue;

    let fileModified = false;
    const updatedLines = f.body.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) return line;
      const predMatch = trimmed.match(
        /^-\s*([^\s(（]+)\s*\((.+)\)\s*(?:\[src:\s*([^\]]+)\])?$/,
      );
      if (!predMatch) return line;

      const predicateName = predMatch[1]!;
      const argsRaw = predMatch[2]!;
      const srcSuffix = predMatch[3] ? ` [src: ${predMatch[3]}]` : "";

      if (DIACHRONIC_EXEMPT_PREDICATES.has(predicateName)) {
        return line;
      }

      let nextArgs = argsRaw;
      let shouldConvertToDiachronic = false;
      let lineModified = false;

      const refMatches = Array.from(
        argsRaw.matchAll(/\[\[([^\]#]+)(#[^\]]+)?\]\]/g),
      );
      for (const rm of refMatches) {
        const refSym = rm[1]?.trim();
        const slotSuffix = rm[2] ?? "";
        if (!refSym) continue;
        const target = bySymbol.get(refSym);
        if (
          target &&
          (target.frontmatter.status === "已取代" ||
            target.frontmatter.status === "已沉底")
        ) {
          const replacementSym = supersededReplacementMap.get(refSym);
          if (replacementSym && bySymbol.has(replacementSym)) {
            nextArgs = nextArgs.replace(
              `[[${refSym}${slotSuffix}]]`,
              `[[${replacementSym}${slotSuffix}]]`,
            );
            lineModified = true;
            fileModified = true;
          } else {
            shouldConvertToDiachronic = true;
            lineModified = true;
            fileModified = true;
          }
        }
      }

      const finalPred = shouldConvertToDiachronic ? "历史背景" : predicateName;
      if (lineModified) {
        return `- ${finalPred}(${nextArgs})${srcSuffix}`;
      }
      return line;
    });

    if (fileModified) {
      const absPath = path.join(memoryDir, f.relPath);
      writeUpdatedFrontmatter(absPath, f.frontmatter, updatedLines.join("\n"));
    }
  }
}

async function generateCompilationPlanWithOrgan(params: {
  router: OrganModelRouter;
  dateStr: string;
  coldReflection: string;
  hotEntries: string[];
  verdict: EndocrineNightVerdict;
  existingFiles: ParsedMemoryFile[];
  todaysEvents: Array<{
    id: string;
    timestamp?: string;
    role: string;
    speaker: string;
    content: string;
  }>;
}): Promise<ReturnType<typeof CompilationPlanSchema.parse>> {
  const {
    router,
    dateStr,
    coldReflection,
    hotEntries,
    verdict,
    existingFiles,
    todaysEvents,
  } = params;

  if (todaysEvents.length === 0) {
    return { memories: [], rapport_rules: [] };
  }

  const route = router.getRoute("compiler");
  const activeSummary = existingFiles
    .filter(
      (f) =>
        (f.frontmatter.status === "有效" ||
          f.frontmatter.status === "僵持待解") &&
        f.relPath !== "INDEX.md" &&
        f.relPath !== "implicit/rapport.md",
    )
    .map(
      (f) =>
        `- id: ${f.frontmatter.id} | symbol: [[${f.symbolKey}]] | status: ${f.frontmatter.status} | body: ${f.body.replace(/\s+/g, " ").slice(0, 140)}`,
    )
    .join("\n");

  const logsText = todaysEvents
    .map((e) => `- [${e.id}] (${e.role}/${e.speaker}): ${e.content}`)
    .join("\n");

  const triplets = extractFeedbackTriplets(
    todaysEvents.map((e) => ({
      id: e.id,
      timestamp: e.timestamp ?? `${dateStr}T12:00:00.000Z`,
      role: (e.role === "user" || e.role === "assistant" || e.role === "solitary"
        ? e.role
        : "system") as "user" | "assistant" | "solitary" | "system",
      speaker: e.speaker,
      content: e.content,
      metadata: {},
    })),
  );
  const tripletsText = triplets
    .map((t) => {
      const p = t.prev ? `[${t.prev.id}] 他说: "${t.prev.content}"` : "（段首）";
      const a = t.acts.map((x) => `[${x.id}] 我回: "${x.content}"`).join(" / ");
      const n = t.next
        ? `[${t.next.id}] 他随后反应: "${t.next.content}"`
        : "（未再接话）";
      return `- ${p} -> ${a} -> ${n}`;
    })
    .join("\n");

  const system = [
    "你是 Echore 的后台记忆官（夜间唯一 Markdown 编译器）。",
    "请根据今日原始对话事件（带 log-* ID）、双向反馈三联链（prev -> acts -> next）、前台睡前自省冷叙事与现有活跃记忆，输出需要新增或状态变更的结构化编译计划 JSON。",
    "铁律：",
    "1. frontstage_narrative 必须原样采用前台日记中的第一人称原话，绝不自己捏造心理活动，且不得包含 log-* 或浮点数；",
    "2. 严格区分四种情况决定是否填 supersedes：",
    "   (a) 客观事实/状态迭代（如脚伤康复取代之前的脚踝扭伤、行程变更）-> 必须在 supersedes 填入旧记忆的 id；",
    "   (b) 一时情绪气话、(c) 反话/打趣玩笑、(d) 特定情境下的临时表态 -> 严禁填 supersedes 覆盖长期偏好或身份设定，应使用“情境表态(...)”谓词记录当晚片段；",
    "3. 若双向反馈链中出现反例证明某条既有 rapport 默契规则过于宽泛，可在 rapport_rules 中填写 revises_rule_prefix 收窄其适用条件；",
    "4. 单文件断言控制在 1~6 条以内（原子化记忆），source_event_id 必须严格选用今日事件日志中真实存在的 log-* ID；",
    "5. 仅输出合法的 JSON 对象，结构符合：{ memories: [...], rapport_rules: [...] }。",
  ].join("\n");

  const resp = await route.provider.generate({
    model: route.model,
    maxTokens: 1024,
    system,
    messages: [
      {
        role: "user",
        content: [
          `[当前日期]\n${dateStr}`,
          `[今日前台热记事]\n${hotEntries.join("\n") || "（无）"}`,
          `[今日前台睡前自省原肉]\n${coldReflection}`,
          `[今日双向原话反馈链 (prev -> acts -> next)]\n${tripletsText || "（无）"}`,
          `[情绪官夜间裁决单]\n${JSON.stringify(verdict.items)}`,
          `[现有活跃结构化记忆]\n${activeSummary || "（无）"}`,
          `[今日 SQLite 原始事件日志]\n${logsText}`,
        ].join("\n\n"),
      },
    ],
  });

  try {
    const jsonMatch = resp.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return CompilationPlanSchema.parse(JSON.parse(jsonMatch[0]));
    }
  } catch {
    // Fallback if LLM response is not a valid CompilationPlan JSON
  }

  return { memories: [], rapport_rules: [] };
}

/**
 * §1.2 夜相 Step 3 & §3.3–§3.5：记忆官夜间唯一 Markdown 编译器
 * - 统一编译 `people/`、`events/`、`concerns/`、`implicit/rapport.md`
 * - 维护 `supersedes` 取代链（自动将旧文件设为 `已取代` 并解决 L2/L3/L4 冲突）
 * - 原样保留前台第一人称叙事原肉（`## 前台原叙`）
 */
export async function runNightlyCompiler(
  params: NightlyCompilerParams,
): Promise<NightlyCompileResult> {
  const {
    memoryDir,
    db,
    router,
    now,
    dateStr,
    verdict,
    coldReflection,
    planOverride,
  } = params;

  const hotEntries = extractHotEntriesForDate(memoryDir, dateStr);
  const effectiveReflection =
    coldReflection.trim() ||
    extractColdReflectionForDate(memoryDir, dateStr) ||
    hotEntries[hotEntries.length - 1] ||
    "（当日无新增前台记事）";

  const allowedFrontstageCorpus = [
    coldReflection.trim(),
    extractColdReflectionForDate(memoryDir, dateStr) ?? "",
    ...hotEntries,
  ]
    .filter(Boolean)
    .join("\n");

  const writtenFiles: string[] = [];
  const supersededIds: string[] = [];
  const updatedConcernIds: string[] = [];
  const addedRapportRules: string[] = [];
  const pendingConflicts: PendingSlotConflict[] = [];
  const supersededReplacementMap = new Map<string, string>();

  // 1. 根据情绪官《情绪结转裁决单》编译/更新 `concerns/*.md`
  const currentFiles = loadStructuredMemoryFiles(memoryDir);
  const byId = new Map<string, ParsedMemoryFile>();
  for (const f of currentFiles) {
    byId.set(f.frontmatter.id, f);
  }

  const scarRulesToAppend: RapportRuleSpec[] = [];
  const handledConcernIds = new Set<string>();

  if (verdict.items.length > 0) {
    for (const defaultPerson of ["user", "self"] as const) {
      const personRelPath = `people/${defaultPerson}.md`;
      const personFullPath = path.join(memoryDir, personRelPath);
      if (!fs.existsSync(personFullPath)) {
        const personFm: MemoryFrontmatter = {
          id: defaultPerson,
          type: "符号定义",
          date: dateStr,
          status: "有效",
          category: "preference",
          allow_forget: false,
        };
        writeCompiledMarkdownFile({
          memoryDir,
          relPath: personRelPath,
          frontmatter: personFm,
          assertions: [
            `- 身份([[people/${defaultPerson}]]#角色, ${defaultPerson === "self" ? "住户自身" : "主互动伙伴"})`,
          ],
          frontstageNarrative: effectiveReflection,
        });
        writtenFiles.push(personRelPath);
      }
    }
  }

  for (const item of verdict.items) {
    handledConcernIds.add(item.concern_id);
    if (!db.getEventLogById(item.source_event_id)) {
      continue;
    }

    const existingConcernFile = byId.get(item.concern_id);
    if (
      item.action === "keep_active" &&
      existingConcernFile &&
      existingConcernFile.frontmatter.status === item.next_status &&
      existingConcernFile.frontmatter.tier === item.next_tier
    ) {
      continue;
    }

    const createdDateStr = formatLocalDateStr(item.created_at);
    const relPath =
      existingConcernFile?.relPath ??
      `concerns/${createdDateStr}-${sanitizeSlug(item.concern_id)}.md`;

    const existingNarrative = existingConcernFile
      ? extractExistingNarrative(existingConcernFile.body)
      : null;

    // 保留事发当日的前台第一人称原叙，避免后续跨周状态流转（淡化/冷战/结痂/落定）冲掉原叙
    const narrativeToUse = existingNarrative || effectiveReflection;

    const assertions: string[] = [
      `- 牵挂([[people/user]], "${escapePredicateText(item.summary)}")`,
    ];
    if (item.action !== "keep_active") {
      assertions.push(
        `- 结转([[people/self]], "${item.next_status}：${escapePredicateText(item.reason)}")`,
      );
    }

    const fm: MemoryFrontmatter = {
      id: item.concern_id,
      type: "牵挂注",
      tier: item.next_tier,
      date: existingConcernFile?.frontmatter.date ?? createdDateStr,
      status: item.next_status,
      source_event_id: item.source_event_id,
      category: existingConcernFile?.frontmatter.category ?? "life_event",
      allow_forget: item.next_tier === "scar" ? false : true,
    };

    writeCompiledMarkdownFile({
      memoryDir,
      relPath,
      frontmatter: fm,
      assertions,
      frontstageNarrative: narrativeToUse,
    });

    writtenFiles.push(relPath);
    updatedConcernIds.push(item.concern_id);

    if (item.action === "crystallize_scar" && item.scar_rule) {
      scarRulesToAppend.push({
        section: "结痂雷区",
        predicate_line: `雷区([[people/self]]#${item.scar_rule.slot_tag}, "${escapePredicateText(item.scar_rule.description)}")`,
        source_event_id: item.scar_rule.source_event_id,
      });
    }
  }

  // 兜底检查磁盘上已存在但未进入 verdict 的 concerns/*.md 文件（对齐 L6 分级流转）
  for (const f of currentFiles) {
    if (
      (f.relPath.startsWith("concerns/") || f.frontmatter.type === "牵挂注") &&
      !handledConcernIds.has(f.frontmatter.id)
    ) {
      const ageDays = localCalendarDaysBetween(f.frontmatter.date, now);
      let nextTier =
        f.frontmatter.tier && f.frontmatter.tier !== "normal"
          ? f.frontmatter.tier
          : "minor_worry";
      let nextStatus = f.frontmatter.status;
      let changed = f.frontmatter.tier !== nextTier;

      if (nextTier === "minor_worry" && nextStatus === "有效" && ageDays >= 7) {
        nextStatus = "已淡化";
        changed = true;
      } else if (nextTier === "conflict") {
        if (
          (nextStatus === "有效" || nextStatus === "僵持待解") &&
          ageDays >= 21
        ) {
          nextTier = "scar";
          nextStatus = "已结痂";
          changed = true;
          if (
            f.frontmatter.source_event_id &&
            db.getEventLogById(f.frontmatter.source_event_id)
          ) {
            scarRulesToAppend.push({
              section: "结痂雷区",
              predicate_line: `雷区([[people/self]]#过往冲突敏感, "曾在 ${f.frontmatter.date} 留有长期未解冲突，再遇同类触发皮质醇敏感度翻倍")`,
              source_event_id: f.frontmatter.source_event_id,
            });
          }
        } else if (nextStatus === "有效" && ageDays >= 5) {
          nextStatus = "僵持待解";
          changed = true;
        }
      }

      if (changed) {
        const absPath = path.join(memoryDir, f.relPath);
        const updatedFm: MemoryFrontmatter = {
          ...f.frontmatter,
          tier: nextTier,
          status: nextStatus,
          allow_forget: nextTier === "scar" ? false : f.frontmatter.allow_forget,
        };
        writeUpdatedFrontmatter(absPath, updatedFm, f.body);
        writtenFiles.push(f.relPath);
        updatedConcernIds.push(f.frontmatter.id);
      }
    }
  }

  // 2. 获取记忆官结构化编译计划（优先使用 planOverride，否则调用 compiler 岗位模型）
  const todaysEvents =
    params.todaysEvents ??
    db.getUnsettledEventLogs(dateStr, params.chronotype);
  const recentLogs =
    todaysEvents.length > 0 ? todaysEvents : db.getRecentEventLogs(10);
  const fallbackSourceLogId =
    todaysEvents.find((e) => e.role === "user")?.id ??
    todaysEvents[todaysEvents.length - 1]?.id ??
    recentLogs[recentLogs.length - 1]?.id;

  const plan = planOverride
    ? CompilationPlanSchema.parse(planOverride)
    : router
      ? await generateCompilationPlanWithOrgan({
          router,
          dateStr,
          coldReflection: effectiveReflection,
          hotEntries,
          verdict,
          existingFiles: loadStructuredMemoryFiles(memoryDir),
          todaysEvents,
        })
      : CompilationPlanSchema.parse({ memories: [], rapport_rules: [] });

  // 3. 编译 `plan.memories`（处理符号定义补齐、取代链闭合与同槽位冲突自动消解）
  const filesBeforeBatch = loadStructuredMemoryFiles(memoryDir);
  const existingById = new Map<string, ParsedMemoryFile>();
  const existingBySymbol = new Map<string, ParsedMemoryFile>();
  // Map of "predicate::[[subject]]#slot" -> active ParsedMemoryFile
  const activeSlotOwners = new Map<string, ParsedMemoryFile>();

  for (const f of filesBeforeBatch) {
    existingById.set(f.frontmatter.id, f);
    existingBySymbol.set(f.symbolKey, f);

    if (f.frontmatter.status === "有效") {
      for (const line of f.body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("- ")) continue;
        const predMatch = trimmed.match(
          /^-\s*([^\s(（]+)\s*\((.+)\)\s*(?:\[src:\s*([^\]]+)\])?$/,
        );
        if (!predMatch) continue;
        const predName = predMatch[1]!;
        const argsRaw = predMatch[2]!;
        if (DIACHRONIC_EXEMPT_PREDICATES.has(predName)) continue;

        const slotArgMatch = argsRaw.match(
          /^\s*(\[\[[^\]]+\]\](?:#[^,\s]+)?)\s*,\s*(.+)$/,
        );
        if (slotArgMatch) {
          const subjectSlot = slotArgMatch[1]!.trim();
          if (
            subjectSlot.includes("#") ||
            SINGLE_VALUED_SYNCHRONIC_PREDICATES.has(predName)
          ) {
            activeSlotOwners.set(`${predName}::${subjectSlot}`, f);
          }
        }
      }
    }
  }

  const plannedSymbols = new Set<string>(
    plan.memories.map((m) => m.rel_path.replace(/\.md$/, "")),
  );

  for (const spec of plan.memories) {
    const newSymbolKey = spec.rel_path.replace(/\.md$/, "");

    // L5 守卫：确保 events/ 与 concerns/ 拥有存在于 SQLite 的 source_event_id
    let validSourceId = spec.source_event_id;
    if (
      spec.rel_path.startsWith("events/") ||
      spec.rel_path.startsWith("concerns/")
    ) {
      if (!validSourceId || !db.getEventLogById(validSourceId)) {
        if (!fallbackSourceLogId) {
          continue;
        }
        validSourceId = fallbackSourceLogId;
      }
    }

    // L1 守卫：检查断言中引用的 [[path/symbol]] 是否已定义；若引用了未定义的 [[people/xxx]]，先自动创建人物定义档
    const normalizedAssertions = spec.assertions.map((rawAssertion) => {
      let line = rawAssertion.trim();
      const refs = Array.from(line.matchAll(/\[\[([^\]#]+)(#[^\]]+)?\]\]/g));
      for (const rm of refs) {
        const refSym = rm[1]?.trim();
        if (!refSym) continue;
        if (
          !existingBySymbol.has(refSym) &&
          !plannedSymbols.has(refSym) &&
          refSym !== newSymbolKey
        ) {
          if (refSym.startsWith("people/")) {
            const personSlug = refSym.slice("people/".length);
            const personRelPath = `people/${personSlug}.md`;
            const personFm: MemoryFrontmatter = {
              id: `sym-people-${sanitizeSlug(personSlug)}`,
              type: "符号定义",
              date: dateStr,
              status: "有效",
              category: "preference",
              allow_forget: false,
            };
            writeCompiledMarkdownFile({
              memoryDir,
              relPath: personRelPath,
              frontmatter: personFm,
              assertions: [`- 身份([[${refSym}]]#关系, 相关人物)`],
              frontstageNarrative: effectiveReflection,
            });
            writtenFiles.push(personRelPath);
            existingBySymbol.set(refSym, {
              relPath: personRelPath,
              symbolKey: refSym,
              frontmatter: personFm,
              body: "",
              rawContent: "",
            });
          } else {
            // 非 people/ 的悬空符号降级为纯文本描述以防 L1 报错
            line = line.replace(rm[0], refSym);
          }
        }
      }
      return line;
    });

    // L4 & L3 守卫 + Z 式冲突待复核门（Wave 1 止血护栏）：
    // 1. 仅当新记忆显式指定 supersedes 或属于客观短期状态流转（health/schedule 的 当前状态），且旧文件非受保护钉子记忆时，才自动翻转旧文件为 `已取代`；
    // 2. 若撞上受保护钉子记忆（allow_forget: false 的非短期状态记忆 / people/* 符号定义）或未显式声明 supersedes 的偏好/事件同槽位碰撞，
    //    保留旧文件为 `有效`，将新文件中的冲突断言降级为 `情境表态(...)`，并记入 pendingConflicts。
    const explicitSupersedeIds = new Set<string>(
      (spec.supersedes ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((id) => Boolean(id) && id !== spec.id && existingById.has(id)),
    );

    const targetOldIds = new Set<string>();
    for (const explicitOldId of explicitSupersedeIds) {
      const oldFile = existingById.get(explicitOldId)!;
      if (isProtectedNailFile(oldFile) && !params.allowSupersedeProtected) {
        pendingConflicts.push({
          slotKey: `supersedes::${oldFile.symbolKey}`,
          existingId: oldFile.frontmatter.id,
          existingFile: oldFile.relPath,
          incomingId: spec.id,
          incomingFile: spec.rel_path,
          incomingValue: spec.assertions.join("；"),
          reason: "protected_nail_memory",
        });
      } else {
        targetOldIds.add(explicitOldId);
      }
    }

    const guardedAssertions = normalizedAssertions.map((line) => {
      if (spec.status !== "有效") return line;
      const cleanLine = line.startsWith("- ") ? line : `- ${line}`;
      const predMatch = cleanLine.match(/^-\s*([^\s(（]+)\s*\((.+)\)$/);
      if (!predMatch) return line;
      const predName = predMatch[1]!;
      const argsRaw = predMatch[2]!;
      if (DIACHRONIC_EXEMPT_PREDICATES.has(predName)) return line;

      const slotArgMatch = argsRaw.match(
        /^\s*(\[\[[^\]]+\]\](?:#[^,\s]+)?)\s*,\s*(.+)$/,
      );
      if (!slotArgMatch) return line;

      const subjectSlot = slotArgMatch[1]!.trim();
      const incomingValue = slotArgMatch[2]!.trim();
      if (
        !subjectSlot.includes("#") &&
        !SINGLE_VALUED_SYNCHRONIC_PREDICATES.has(predName)
      ) {
        return line;
      }

      const slotKey = `${predName}::${subjectSlot}`;
      const owner = activeSlotOwners.get(slotKey);
      if (!owner || owner.frontmatter.id === spec.id) {
        return line;
      }

      const isExplicitlySuperseded = explicitSupersedeIds.has(
        owner.frontmatter.id,
      );
      // 客观短期状态品类（health / schedule）的同槽位状态更新按品类放行，不再限定谓词必须是“当前状态”
      const isTransientStateEvolution =
        (spec.category === "health" || spec.category === "schedule") &&
        (owner.frontmatter.category === "health" ||
          owner.frontmatter.category === "schedule");
      const ownerProtected =
        isProtectedNailFile(owner) && !params.allowSupersedeProtected;

      if (
        !ownerProtected &&
        (isExplicitlySuperseded || isTransientStateEvolution)
      ) {
        targetOldIds.add(owner.frontmatter.id);
        return line;
      }

      // Z 式拦截：不覆盖旧文件，将新断言降级为非排他的历时/情境观察 `情境表态(...)` 并记录待复核冲突
      targetOldIds.delete(owner.frontmatter.id);
      const reason: SlotConflictReason = ownerProtected
        ? "protected_nail_memory"
        : "unconfirmed_preference_or_event_collision";
      // 同一对新旧文件只记一条待复核（显式 supersedes 循环可能已记过同一对，槽位不同也合并）
      if (
        !pendingConflicts.some(
          (c) =>
            c.existingId === owner.frontmatter.id &&
            c.incomingId === spec.id,
        )
      ) {
        pendingConflicts.push({
          slotKey,
          existingId: owner.frontmatter.id,
          existingFile: owner.relPath,
          incomingId: spec.id,
          incomingFile: spec.rel_path,
          incomingValue,
          reason,
        });
      }
      return `- 情境表态(${subjectSlot}, ${incomingValue})`;
    });

    const effectiveSupersedes =
      targetOldIds.size > 0 ? Array.from(targetOldIds).join(", ") : undefined;

    // 若存在 supersedes，将所有被取代的旧文件 status 同步更新为 `已取代`
    for (const oldId of targetOldIds) {
      const oldFile = existingById.get(oldId);
      if (oldFile && oldFile.frontmatter.status !== "已取代") {
        const oldAbsPath = path.join(memoryDir, oldFile.relPath);
        const updatedOldFm: MemoryFrontmatter = {
          ...oldFile.frontmatter,
          status: "已取代",
        };
        writeUpdatedFrontmatter(oldAbsPath, updatedOldFm, oldFile.body);
        oldFile.frontmatter = updatedOldFm;
        supersededIds.push(oldFile.frontmatter.id);
        supersededReplacementMap.set(oldFile.symbolKey, newSymbolKey);
      }
    }

    // 保留前台第一人称叙事原肉（后台 compiler 模型不得脱离前台日记凭空捏造第一人称叙事）
    const candidateSpecNarrative = spec.frontstage_narrative?.trim();
    const isVerifiedFrontstageNarrative =
      candidateSpecNarrative &&
      (planOverride !== undefined ||
        allowedFrontstageCorpus.includes(candidateSpecNarrative));
    const narrativeToWrite = isVerifiedFrontstageNarrative
      ? candidateSpecNarrative
      : effectiveReflection;

    const compiledFm: MemoryFrontmatter = {
      id: spec.id,
      type: spec.type,
      ...(spec.tier
        ? { tier: spec.tier }
        : spec.type === "牵挂注"
          ? { tier: "minor_worry" }
          : {}),
      date: spec.date || dateStr,
      status: spec.status,
      ...(effectiveSupersedes ? { supersedes: effectiveSupersedes } : {}),
      ...(validSourceId ? { source_event_id: validSourceId } : {}),
      category: spec.category,
      allow_forget:
        spec.type === "符号定义" ||
        spec.type === "内隐默契" ||
        spec.tier === "scar"
          ? false
          : spec.allow_forget,
    };

    writeCompiledMarkdownFile({
      memoryDir,
      relPath: spec.rel_path,
      frontmatter: compiledFm,
      assertions: guardedAssertions,
      frontstageNarrative: narrativeToWrite,
    });

    const newParsedFile: ParsedMemoryFile = {
      relPath: spec.rel_path,
      symbolKey: newSymbolKey,
      frontmatter: compiledFm,
      body: formatCompiledMarkdownBody(guardedAssertions, narrativeToWrite),
      rawContent: "",
    };
    existingById.set(compiledFm.id, newParsedFile);
    existingBySymbol.set(newSymbolKey, newParsedFile);
    if (compiledFm.status === "有效") {
      for (const line of guardedAssertions) {
        const cleanLine = line.startsWith("- ") ? line : `- ${line}`;
        const predMatch = cleanLine.match(/^-\s*([^\s(（]+)\s*\((.+)\)$/);
        if (!predMatch) continue;
        const predName = predMatch[1]!;
        const argsRaw = predMatch[2]!;
        if (DIACHRONIC_EXEMPT_PREDICATES.has(predName)) continue;
        const slotArgMatch = argsRaw.match(
          /^\s*(\[\[[^\]]+\]\](?:#[^,\s]+)?)\s*,\s*(.+)$/,
        );
        if (slotArgMatch) {
          const subjectSlot = slotArgMatch[1]!.trim();
          if (
            subjectSlot.includes("#") ||
            SINGLE_VALUED_SYNCHRONIC_PREDICATES.has(predName)
          ) {
            activeSlotOwners.set(`${predName}::${subjectSlot}`, newParsedFile);
          }
        }
      }
    }

    writtenFiles.push(spec.rel_path);
  }

  // 4. 追加新增默契与 T3 结痂雷区至 `implicit/rapport.md`
  const allRapportRules = [...scarRulesToAppend, ...plan.rapport_rules];
  const addedRules = appendRapportRulesToFile({
    memoryDir,
    db,
    rules: allRapportRules,
    now,
  });
  if (addedRules.length > 0) {
    addedRapportRules.push(...addedRules);
    writtenFiles.push("implicit/rapport.md");
  }

  // 5. 修正任何指向 `已取代` / `已沉底` 文件的共时谓词引用，确保 L2 全绿
  reconcileSynchronicLinksToInactiveFiles({
    memoryDir,
    supersededReplacementMap,
  });

  // 6. 同步 SQLite `memory_meta` 并执行 L1~L7 体检
  syncMemoryMetaFromFiles({ memoryDir, db, now });
  const lintReport = runMemoryLinter({ memoryDir, db, now });

  return {
    writtenFiles: Array.from(new Set(writtenFiles)),
    supersededIds: Array.from(new Set(supersededIds)),
    updatedConcernIds: Array.from(new Set(updatedConcernIds)),
    addedRapportRules,
    pendingConflicts,
    lintReport,
  };
}
