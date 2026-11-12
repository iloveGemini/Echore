import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  formatLocalDateStr,
  localCalendarDaysBetween,
} from "../core/clock.ts";
import type { EchoreDatabase, MemoryMetaRecord } from "../core/db.ts";
import type { MemoryCategory, MemoryFrontmatter } from "../core/schemas.ts";
import {
  loadStructuredMemoryFiles,
  type ParsedMemoryFile,
} from "./linter.ts";
import type { RecalledMemoryItem } from "./recall.ts";

export const INITIAL_MEMORY_STRENGTH = 0.75;
export const NAIL_MEMORY_STRENGTH = 0.90;
export const ARCHIVAL_STRENGTH_THRESHOLD = 0.12;
export const REACTIVATED_ARCHIVE_STRENGTH = 0.435;
export const RECONSOLIDATION_BOOST = 0.05;

/**
 * §4.2 分品类寿命周期 T_cat（单位：天）
 */
export const CATEGORY_HALF_LIFE_DAYS: Record<MemoryCategory, number> = {
  chat: 7,
  schedule: 14,
  solitary: 14,
  life_event: 30,
  health: 30,
  preference: 90,
};

export interface DecayItemOutcome {
  id: string;
  relPath: string;
  category: MemoryCategory;
  previousStrength: number;
  nextStrength: number;
  accessCount: number;
  daysSinceLastAccess: number;
  archived: boolean;
  skippedExempt: boolean;
}

export interface DecayArchiveReport {
  date: string;
  processedCount: number;
  archivedIds: string[];
  exemptIds: string[];
  outcomes: DecayItemOutcome[];
}

function daysBetweenDates(startIsoOrDate: string, now: Date): number {
  return localCalendarDaysBetween(startIsoOrDate, now);
}

/**
 * §4.2 标准每日定步长指数衰减因子
 * effective_half_days = T_cat * (1 + 0.5 * access_count)
 * daily_retention = (0.12 / 0.75) ^ (1 / effective_half_days)
 */
export function computeDailyRetention(
  category: MemoryCategory,
  accessCount: number,
): number {
  const tCat = CATEGORY_HALF_LIFE_DAYS[category];
  const effectiveHalfDays = tCat * (1 + 0.5 * Math.max(0, accessCount));
  return Math.pow(
    ARCHIVAL_STRENGTH_THRESHOLD / INITIAL_MEMORY_STRENGTH,
    1 / effectiveHalfDays,
  );
}

/**
 * 将磁盘上的 Markdown Frontmatter 写回文件（保持正文与引文原封不动）
 */
export function writeUpdatedFrontmatter(
  absPath: string,
  frontmatter: MemoryFrontmatter,
  body: string,
): void {
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

  const trimmedBody = body.startsWith("\n") ? body : `\n${body}`;
  const serialized = matter.stringify(trimmedBody, cleanData);
  fs.writeFileSync(absPath, serialized, "utf8");
}

/**
 * 确保磁盘上所有结构化记忆文件在 SQLite `memory_meta` 中拥有同步记录
 */
export function syncMemoryMetaFromFiles(params: {
  memoryDir: string;
  db: EchoreDatabase;
  now: Date;
}): ParsedMemoryFile[] {
  const { memoryDir, db, now } = params;
  const nowIso = now.toISOString();
  const files = loadStructuredMemoryFiles(memoryDir);

  for (const f of files) {
    const existing = db.getMemoryMeta(f.frontmatter.id);
    if (!existing) {
      const initialStrength = f.frontmatter.allow_forget
        ? INITIAL_MEMORY_STRENGTH
        : NAIL_MEMORY_STRENGTH;
      const [y, m, d] = f.frontmatter.date.split("-").map(Number);
      const defaultLastAccessed =
        y && m && d
          ? new Date(y, m - 1, d, 0, 0, 0).toISOString()
          : f.frontmatter.date;
      db.upsertMemoryMeta({
        id: f.frontmatter.id,
        path: f.relPath,
        category: f.frontmatter.category,
        status: f.frontmatter.status,
        allow_forget: f.frontmatter.allow_forget,
        strength: initialStrength,
        access_count: 0,
        last_accessed: defaultLastAccessed,
        updated_at: nowIso,
      });
    } else if (
      existing.status !== f.frontmatter.status ||
      existing.category !== f.frontmatter.category ||
      existing.allow_forget !== f.frontmatter.allow_forget ||
      existing.path !== f.relPath
    ) {
      db.upsertMemoryMeta({
        ...existing,
        path: f.relPath,
        category: f.frontmatter.category,
        status: f.frontmatter.status,
        allow_forget: f.frontmatter.allow_forget,
        updated_at: nowIso,
      });
    }
  }

  return files;
}

/**
 * §4.3 & Wave 2 再巩固正反馈与冷仓重激活（区分“事实确信”、“负面防反刍”、“空档防刷分”与“已沉底唤醒”）
 * 1. 空档输入（isIdleQuery: true）：直接短路返回，不累加 access_count 也不加 +0.05
 * 2. 已沉底冷仓唤醒（reactivatedFromArchive / status === '已沉底'）：将文件 YAML 与 SQLite status 恢复为 `有效`，强度回血至 0.435
 * 3. 事实与正向偏好记忆：被 recall 且非负向冲突回合时，重置 last_accessed、access_count += 1，且 strength = min(1.0, strength + 0.05)
 * 4. 负面事件与未落定牵挂注：被 recall 时只更新 access_count 与 last_accessed，绝不上调 strength
 */
export function reconsolidateRecalledMemories(params: {
  db: EchoreDatabase;
  memoryDir?: string;
  recalledItems: RecalledMemoryItem[];
  isNegativeOrConflictTurn: boolean;
  isIdleQuery?: boolean;
  now: Date;
}): void {
  const {
    db,
    memoryDir,
    recalledItems,
    isNegativeOrConflictTurn,
    isIdleQuery = false,
    now,
  } = params;
  if (isIdleQuery || recalledItems.length === 0) return;

  const fileById = new Map<string, ParsedMemoryFile>();
  if (memoryDir) {
    const syncedFiles = syncMemoryMetaFromFiles({ memoryDir, db, now });
    for (const f of syncedFiles) {
      fileById.set(f.frontmatter.id, f);
    }
  }

  const activeConcerns = db.listActiveConcerns();
  const activeConcernIds = new Set(activeConcerns.map((c) => c.id));
  const activeConcernSourceIds = new Set(
    activeConcerns.map((c) => c.source_event_id),
  );

  const nowIso = now.toISOString();

  for (const item of recalledItems) {
    const existing = db.getMemoryMeta(item.id);
    const parsedFile = fileById.get(item.id);
    const srcEventId = parsedFile?.frontmatter.source_event_id;
    const isLinkedToActiveConcern =
      activeConcernIds.has(item.id) ||
      (srcEventId !== undefined && activeConcernSourceIds.has(srcEventId));

    const isReactivatedFromColdArchive =
      Boolean(item.reactivatedFromArchive) ||
      item.status === "已沉底" ||
      existing?.status === "已沉底" ||
      parsedFile?.frontmatter.status === "已沉底";

    const isUnresolvedConcernOrNegative =
      isNegativeOrConflictTurn ||
      isLinkedToActiveConcern ||
      (item.type === "牵挂注" && item.status !== "已落定") ||
      item.status === "僵持待解";

    const baseStrength = existing?.strength ?? INITIAL_MEMORY_STRENGTH;
    let nextStrength: number;
    if (isReactivatedFromColdArchive) {
      // 冷仓唤醒按契约重置为 0.435（不取原值与 0.435 的较大值）
      nextStrength = REACTIVATED_ARCHIVE_STRENGTH;
    } else if (isUnresolvedConcernOrNegative) {
      nextStrength = baseStrength;
    } else {
      nextStrength = Math.min(
        1.0,
        Number((baseStrength + RECONSOLIDATION_BOOST).toFixed(6)),
      );
    }

    const nextStatus = isReactivatedFromColdArchive
      ? "有效"
      : (existing?.status ?? item.status);

    if (
      isReactivatedFromColdArchive &&
      memoryDir &&
      parsedFile &&
      parsedFile.frontmatter.status === "已沉底"
    ) {
      const absPath = path.join(memoryDir, parsedFile.relPath);
      writeUpdatedFrontmatter(
        absPath,
        {
          ...parsedFile.frontmatter,
          status: "有效",
        },
        parsedFile.body,
      );
    }

    const updatedMeta: MemoryMetaRecord = {
      id: item.id,
      path: existing?.path ?? item.relPath,
      category: existing?.category ?? item.category,
      status: nextStatus,
      allow_forget: existing?.allow_forget ?? true,
      strength: nextStrength,
      access_count: (existing?.access_count ?? 0) + 1,
      last_accessed: nowIso,
      embedding: existing?.embedding,
      updated_at: nowIso,
    };

    db.upsertMemoryMeta(updatedMeta);
  }
}

/**
 * §4.2 & §4.4 分品类定步长指数衰减与 `status: 已沉底` 归档门
 * - 免死金牌 (`allow_forget: false`) 直接跳过衰减与归档
 * - 零访问记忆在满 t = T_cat 天时，强度从 0.75 精准衰减至 0.12 归档门阈值
 * - 触发归档门时将文件 YAML 头与 SQLite memory_meta 的 status 由 `有效` 改为 `已沉底`（严禁删档）
 */
export function runDailyMemoryDecayAndArchive(params: {
  memoryDir: string;
  db: EchoreDatabase;
  now: Date;
  elapsedDays?: number;
}): DecayArchiveReport {
  const { memoryDir, db, now, elapsedDays = 1 } = params;
  const nowIso = now.toISOString();
  const dateStr = formatLocalDateStr(now);
  const steps = Math.max(1, elapsedDays);

  const files = syncMemoryMetaFromFiles({ memoryDir, db, now });
  const archivedIds: string[] = [];
  const exemptIds: string[] = [];
  const outcomes: DecayItemOutcome[] = [];

  for (const file of files) {
    const { frontmatter, relPath, body } = file;

    // L0 目录、常驻默契底座、人物定义档及 allow_forget: false 免死金牌直接豁免
    if (
      relPath === "INDEX.md" ||
      relPath === "implicit/rapport.md" ||
      relPath.startsWith("people/") ||
      !frontmatter.allow_forget
    ) {
      exemptIds.push(frontmatter.id);
      const meta = db.getMemoryMeta(frontmatter.id);
      outcomes.push({
        id: frontmatter.id,
        relPath,
        category: frontmatter.category,
        previousStrength: meta?.strength ?? NAIL_MEMORY_STRENGTH,
        nextStrength: meta?.strength ?? NAIL_MEMORY_STRENGTH,
        accessCount: meta?.access_count ?? 0,
        daysSinceLastAccess: meta
          ? daysBetweenDates(meta.last_accessed, now)
          : 0,
        archived: false,
        skippedExempt: true,
      });
      continue;
    }

    // 仅对当前处于 `有效` 状态的记忆执行常规衰减与沉底归档
    if (frontmatter.status !== "有效") {
      continue;
    }

    const meta = db.getMemoryMeta(frontmatter.id)!;
    const prevStrength = meta.strength;
    const daysSinceLastAccess = daysBetweenDates(meta.last_accessed, now);

    // 当日新建或当日刚被访问的记忆（daysSinceLastAccess === 0 且未显式指定跨多天快进）在当晚保持当前强度，不提前扣减首日衰减
    if (daysSinceLastAccess === 0 && params.elapsedDays === undefined) {
      outcomes.push({
        id: frontmatter.id,
        relPath,
        category: frontmatter.category,
        previousStrength: prevStrength,
        nextStrength: prevStrength,
        accessCount: meta.access_count,
        daysSinceLastAccess: 0,
        archived: false,
        skippedExempt: false,
      });
      continue;
    }

    const dailyRetention = computeDailyRetention(
      frontmatter.category,
      meta.access_count,
    );
    let nextStrength = prevStrength * Math.pow(dailyRetention, steps);

    // 消除 IEEE 754 浮点尾差，保证零访问记忆在 t = T_cat 天精准抵达 0.12
    if (Math.abs(nextStrength - ARCHIVAL_STRENGTH_THRESHOLD) < 1e-6) {
      nextStrength = ARCHIVAL_STRENGTH_THRESHOLD;
    } else {
      nextStrength = Number(nextStrength.toFixed(6));
    }

    const tCat = CATEGORY_HALF_LIFE_DAYS[frontmatter.category];

    const shouldArchive =
      daysSinceLastAccess >= tCat &&
      nextStrength <= ARCHIVAL_STRENGTH_THRESHOLD;

    const nextStatus = shouldArchive ? "已沉底" : frontmatter.status;

    if (shouldArchive) {
      const absPath = path.join(memoryDir, relPath);
      const updatedFm: MemoryFrontmatter = {
        ...frontmatter,
        status: "已沉底",
      };
      writeUpdatedFrontmatter(absPath, updatedFm, body);
      archivedIds.push(frontmatter.id);
    }

    db.upsertMemoryMeta({
      ...meta,
      status: nextStatus,
      strength: nextStrength,
      updated_at: nowIso,
    });

    outcomes.push({
      id: frontmatter.id,
      relPath,
      category: frontmatter.category,
      previousStrength: prevStrength,
      nextStrength,
      accessCount: meta.access_count,
      daysSinceLastAccess,
      archived: shouldArchive,
      skippedExempt: false,
    });
  }

  return {
    date: dateStr,
    processedCount: outcomes.length,
    archivedIds,
    exemptIds,
    outcomes,
  };
}
