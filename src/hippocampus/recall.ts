import {
  formatLocalDateStr,
  formatVagueWhen,
  localCalendarDaysBetween,
} from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type ConcernRecord,
  type MemoryCategory,
  type MemoryStatus,
  type MemoryType,
} from "../core/schemas.ts";
import { extractHotEntriesForDate } from "../frontstage/journal.ts";
import {
  loadStructuredMemoryFiles,
  type ParsedMemoryFile,
} from "./linter.ts";
import { preHydrateQuotes } from "./pre-hydrator.ts";

export type RecallBucket = "bucket_a_mainline" | "bucket_b_topic" | "bucket_c_graph";

export interface RecalledMemoryItem {
  id: string;
  symbolKey: string;
  relPath: string;
  type: MemoryType;
  category: MemoryCategory;
  status: MemoryStatus;
  date: string;
  vagueWhen?: string;
  summary: string;
  frontstageNarrative?: string;
  hydratedQuote?: string;
  bucket: RecallBucket;
  reactivatedFromArchive?: boolean;
  score: number;
  scoreBreakdown: {
    sem: number;
    kw: number;
    graph: number;
    time: number;
    strength: number;
  };
}

export interface RecallWeights {
  sem: number;
  kw: number;
  graph: number;
  time: number;
  strength: number;
}

/**
 * §4.1 1v1 陪伴 v0 初始启发权重
 */
export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  sem: 0.40,
  kw: 0.15,
  graph: 0.25,
  time: 0.10,
  strength: 0.10,
};

export const SESSION_REPEAT_PENALTY = 0.40;
export const TOPIC_RECALL_FLOOR = 0.30;

export interface RecallResult {
  items: RecalledMemoryItem[];
  formattedBlock: string;
  isIdleQuery: boolean;
  bypassedSessionDedup: boolean;
  rawEventSnippets: string[];
  reactivatedArchiveIds: string[];
}

const FILLER_PARTICLES_RE = /[嗯哦噢喔啊呀吗呢吧哈嘛啦呗嘞哇]/gu;
const ACK_SHORT_WORDS = new Set([
  "好",
  "好的",
  "可以",
  "收到",
  "知道",
  "知道了",
  "行的",
  "对的",
  "是的",
  "没事",
  "在的",
  "好吧",
  "随便",
  "ok",
  "okay",
  "嗯嗯",
  "哈哈",
  "哈哈哈",
]);

const EXPLICIT_REASK_RE =
  /刚(?:才)?说|再(?:讲|说|提)一遍|前面提|上面那|上次说|之前说|继续讲刚才/;
const QUOTED_TERM_RE = /[「『“"']([^」』”"']{2,60})[」』”"']/;
const LITERAL_TRIGGER_RE =
  /记得|说过|提到|关于|找一下|查一下|搜一下|以前聊|之前聊/;

/**
 * Wave 2.1 空档输入检测（吸收自 Psyche `isIdle`）：
 * 纯语气词、单字应答、Emoji 或“好的/收到/ok”等不构成新话题检索线索。
 */
export function isIdleQuery(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const core = trimmed
    .replace(
      /[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍]/gu,
      "",
    )
    .replace(/[\p{P}\p{S}\s]/gu, "")
    .toLowerCase();
  if (!core || ACK_SHORT_WORDS.has(core)) return true;
  const withoutFillers = core.replace(FILLER_PARTICLES_RE, "");
  return (
    Array.from(withoutFillers).length <= 1 ||
    ACK_SHORT_WORDS.has(withoutFillers)
  );
}

/**
 * Wave 2.2 用户点名重提/追问检测（命中时豁免本会话去重降权）
 */
export function isExplicitReaskQuery(text: string): boolean {
  return EXPLICIT_REASK_RE.test(text) || QUOTED_TERM_RE.test(text);
}

/**
 * Wave 2.3 字面精确检索触发器检测
 */
export function hasLiteralRecallTrigger(text: string): boolean {
  return QUOTED_TERM_RE.test(text) || LITERAL_TRIGGER_RE.test(text);
}

function normalizeContentFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[\[[^\]]+\]\]/g, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function tokenizeBigramsAndWords(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/\[\[[^\]]+\]\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const tokens: string[] = [];
  for (const part of cleaned.split(/\s+/)) {
    if (!part) continue;
    tokens.push(part);
    // Add character bigrams for CJK substring matching
    if (/[一-龥]/.test(part) && part.length >= 2) {
      for (let i = 0; i < part.length - 1; i++) {
        tokens.push(part.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length === 0 || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i]!;
    const b = vecB[i]!;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

function computeLexicalSemanticSimilarity(query: string, docText: string): number {
  const qTokens = tokenizeBigramsAndWords(query);
  const dTokens = tokenizeBigramsAndWords(docText);
  if (qTokens.length === 0 || dTokens.length === 0) return 0;

  const qFreq = new Map<string, number>();
  const dFreq = new Map<string, number>();
  for (const t of qTokens) qFreq.set(t, (qFreq.get(t) ?? 0) + 1);
  for (const t of dTokens) dFreq.set(t, (dFreq.get(t) ?? 0) + 1);

  let dot = 0;
  let normQ = 0;
  let normD = 0;
  for (const [k, v] of qFreq) {
    normQ += v * v;
    const dv = dFreq.get(k) ?? 0;
    dot += v * dv;
  }
  for (const [, v] of dFreq) {
    normD += v * v;
  }
  if (normQ === 0 || normD === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normQ) * Math.sqrt(normD))));
}

function computeKeywordScore(query: string, docText: string): number {
  const qTokens = Array.from(new Set(tokenizeBigramsAndWords(query)));
  if (qTokens.length === 0) return 0;
  const lowerDoc = docText.toLowerCase();
  let hits = 0;
  for (const token of qTokens) {
    if (lowerDoc.includes(token)) {
      hits += 1;
    }
  }
  return Math.min(1, hits / qTokens.length);
}

function extractReferencedSymbols(body: string): string[] {
  const refs: string[] = [];
  const matches = body.matchAll(/\[\[([^\]#]+)(?:#[^\]]+)?\]\]/g);
  for (const m of matches) {
    if (m[1]) refs.push(m[1].trim());
  }
  return Array.from(new Set(refs));
}

function extractBodySections(body: string): {
  summary: string;
  frontstageNarrative?: string;
} {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const assertions: string[] = [];
  const narratives: string[] = [];

  for (const line of lines) {
    if (line.startsWith("- ")) {
      // Strip any [src: log-xxx] before exposing
      assertions.push(line.replace(/\[src:\s*log-[^\]]+\]/gi, "").trim());
    } else if (line.startsWith(">")) {
      narratives.push(line.replace(/^>\s*/, "").trim());
    }
  }

  return {
    summary: assertions.join("；") || lines.slice(0, 2).join(" "),
    frontstageNarrative: narratives.length > 0 ? narratives.join(" ") : undefined,
  };
}

/**
 * §4.1 & Wave 2 白天三桶保底配额 + 空档短路 + 会话去重 + 三层级联（含 event_log_fts 与已沉底冷仓唤醒） + 原话引文预水合
 */
export function recallMemories(params: {
  memoryDir: string;
  db: EchoreDatabase;
  query: string;
  now: Date;
  activeConcerns?: ConcernRecord[];
  queryEmbedding?: number[];
  topK?: number;
  weights?: RecallWeights;
  recentSessionRecalledIds?: ReadonlySet<string>;
  excludeEventIds?: ReadonlySet<string>;
}): RecallResult {
  const {
    memoryDir,
    db,
    query,
    now,
    activeConcerns = [],
    queryEmbedding,
    topK = 10,
    weights = DEFAULT_RECALL_WEIGHTS,
    recentSessionRecalledIds,
    excludeEventIds,
  } = params;

  const idle = isIdleQuery(query);
  const bypassedSessionDedup = isExplicitReaskQuery(query);
  const literalTriggered = hasLiteralRecallTrigger(query);

  const allFiles = loadStructuredMemoryFiles(memoryDir);
  // Stage 1: Active files (`有效` or `僵持待解`), excluding L0 INDEX, people symbol defs, and permanent rapport.md
  const candidateFiles = allFiles.filter(
    (f) =>
      (f.frontmatter.status === "有效" || f.frontmatter.status === "僵持待解") &&
      f.relPath !== "INDEX.md" &&
      f.relPath !== "implicit/rapport.md" &&
      !f.relPath.startsWith("people/"),
  );
  const archivedFiles = allFiles.filter(
    (f) =>
      f.frontmatter.status === "已沉底" &&
      f.relPath !== "INDEX.md" &&
      f.relPath !== "implicit/rapport.md" &&
      !f.relPath.startsWith("people/"),
  );

  const activeConcernSourceIds = new Set(
    activeConcerns.map((c) => c.source_event_id),
  );
  const activeConcernIds = new Set(activeConcerns.map((c) => c.id));

  // Pre-calculate base features per candidate
  interface ScoredCandidate {
    file: ParsedMemoryFile;
    sem: number;
    kw: number;
    time: number;
    strength: number;
    isRecentMainline: boolean;
    isLinkedToActiveConcern: boolean;
    sessionPenalty: number;
    fingerprint: string;
    edges: string[];
  }

  const scoredMap = new Map<string, ScoredCandidate>();

  for (const file of candidateFiles) {
    const meta = db.getMemoryMeta(file.frontmatter.id);
    const strength = meta?.strength ?? 0.75;

    const ageHours = localCalendarDaysBetween(file.frontmatter.date, now) * 24;
    const timeScore = Math.pow(2, -ageHours / 72); // 72h half-life for recency feature

    const sem = idle
      ? 0
      : queryEmbedding && meta?.embedding
        ? cosineSimilarity(queryEmbedding, meta.embedding)
        : computeLexicalSemanticSimilarity(query, file.body);

    const kw = idle ? 0 : computeKeywordScore(query, file.body);

    const isMainlineCategory =
      file.frontmatter.category === "schedule" ||
      file.frontmatter.category === "life_event" ||
      file.frontmatter.category === "health" ||
      file.frontmatter.category === "solitary";

    const isLinkedToActiveConcern =
      activeConcernIds.has(file.frontmatter.id) ||
      (file.frontmatter.source_event_id !== undefined &&
        activeConcernSourceIds.has(file.frontmatter.source_event_id));

    const isRecentMainline =
      (isMainlineCategory && ageHours <= 72) || isLinkedToActiveConcern;

    const isSessionRepeated =
      !bypassedSessionDedup &&
      !isLinkedToActiveConcern &&
      Boolean(recentSessionRecalledIds?.has(file.frontmatter.id));

    const { summary } = extractBodySections(file.body);

    scoredMap.set(file.symbolKey, {
      file,
      sem,
      kw,
      time: timeScore,
      strength,
      isRecentMainline,
      isLinkedToActiveConcern,
      sessionPenalty: isSessionRepeated ? SESSION_REPEAT_PENALTY : 1.0,
      fingerprint: normalizeContentFingerprint(summary),
      edges: extractReferencedSymbols(file.body),
    });
  }

  const selectedBucket = new Map<string, RecallBucket>();
  const usedFingerprints = new Set<string>();

  const trySelect = (c: ScoredCandidate, bucket: RecallBucket): boolean => {
    if (selectedBucket.has(c.file.symbolKey)) return false;
    if (c.fingerprint.length >= 6 && usedFingerprints.has(c.fingerprint)) {
      return false;
    }
    selectedBucket.set(c.file.symbolKey, bucket);
    if (c.fingerprint.length >= 6) {
      usedFingerprints.add(c.fingerprint);
    }
    return true;
  };

  // 1. 桶 A · 近期生活主线槽（空档输入最多保底 2 条，正常查询最多保底 3 条）
  const bucketALimit = idle ? Math.min(2, topK) : 3;
  const bucketACandidates = Array.from(scoredMap.values())
    .filter((c) => c.isRecentMainline)
    .sort((a, b) => b.time + b.strength - (a.time + a.strength));

  let bucketACount = 0;
  for (const c of bucketACandidates) {
    if (bucketACount >= bucketALimit) break;
    if (trySelect(c, "bucket_a_mainline")) {
      bucketACount += 1;
    }
  }

  // Wave 2.1: 若为空档输入（嗯/好的/哈哈），短路跳过桶 B、桶 C 与 Stage 2/3 级联
  const graphScores = new Map<string, number>();
  let bucketBHitCount = 0;

  if (!idle) {
    // 2. 桶 B · 话题直命槽（保底最多 5 条，语义 > 0.30 或关键词命中，会话已注入条目乘 sessionPenalty 降权）
    const bucketBCandidates = Array.from(scoredMap.values())
      .filter(
        (c) =>
          !selectedBucket.has(c.file.symbolKey) &&
          (c.sem > TOPIC_RECALL_FLOOR || c.kw > 0),
      )
      .sort(
        (a, b) =>
          (b.sem * 0.7 + b.kw * 0.3) * b.sessionPenalty -
          (a.sem * 0.7 + a.kw * 0.3) * a.sessionPenalty,
      );

    for (const c of bucketBCandidates) {
      if (bucketBHitCount >= 5) break;
      if (trySelect(c, "bucket_b_topic")) {
        bucketBHitCount += 1;
      }
    }

    // 3. 桶 C · 显式图谱顺藤摸瓜槽（顺着桶 A/B 命中文件的 [[path/symbol]] 显式边做 1 度邻居扩散，保底最多 3 条）
    const seedSymbols = new Set<string>(selectedBucket.keys());

    for (const seedKey of seedSymbols) {
      const seed = scoredMap.get(seedKey);
      if (!seed) continue;

      // Outgoing edges from seed -> target
      for (const targetSym of seed.edges) {
        const targetCand = scoredMap.get(targetSym);
        if (targetCand) {
          graphScores.set(
            targetSym,
            Math.max(graphScores.get(targetSym) ?? 0, targetCand.strength),
          );
        }
      }

      // Incoming edges: other active files referencing the same symbol or seed
      for (const [otherKey, otherCand] of scoredMap.entries()) {
        if (otherKey === seedKey) continue;
        const sharesEntityOrDirectLink =
          otherCand.edges.includes(seedKey) ||
          otherCand.edges.some(
            (e) => !e.startsWith("people/") && seed.edges.includes(e),
          );
        if (sharesEntityOrDirectLink) {
          graphScores.set(
            otherKey,
            Math.max(
              graphScores.get(otherKey) ?? 0,
              otherCand.strength * 0.85,
            ),
          );
        }
      }
    }

    const bucketCCandidates = Array.from(scoredMap.values())
      .filter(
        (c) =>
          !selectedBucket.has(c.file.symbolKey) &&
          (graphScores.get(c.file.symbolKey) ?? 0) > 0,
      )
      .sort(
        (a, b) =>
          (graphScores.get(b.file.symbolKey) ?? 0) * b.sessionPenalty -
          (graphScores.get(a.file.symbolKey) ?? 0) * a.sessionPenalty,
      );

    let bucketCCount = 0;
    for (const c of bucketCCandidates) {
      if (bucketCCount >= 3) break;
      if (trySelect(c, "bucket_c_graph")) {
        bucketCCount += 1;
      }
    }

    // Ensure guaranteed buckets (A + B + C) do not exceed topK by trimming excess from Bucket B first, then C, then A
    if (selectedBucket.size > topK) {
      const trimFromBucket = (targetBucket: RecallBucket) => {
        const keysInBucket = Array.from(selectedBucket.entries())
          .filter(([, b]) => b === targetBucket)
          .map(([k]) => k)
          .reverse();
        for (const k of keysInBucket) {
          if (selectedBucket.size <= topK) break;
          selectedBucket.delete(k);
        }
      };
      trimFromBucket("bucket_b_topic");
      trimFromBucket("bucket_c_graph");
      trimFromBucket("bucket_a_mainline");
    }

    // Fallback: if total selected < topK and there are remaining active candidates with relevant score, fill by overall score
    if (selectedBucket.size < topK) {
      const remainingCandidates = Array.from(scoredMap.values())
        .filter(
          (c) =>
            !selectedBucket.has(c.file.symbolKey) &&
            (c.sem > 0 ||
              c.kw > 0 ||
              (graphScores.get(c.file.symbolKey) ?? 0) > 0),
        )
        .sort((a, b) => {
          const gA = graphScores.get(a.file.symbolKey) ?? 0;
          const gB = graphScores.get(b.file.symbolKey) ?? 0;
          const scoreA =
            (weights.sem * a.sem +
              weights.kw * a.kw +
              weights.graph * gA +
              weights.time * a.time +
              weights.strength * a.strength) *
            a.sessionPenalty;
          const scoreB =
            (weights.sem * b.sem +
              weights.kw * b.kw +
              weights.graph * gB +
              weights.time * b.time +
              weights.strength * b.strength) *
            b.sessionPenalty;
          return scoreB - scoreA;
        });

      for (const rem of remainingCandidates) {
        if (selectedBucket.size >= topK) break;
        trySelect(rem, "bucket_b_topic");
      }
    }
  }

  const finalCandidates = Array.from(selectedBucket.keys()).map(
    (k) => scoredMap.get(k)!,
  );

  const ranked: Array<{
    candidate: ScoredCandidate;
    item: RecalledMemoryItem;
  }> = finalCandidates
    .map((c) => {
      const bucket = selectedBucket.get(c.file.symbolKey)!;
      const gScore =
        graphScores.get(c.file.symbolKey) ??
        (bucket === "bucket_a_mainline" ? 0.5 : 0);
      const rawTotalScore =
        weights.sem * c.sem +
        weights.kw * c.kw +
        weights.graph * gScore +
        weights.time * c.time +
        weights.strength * c.strength;
      const totalScore =
        bucket === "bucket_a_mainline"
          ? rawTotalScore
          : rawTotalScore * c.sessionPenalty;

      const { summary, frontstageNarrative } = extractBodySections(c.file.body);
      return {
        candidate: c,
        item: {
          id: c.file.frontmatter.id,
          symbolKey: c.file.symbolKey,
          relPath: c.file.relPath,
          type: c.file.frontmatter.type,
          category: c.file.frontmatter.category,
          status: c.file.frontmatter.status,
          date: c.file.frontmatter.date,
          vagueWhen: formatVagueWhen(c.file.frontmatter.date, now),
          summary,
          frontstageNarrative,
          bucket,
          score: Number(totalScore.toFixed(4)),
          scoreBreakdown: {
            sem: Number(c.sem.toFixed(4)),
            kw: Number(c.kw.toFixed(4)),
            graph: Number(gScore.toFixed(4)),
            time: Number(c.time.toFixed(4)),
            strength: Number(c.strength.toFixed(4)),
          },
        } satisfies RecalledMemoryItem,
      };
    })
    .sort((a, b) => b.item.score - a.item.score)
    .slice(0, topK);

  // Stage 3 (Wave 2.3): `已沉底` 冷仓兜底唤醒闭环（§4.4）
  // 常规查询不扫 `已沉底`（已退出白天常规召回池）；仅当用户显式提起旧茬（literalTriggered）且 Stage 1 活跃桶 B 无命中时，才开箱检索 `已沉底` 冷归档
  const reactivatedArchiveIds: string[] = [];
  if (
    !idle &&
    literalTriggered &&
    bucketBHitCount === 0 &&
    archivedFiles.length > 0 &&
    ranked.length < topK
  ) {
    const queryCjkOrWords = tokenizeBigramsAndWords(query).filter(
      (t) => Array.from(t).length >= 2,
    );
    const archivedHits = archivedFiles
      .map((file) => {
        const meta = db.getMemoryMeta(file.frontmatter.id);
        const strength = meta?.strength ?? 0.12;
        const sem =
          queryEmbedding && meta?.embedding
            ? cosineSimilarity(queryEmbedding, meta.embedding)
            : computeLexicalSemanticSimilarity(query, file.body);
        const kw = computeKeywordScore(query, file.body);
        const hasSpecificTokenHit = queryCjkOrWords.some((t) =>
          file.body.toLowerCase().includes(t),
        );
        return { file, sem, kw, strength, hasSpecificTokenHit };
      })
      .filter(
        (a) =>
          a.sem > TOPIC_RECALL_FLOOR || (a.kw > 0 && a.hasSpecificTokenHit),
      )
      .sort((a, b) => b.sem * 0.7 + b.kw * 0.3 - (a.sem * 0.7 + a.kw * 0.3))
      .slice(0, Math.min(2, topK - ranked.length));

    for (const arch of archivedHits) {
      const { summary, frontstageNarrative } = extractBodySections(
        arch.file.body,
      );
      const fp = normalizeContentFingerprint(summary);
      if (fp.length >= 6 && usedFingerprints.has(fp)) continue;
      if (fp.length >= 6) usedFingerprints.add(fp);

      const ageHours =
        localCalendarDaysBetween(arch.file.frontmatter.date, now) * 24;
      const timeScore = Math.pow(2, -ageHours / 72);
      const totalScore =
        weights.sem * arch.sem +
        weights.kw * arch.kw +
        weights.time * timeScore +
        weights.strength * arch.strength;

      reactivatedArchiveIds.push(arch.file.frontmatter.id);
      ranked.push({
        candidate: {
          file: arch.file,
          sem: arch.sem,
          kw: arch.kw,
          time: timeScore,
          strength: arch.strength,
          isRecentMainline: false,
          isLinkedToActiveConcern: false,
          sessionPenalty: 1.0,
          fingerprint: fp,
          edges: [],
        },
        item: {
          id: arch.file.frontmatter.id,
          symbolKey: arch.file.symbolKey,
          relPath: arch.file.relPath,
          type: arch.file.frontmatter.type,
          category: arch.file.frontmatter.category,
          status: arch.file.frontmatter.status,
          date: arch.file.frontmatter.date,
          vagueWhen: formatVagueWhen(arch.file.frontmatter.date, now),
          summary,
          frontstageNarrative,
          bucket: "bucket_b_topic",
          reactivatedFromArchive: true,
          score: Number(totalScore.toFixed(4)),
          scoreBreakdown: {
            sem: Number(arch.sem.toFixed(4)),
            kw: Number(arch.kw.toFixed(4)),
            graph: 0,
            time: Number(timeScore.toFixed(4)),
            strength: Number(arch.strength.toFixed(4)),
          },
        },
      });
    }
  }

  // 4. 对 Top 3 断言执行原话引文预水合（Pre-Hydration，传入 now 生成模糊时间体感）
  const top3SourceIds = ranked
    .slice(0, 3)
    .map((r) => r.candidate.file.frontmatter.source_event_id);
  const hydratedMap = preHydrateQuotes(db, top3SourceIds, now);

  const items: RecalledMemoryItem[] = ranked.map((r, idx) => {
    const srcId = r.candidate.file.frontmatter.source_event_id;
    const hydratedQuote =
      idx < 3 && srcId ? hydratedMap.get(srcId) : undefined;
    return {
      ...r.item,
      ...(hydratedQuote ? { hydratedQuote } : {}),
    };
  });

  // Stage 2 (Wave 2.3): Literal 专名通道 & SQLite event_log_fts / 当日热记事兜底
  const rawEventSnippets: string[] = [];
  if (!idle && (bucketBHitCount === 0 || literalTriggered)) {
    const hydratedIds = new Set(
      top3SourceIds.filter((id): id is string => Boolean(id)),
    );
    const ftsHits = db
      .searchEventLogsFts(query, 6)
      .filter(
        (ev) =>
          !excludeEventIds?.has(ev.id) &&
          !hydratedIds.has(ev.id) &&
          ev.content.trim() !== query.trim(),
      )
      .slice(0, 2);

    for (const ev of ftsHits) {
      const clean = ev.content
        .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      const vague = formatVagueWhen(ev.timestamp, now);
      const dateStr = ev.timestamp.slice(0, 10);
      const timeLabel = vague !== dateStr ? `${vague} · ${dateStr}` : dateStr;
      const speaker = ev.role === "user" ? "他说" : "我当时说";
      rawEventSnippets.push(
        `- [当时原话线索 · ${timeLabel}] ${speaker}：“${clean}”`,
      );
    }

    if (rawEventSnippets.length < 2) {
      const todayHot = extractHotEntriesForDate(
        memoryDir,
        formatLocalDateStr(now),
      );
      const qTokens = tokenizeBigramsAndWords(query).filter(
        (t) => Array.from(t).length >= 2,
      );
      for (const hotLine of todayHot) {
        if (rawEventSnippets.length >= 2) break;
        if (qTokens.some((t) => hotLine.toLowerCase().includes(t))) {
          const cleanHot = hotLine
            .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
            .trim();
          rawEventSnippets.push(`- [今日热记事线索] ${cleanHot}`);
        }
      }
    }
  }

  const formattedLines = items.map((item) => {
    const timeTag =
      item.vagueWhen && item.vagueWhen !== item.date
        ? `${item.vagueWhen} · ${item.date}`
        : item.date;
    const prefixTag = item.reactivatedFromArchive
      ? `[翻出的旧记忆 · ${timeTag}]`
      : `[${timeTag}]`;
    const parts = [`- ${prefixTag} ${item.summary}`];
    if (item.frontstageNarrative) {
      parts.push(`  我的印象：${item.frontstageNarrative}`);
    }
    if (item.hydratedQuote) {
      parts.push(`  当时原话：${item.hydratedQuote}`);
    }
    return parts.join("\n");
  });

  if (rawEventSnippets.length > 0) {
    formattedLines.push(...rawEventSnippets);
  }

  const formattedBlock = formattedLines.join("\n");
  assertNoInternalLeaks(formattedBlock, "recallMemories");

  return {
    items,
    formattedBlock,
    isIdleQuery: idle,
    bypassedSessionDedup,
    rawEventSnippets,
    reactivatedArchiveIds,
  };
}
