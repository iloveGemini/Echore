import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { formatLocalDateStr, formatVagueWhen } from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type MemoryFrontmatter,
  MemoryFrontmatterSchema,
} from "../core/schemas.ts";
import type { ResolvedEndocrineProfile } from "../endocrine/archetypes.ts";
import { syncSingleMemoryMetaFile } from "../hippocampus/decay.ts";
import {
  type ParsedMemoryFile,
  parseStructuredMemoryContent,
  parseStructuredMemoryFile,
  runMemoryLinter,
} from "../hippocampus/linter.ts";
import { replaceUniqueNormalizedFragment } from "../hippocampus/text-patch.ts";
import { defineZodTool, type ZodTool } from "../llm/types.ts";

export interface IdentityFileChange {
  target: "self" | "user";
  relPath: string;
  residentName?: string;
  userName?: string;
  userPronoun?: string;
  relationship?: string;
}

export interface FrontstageMemoryToolsContext {
  memoryDir: string;
  db: EchoreDatabase;
  now: () => Date;
  getProfile: () => ResolvedEndocrineProfile;
  onIdentityChange?: (change: IdentityFileChange) => void;
  onJournalWritten?: (relPath: string) => void;
  onStructuredMemoryWritten?: (
    relPath: string,
    parsed: ParsedMemoryFile,
  ) => void;
}

const MAX_READ_CHARS = 4000;
const DEFAULT_READ_LIMIT_LINES = 120;
const MAX_GLOB_RESULTS = 100;
const DEFAULT_GREP_LIMIT = 30;
const MAX_GREP_LIMIT = 60;

const ALLOWED_TEXT_EXTS = new Set([".md", ".yaml", ".yml", ".txt"]);
const LOG_REF_INLINE_RE = /\s*\[src:\s*log-[^\]]+\]/gi;
const LOG_ID_ANY_RE = /\blog-\d{4,}[-\w]*\b/gi;
const SHA256_RE = /\b[a-f0-9]{64}\b/gi;

function normalizeRelPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function resolveSafeMemoryPath(
  memoryDir: string,
  rawPath: string,
): { relPath: string; absPath: string } {
  if (!rawPath || rawPath.includes("\0")) {
    throw new Error("文件路径不能为空或包含非法字符。");
  }
  const normalized = path.posix.normalize(normalizeRelPath(rawPath));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("禁止越界访问记忆仓库之外的路径。");
  }
  if (
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized.endsWith(".sqlite") ||
    normalized.endsWith(".sqlite-wal") ||
    normalized.endsWith(".sqlite-shm")
  ) {
    throw new Error("禁止访问系统内部或数据库文件。");
  }

  const rootResolved = path.resolve(memoryDir);
  const absPath = path.resolve(rootResolved, normalized);
  if (
    absPath !== rootResolved &&
    !absPath.startsWith(`${rootResolved}${path.sep}`)
  ) {
    throw new Error("禁止越界访问记忆仓库之外的路径。");
  }

  return { relPath: normalized, absPath };
}

function walkMemoryDirFiles(memoryDir: string, subDir = ""): string[] {
  const target = subDir ? path.join(memoryDir, subDir) : memoryDir;
  if (!fs.existsSync(target)) return [];
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const rel = subDir ? path.posix.join(subDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkMemoryDirFiles(memoryDir, rel));
    } else if (entry.isFile()) {
      const ext = path.posix.extname(entry.name).toLowerCase();
      if (ALLOWED_TEXT_EXTS.has(ext)) {
        files.push(rel);
      }
    }
  }
  return files.sort();
}

/**
 * 读前脱敏钩子：彻底剥离 `source_event_id`、`[src: log-*]` 与任何内部主键/哈希，
 * 确保前台通过 `read` / `grep` 翻看自己的记忆仓时绝对零泄露。
 */
export function sanitizeMemoryContentForFrontstage(
  rawContent: string,
  relPath: string,
): string {
  let text = rawContent;

  if (relPath.endsWith(".md")) {
    const fmMatch = text.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
    if (fmMatch) {
      const fmBlock = fmMatch[1]!.replace(
        /^source_event_id:\s*[^\r\n]*\r?\n?/gm,
        "",
      );
      const bodyBlock = fmMatch[2]!.replace(LOG_REF_INLINE_RE, "");
      text = `${fmBlock}${bodyBlock}`;
    } else {
      text = text.replace(LOG_REF_INLINE_RE, "");
    }
  }

  text = text
    .replace(LOG_ID_ANY_RE, "[已略去记录编号]")
    .replace(SHA256_RE, "[已略去校验码]");

  assertNoInternalLeaks(text, `memory-tools.sanitize(${relPath})`);
  return text;
}

function tryReadQuickMetadata(
  memoryDir: string,
  relPath: string,
  now: Date,
): { status?: string; vagueDate?: string; archived: boolean } {
  if (!relPath.endsWith(".md")) return { archived: false };
  const absPath = path.join(memoryDir, relPath);
  if (!fs.existsSync(absPath)) return { archived: false };
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    const gm = matter(raw);
    const status =
      typeof gm.data?.status === "string" ? gm.data.status : undefined;
    const rawDate = gm.data?.date;
    let vagueDate: string | undefined;
    if (rawDate instanceof Date) {
      vagueDate = formatVagueWhen(rawDate, now);
    } else if (
      typeof rawDate === "string" &&
      /^\d{4}-\d{2}-\d{2}/.test(rawDate)
    ) {
      vagueDate = formatVagueWhen(rawDate.slice(0, 10), now);
    }
    return {
      status,
      vagueDate,
      archived: status === "已沉底",
    };
  } catch {
    return { archived: false };
  }
}

function resolveWritableZone(
  relPath: string,
  isEdit: boolean,
): "journal" | "people_self" | "people_user" {
  const ext = path.posix.extname(relPath).toLowerCase();
  if (!ALLOWED_TEXT_EXTS.has(ext)) {
    throw new Error(`不支持写入该文件类型：${relPath}`);
  }

  if (relPath === "INDEX.md") {
    throw new Error(
      "INDEX.md 由夜间整理自动维护，白天只可查阅，不可直接修改。",
    );
  }
  if (relPath.startsWith("concerns/")) {
    throw new Error(
      "concerns/ 下的牵挂档案由情绪官与夜间结算统一维护，白天只可查阅，不可修改。",
    );
  }
  if (relPath.startsWith("events/")) {
    throw new Error(
      "events/ 下的事件断言需要夜间睡眠结合全天上下文核验沉淀，白天只可查阅；若有值得记下的新事，请先写进当天的 journal/YYYY-MM-DD.md。",
    );
  }
  if (relPath === "implicit/rapport.md" || relPath.startsWith("implicit/")) {
    throw new Error(
      "implicit/rapport.md 需经夜间睡眠结合双向反馈核验沉淀，白天只可查阅；若有新默契印象，请先写进当天的 journal/YYYY-MM-DD.md。",
    );
  }
  if (relPath.startsWith("solitary/")) {
    throw new Error(
      "solitary/ 下的独处笔记与备忘仅在独处时段（环 2）自动沉淀，聊天时只可查阅；若有值得记下的新事或待办，请先写进当天的 journal/YYYY-MM-DD.md。",
    );
  }
  if (relPath.startsWith("journal/")) {
    if (!/^journal\/\d{4}-\d{2}-\d{2}\.md$/.test(relPath)) {
      throw new Error("journal/ 下只允许按 journal/YYYY-MM-DD.md 命名写入。");
    }
    return "journal";
  }
  if (relPath === "people/self.md" || relPath === "people/user.md") {
    if (!isEdit) {
      throw new Error(
        `${relPath} 禁止使用 write 整文件覆写，请使用 edit 局部修改对应的姓名、称呼、代词或关系行。`,
      );
    }
    return relPath === "people/self.md" ? "people_self" : "people_user";
  }
  if (relPath.startsWith("people/")) {
    throw new Error(
      "白天仅支持用 edit 局部修改 people/self.md 或 people/user.md，其他人物档案请先记入 journal/YYYY-MM-DD.md 待夜间编译维护。",
    );
  }

  throw new Error(`路径 ${relPath} 不在允许主动改写的记忆分区内。`);
}

function serializeFrontmatterAndBody(
  frontmatter: MemoryFrontmatter,
  body: string,
): string {
  const cleanData: Record<string, unknown> = {
    id: frontmatter.id,
    type: frontmatter.type,
  };
  if (frontmatter.tier !== undefined) {
    cleanData.tier = frontmatter.tier;
  }
  cleanData.date = frontmatter.date;
  cleanData.status = frontmatter.status;
  if (frontmatter.supersedes !== undefined) {
    cleanData.supersedes = frontmatter.supersedes;
  }
  if (frontmatter.source_event_id !== undefined) {
    cleanData.source_event_id = frontmatter.source_event_id;
  }
  cleanData.category = frontmatter.category;
  cleanData.allow_forget = frontmatter.allow_forget;
  if (frontmatter.when_to_recall !== undefined) {
    cleanData.when_to_recall = frontmatter.when_to_recall;
  }

  const trimmedBody = body.replace(/^\r?\n+/, "");
  const normalizedBody = trimmedBody.endsWith("\n")
    ? `\n${trimmedBody}`
    : `\n${trimmedBody}\n`;
  return matter.stringify(normalizedBody, cleanData);
}

const TEMPLATE_RELATIONSHIP_PLACEHOLDERS = new Set([
  "日常相处的陪伴对象",
]);

export function extractIdentityChanges(
  zone: "people_self" | "people_user",
  relPath: string,
  body: string,
  profile: ResolvedEndocrineProfile,
): IdentityFileChange | null {
  const cleanArg = (raw: string): string =>
    raw
      .trim()
      .replace(/^["'「『“‘]+|["'」』”’]+$/g, "")
      .trim();

  if (zone === "people_self") {
    const match = body.match(
      /^-\s*(?:(?:身份|称呼)\(\[\[people\/self\]\]#(?:姓名|名字|称呼)|(?:姓名|名字)\(\[\[people\/self\]\](?:#(?:姓名|名字))?)\s*,\s*([^)]+)\)/m,
    );
    if (match?.[1]) {
      const residentName = cleanArg(match[1]);
      if (residentName && residentName !== profile.name) {
        return { target: "self", relPath, residentName };
      }
    }
    return null;
  }

  const nameMatch = body.match(
    /^-\s*(?:(?:称呼|姓名|名字)\(\[\[people\/user\]\](?:#(?:姓名|名字|称呼))?|身份\(\[\[people\/user\]\]#(?:姓名|名字|称呼))\s*,\s*([^)]+)\)/m,
  );
  const pronounMatch = body.match(
    /^-\s*代词\(\[\[people\/user\]\](?:#代词)?\s*,\s*([^)]+)\)/m,
  );
  const relMatch = body.match(
    /^-\s*(?:关系|身份)\(\[\[people\/user\]\](?:#关系)?\s*,\s*([^)]+)\)/m,
  );

  const userName = nameMatch?.[1] ? cleanArg(nameMatch[1]) : undefined;
  const userPronoun = pronounMatch?.[1] ? cleanArg(pronounMatch[1]) : undefined;
  const rawRelationship = relMatch?.[1] ? cleanArg(relMatch[1]) : undefined;
  const relationship =
    rawRelationship && !TEMPLATE_RELATIONSHIP_PLACEHOLDERS.has(rawRelationship)
      ? rawRelationship
      : undefined;

  if (
    (userName && userName !== profile.user_name) ||
    (userPronoun && userPronoun !== profile.user_pronoun) ||
    (relationship && relationship !== profile.relationship)
  ) {
    return {
      target: "user",
      relPath,
      ...(userName && userName !== profile.user_name ? { userName } : {}),
      ...(userPronoun && userPronoun !== profile.user_pronoun
        ? { userPronoun }
        : {}),
      ...(relationship && relationship !== profile.relationship
        ? { relationship }
        : {}),
    };
  }
  return null;
}

function prepareAndValidateWrite(params: {
  ctx: FrontstageMemoryToolsContext;
  relPath: string;
  absPath: string;
  candidateRaw: string;
  isEdit: boolean;
}): {
  finalRaw: string;
  zone: ReturnType<typeof resolveWritableZone>;
  parsedStructured?: ParsedMemoryFile;
  identityChange?: IdentityFileChange | null;
} {
  const { ctx, relPath, absPath, candidateRaw, isEdit } = params;
  const zone = resolveWritableZone(relPath, isEdit);
  const now = ctx.now();
  const todayStr = formatLocalDateStr(now);

  // journal/：自由文本日常热记事，校验零内部泄露
  if (zone === "journal") {
    assertNoInternalLeaks(candidateRaw, `memory-tools.write(${relPath})`);
    return { finalRaw: candidateRaw, zone };
  }

  // people/self.md 与 people/user.md（仅限 edit 局部修改，绝不自动伪造 source_event_id）
  const existingParsed = fs.existsSync(absPath)
    ? parseStructuredMemoryFile(ctx.memoryDir, relPath)
    : null;

  let gm: matter.GrayMatterFile<string>;
  try {
    gm = matter(candidateRaw);
  } catch (err) {
    throw new Error(
      `YAML 头解析失败，请检查 \`---\` 分隔符与格式：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const data = { ...(gm.data as Record<string, unknown>) };
  const body = gm.content;

  const defaultId =
    zone === "people_self" ? "sym-people-self" : "sym-people-user";
  data.id =
    existingParsed?.frontmatter.id ??
    (typeof data.id === "string" && data.id.trim()
      ? data.id.trim()
      : defaultId);
  data.type = "符号定义";
  data.date = existingParsed?.frontmatter.date ?? todayStr;
  data.status = existingParsed?.frontmatter.status ?? "有效";
  data.category = existingParsed?.frontmatter.category ?? "preference";
  data.allow_forget = false;

  // 严禁工具层自动伪造 source_event_id：若原文件已有合法 source_event_id 则原样保留，否则置空（L5 豁免 people/ 符号定义档）
  if (existingParsed?.frontmatter.source_event_id) {
    data.source_event_id = existingParsed.frontmatter.source_event_id;
  } else {
    delete data.source_event_id;
  }

  const frontmatter = MemoryFrontmatterSchema.parse(data);
  assertNoInternalLeaks(body, `memory-tools.writeBody(${relPath})`);

  const finalRaw = serializeFrontmatterAndBody(frontmatter, body);
  const parsedStructured = parseStructuredMemoryContent(relPath, finalRaw);

  // IDE 式 Linter 预检（dryRun: true，不污染磁盘和 db.audit_fingerprint）
  const overrides = new Map<string, string>([[relPath, finalRaw]]);
  const lintReport = runMemoryLinter({
    memoryDir: ctx.memoryDir,
    db: ctx.db,
    now,
    dryRun: true,
    candidateOverrides: overrides,
  });

  const relevantErrors = lintReport.issues.filter(
    (issue) => issue.severity === "error" && issue.file === relPath,
  );
  if (relevantErrors.length > 0) {
    const cleanMessages = relevantErrors.map((e) =>
      e.message.replace(LOG_ID_ANY_RE, "[记录编号]"),
    );
    throw new Error(
      `修改未通过结构校验，请修正后重试：\n- ${cleanMessages.join("\n- ")}`,
    );
  }

  const identityChange = extractIdentityChanges(
    zone,
    relPath,
    body,
    ctx.getProfile(),
  );

  return { finalRaw, zone, parsedStructured, identityChange };
}

function commitValidatedWrite(params: {
  ctx: FrontstageMemoryToolsContext;
  relPath: string;
  absPath: string;
  prepared: ReturnType<typeof prepareAndValidateWrite>;
}): void {
  const { ctx, relPath, absPath, prepared } = params;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, prepared.finalRaw, "utf8");

  if (prepared.zone === "journal") {
    ctx.onJournalWritten?.(relPath);
    return;
  }

  if (prepared.parsedStructured) {
    syncSingleMemoryMetaFile({
      memoryDir: ctx.memoryDir,
      relPath,
      db: ctx.db,
      now: ctx.now(),
    });
    ctx.onStructuredMemoryWritten?.(relPath, prepared.parsedStructured);
  }

  if (prepared.identityChange) {
    ctx.onIdentityChange?.(prepared.identityChange);
  }
}

function globPatternToRegex(pattern: string): RegExp {
  const normalized = normalizeRelPath(pattern) || "**/*.md";
  let regexStr = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 3;
          continue;
        }
        regexStr += ".*";
        i += 2;
        continue;
      }
      regexStr += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(ch)) {
      regexStr += `\\${ch}`;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * 构建标准 5 件套文件工具（glob / grep / read / write / edit），
 * 沙箱锁定在 `memoryDir`：
 * - 全仓可读（自动剥离 `log-*` 主键）；
 * - 白天仅开放写 `journal/YYYY-MM-DD.md`，以及用 `edit` 局部修改 `people/{self,user}.md`；
 * - `solitary/`、`events/`、`implicit/rapport.md`、`concerns/`、`INDEX.md` 在白天聊天中只读，绝不伪造独居物证或 `source_event_id`。
 */
export function createFrontstageMemoryTools(
  ctx: FrontstageMemoryToolsContext,
): ZodTool[] {
  const globTool = defineZodTool({
    name: "glob",
    description:
      "按路径模式列举记忆仓库中的文件（如 people/*.md、events/*.md、journal/*.md、**/*.md），用于快速翻看自己有哪些日记、档案或往事记录。",
    inputSchema: z.object({
      pattern: z
        .string()
        .optional()
        .describe("Glob 匹配模式，默认 **/*.md"),
    }),
    execute: ({ pattern }) => {
      const re = globPatternToRegex(pattern ?? "**/*.md");
      const allFiles = walkMemoryDirFiles(ctx.memoryDir).filter((rel) =>
        re.test(rel),
      );
      if (allFiles.length === 0) {
        return "未找到匹配的文件。";
      }
      const now = ctx.now();
      const truncated = allFiles.length > MAX_GLOB_RESULTS;
      const sliced = allFiles.slice(0, MAX_GLOB_RESULTS);
      const lines = sliced.map((rel) => {
        const meta = tryReadQuickMetadata(ctx.memoryDir, rel, now);
        const tags = [meta.status, meta.vagueDate].filter(Boolean).join(" · ");
        return tags ? `${rel} (${tags})` : rel;
      });
      if (truncated) {
        lines.push(
          `...（共 ${allFiles.length} 个文件，仅展示前 ${MAX_GLOB_RESULTS} 个）`,
        );
      }
      return lines.join("\n");
    },
  });

  const grepTool = defineZodTool({
    name: "grep",
    description:
      "按关键词（默认字面子串匹配，可选正则）在记忆仓库全文检索（可查档案、事件、日记、独居记录与沉底旧记忆）。",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("检索关键词（默认字面匹配）"),
      path: z
        .string()
        .optional()
        .describe(
          "可选限定检索的子目录或文件相对路径，如 events/ 或 journal/",
        ),
      include_archived: z
        .boolean()
        .optional()
        .describe("是否包含已沉底的旧记忆，默认 false"),
      regex: z
        .boolean()
        .optional()
        .describe("是否将 pattern 作为正则表达式解析，默认 false（字面匹配）"),
      limit: z.number().int().min(1).max(MAX_GREP_LIMIT).optional(),
    }),
    execute: ({
      pattern,
      path: scopePath,
      include_archived = false,
      regex: useRegex = false,
      limit,
    }) => {
      const maxHits = limit ?? DEFAULT_GREP_LIMIT;
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let matcher: RegExp;
      if (useRegex) {
        try {
          matcher = new RegExp(pattern, "i");
        } catch {
          matcher = new RegExp(escaped, "i");
        }
      } else {
        matcher = new RegExp(escaped, "i");
      }

      let candidateFiles = walkMemoryDirFiles(ctx.memoryDir);
      if (scopePath?.trim()) {
        const { relPath } = resolveSafeMemoryPath(ctx.memoryDir, scopePath);
        candidateFiles = candidateFiles.filter(
          (f) =>
            f === relPath || f.startsWith(`${relPath.replace(/\/+$/, "")}/`),
        );
      }

      const now = ctx.now();
      const hits: string[] = [];
      for (const rel of candidateFiles) {
        if (hits.length >= maxHits) break;
        const meta = tryReadQuickMetadata(ctx.memoryDir, rel, now);
        if (meta.archived && !include_archived && !scopePath) {
          continue;
        }
        const abs = path.join(ctx.memoryDir, rel);
        let sanitized: string;
        try {
          const raw = fs.readFileSync(abs, "utf8");
          sanitized = sanitizeMemoryContentForFrontstage(raw, rel);
        } catch {
          continue;
        }
        const lines = sanitized.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= maxHits) break;
          const line = lines[i]!;
          if (matcher.test(line)) {
            const tag = [meta.archived ? "已沉底" : undefined, meta.vagueDate]
              .filter(Boolean)
              .join("·");
            const prefix = tag ? `${rel}:${i + 1} [${tag}]` : `${rel}:${i + 1}`;
            hits.push(`${prefix}: ${line.trim().slice(0, 180)}`);
          }
        }
      }

      if (hits.length === 0) {
        return `未检出与「${pattern}」相关的记录。`;
      }
      return hits.join("\n");
    },
  });

  const readTool = defineZodTool({
    name: "read",
    description:
      "读取记忆仓库中单个文件的详细内容（传入相对路径，如 INDEX.md、people/self.md、events/xxx.md、concerns/xxx.md、implicit/rapport.md、journal/YYYY-MM-DD.md）。",
    inputSchema: z.object({
      path: z.string().min(1).describe("相对路径"),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("起始行号（从 1 开始）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe("最多读取行数"),
    }),
    execute: ({
      path: rawPath,
      offset = 1,
      limit = DEFAULT_READ_LIMIT_LINES,
    }) => {
      const { relPath, absPath } = resolveSafeMemoryPath(
        ctx.memoryDir,
        rawPath,
      );
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        throw new Error(`文件不存在：${relPath}`);
      }
      const raw = fs.readFileSync(absPath, "utf8");
      const sanitized = sanitizeMemoryContentForFrontstage(raw, relPath);
      const lines = sanitized.split(/\r?\n/);
      const startIdx = Math.max(0, offset - 1);
      const slicedLines = lines.slice(startIdx, startIdx + limit);

      let formatted = slicedLines
        .map((l, idx) => `${startIdx + idx + 1}\t${l}`)
        .join("\n");

      if (formatted.length > MAX_READ_CHARS) {
        formatted = `${formatted.slice(0, MAX_READ_CHARS)}\n...（内容过长已截断，可传 offset 参数继续翻看）`;
      } else if (startIdx + limit < lines.length) {
        formatted += `\n...（共 ${lines.length} 行，可用 offset=${startIdx + limit + 1} 继续读取）`;
      }

      return formatted || "（空文件）";
    },
  });

  const writeTool = defineZodTool({
    name: "write",
    description:
      "在记忆仓库创建或写入日常记事（仅限 journal/YYYY-MM-DD.md；solitary/、events/、implicit/rapport.md、concerns/、INDEX.md 白天只读；people/ 请用 edit 局部修改）。",
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe("相对路径，如 journal/2026-11-13.md"),
      content: z.string().min(1).describe("完整文件内容"),
    }),
    execute: ({ path: rawPath, content }) => {
      const { relPath, absPath } = resolveSafeMemoryPath(
        ctx.memoryDir,
        rawPath,
      );
      const prepared = prepareAndValidateWrite({
        ctx,
        relPath,
        absPath,
        candidateRaw: content,
        isEdit: false,
      });
      commitValidatedWrite({ ctx, relPath, absPath, prepared });
      return `已保存 ${relPath}`;
    },
  });

  const editTool = defineZodTool({
    name: "edit",
    description:
      "对允许修改的文件做精确局部替换（支持 journal/YYYY-MM-DD.md，以及在约定新名字或更新称呼/代词/关系时局部修改 people/self.md 与 people/user.md）。",
    inputSchema: z.object({
      path: z.string().min(1).describe("已有文件的相对路径"),
      old_string: z.string().min(1).describe("待替换的唯一原片段"),
      new_string: z.string().describe("替换后的新片段"),
    }),
    execute: ({ path: rawPath, old_string, new_string }) => {
      const { relPath, absPath } = resolveSafeMemoryPath(
        ctx.memoryDir,
        rawPath,
      );
      resolveWritableZone(relPath, true);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        throw new Error(
          `目标文件不存在，请先检查路径：${relPath}`,
        );
      }
      const raw = fs.readFileSync(absPath, "utf8");
      let nextRaw: string | null = null;

      // 1. 精确唯一命中原文
      const firstIdx = raw.indexOf(old_string);
      if (firstIdx !== -1 && raw.indexOf(old_string, firstIdx + 1) === -1) {
        nextRaw = `${raw.slice(0, firstIdx)}${new_string}${raw.slice(firstIdx + old_string.length)}`;
      }

      // 2. 归一化位置映射补丁（仅当唯一命中时替换，补丁外字节 100% 不变）
      if (nextRaw === null) {
        nextRaw = replaceUniqueNormalizedFragment(raw, old_string, new_string);
      }

      if (nextRaw === null) {
        throw new Error(
          `未能在 ${relPath} 中唯一匹配到待替换片段（可能不存在或存在多处重复），请先用 read 确认原文后再试。`,
        );
      }

      const prepared = prepareAndValidateWrite({
        ctx,
        relPath,
        absPath,
        candidateRaw: nextRaw,
        isEdit: true,
      });
      commitValidatedWrite({ ctx, relPath, absPath, prepared });
      return `已更新 ${relPath}`;
    },
  });

  return [globTool, grepTool, readTool, writeTool, editTool];
}
