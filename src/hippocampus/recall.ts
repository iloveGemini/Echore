import type { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type ConcernRecord,
  type MemoryCategory,
  type MemoryStatus,
  type MemoryType,
} from "../core/schemas.ts";
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
  summary: string;
  frontstageNarrative?: string;
  hydratedQuote?: string;
  bucket: RecallBucket;
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

export interface RecallResult {
  items: RecalledMemoryItem[];
  formattedBlock: string;
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
 * §4.1 白天三桶保底配额 + 五路加权混排 + 原话引文预水合
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
  } = params;

  const allFiles = loadStructuredMemoryFiles(memoryDir);
  // Only retrieve active files (`有效` or `僵持待解`), excluding L0 INDEX, people symbol defs, and permanent rapport.md
  const candidateFiles = allFiles.filter(
    (f) =>
      (f.frontmatter.status === "有效" || f.frontmatter.status === "僵持待解") &&
      f.relPath !== "INDEX.md" &&
      f.relPath !== "implicit/rapport.md" &&
      !f.relPath.startsWith("people/"),
  );

  const bySymbol = new Map<string, ParsedMemoryFile>();
  for (const f of candidateFiles) {
    bySymbol.set(f.symbolKey, f);
  }

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
    edges: string[];
  }

  const scoredMap = new Map<string, ScoredCandidate>();
  const nowMs = now.getTime();

  for (const file of candidateFiles) {
    const meta = db.getMemoryMeta(file.frontmatter.id);
    const strength = meta?.strength ?? 0.75;

    const fileDateMs = new Date(`${file.frontmatter.date}T00:00:00Z`).getTime();
    const ageHours = Math.max(0, (nowMs - fileDateMs) / (3600 * 1000));
    const timeScore = Math.pow(2, -ageHours / 72); // 72h half-life for recency feature

    const sem =
      queryEmbedding && meta?.embedding
        ? cosineSimilarity(queryEmbedding, meta.embedding)
        : computeLexicalSemanticSimilarity(query, file.body);

    const kw = computeKeywordScore(query, file.body);

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

    scoredMap.set(file.symbolKey, {
      file,
      sem,
      kw,
      time: timeScore,
      strength,
      isRecentMainline,
      edges: extractReferencedSymbols(file.body),
    });
  }

  const selectedBucket = new Map<string, RecallBucket>();

  // 1. 桶 A · 近期生活主线槽（保底最多 3 条）
  const bucketACandidates = Array.from(scoredMap.values())
    .filter((c) => c.isRecentMainline)
    .sort((a, b) => b.time + b.strength - (a.time + a.strength))
    .slice(0, 3);

  for (const c of bucketACandidates) {
    selectedBucket.set(c.file.symbolKey, "bucket_a_mainline");
  }

  // 2. 桶 B · 话题直命槽（保底最多 5 条，语义 > 0.30 或关键词命中）
  const bucketBCandidates = Array.from(scoredMap.values())
    .filter(
      (c) =>
        !selectedBucket.has(c.file.symbolKey) &&
        (c.sem > 0.30 || c.kw > 0),
    )
    .sort((a, b) => b.sem * 0.7 + b.kw * 0.3 - (a.sem * 0.7 + a.kw * 0.3))
    .slice(0, 5);

  for (const c of bucketBCandidates) {
    selectedBucket.set(c.file.symbolKey, "bucket_b_topic");
  }

  // 3. 桶 C · 显式图谱顺藤摸瓜槽（顺着桶 A/B 命中文件的 [[path/symbol]] 显式边做 1 度邻居扩散，保底最多 3 条）
  const seedSymbols = new Set<string>(selectedBucket.keys());
  const graphScores = new Map<string, number>();

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
          Math.max(graphScores.get(otherKey) ?? 0, otherCand.strength * 0.85),
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
        (graphScores.get(b.file.symbolKey) ?? 0) -
        (graphScores.get(a.file.symbolKey) ?? 0),
    )
    .slice(0, 3);

  for (const c of bucketCCandidates) {
    selectedBucket.set(c.file.symbolKey, "bucket_c_graph");
  }

  // Fallback: if total selected < topK and there are remaining active candidates, fill by overall score
  const finalCandidates = Array.from(selectedBucket.keys()).map(
    (k) => scoredMap.get(k)!,
  );

  const ranked = finalCandidates
    .map((c) => {
      const gScore =
        graphScores.get(c.file.symbolKey) ??
        (selectedBucket.get(c.file.symbolKey) === "bucket_a_mainline" ? 0.5 : 0);
      const totalScore =
        weights.sem * c.sem +
        weights.kw * c.kw +
        weights.graph * gScore +
        weights.time * c.time +
        weights.strength * c.strength;

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
          summary,
          frontstageNarrative,
          bucket: selectedBucket.get(c.file.symbolKey)!,
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

  // 4. 对 Top 3 断言执行原话引文预水合（Pre-Hydration）
  const top3SourceIds = ranked
    .slice(0, 3)
    .map((r) => r.candidate.file.frontmatter.source_event_id);
  const hydratedMap = preHydrateQuotes(db, top3SourceIds);

  const items: RecalledMemoryItem[] = ranked.map((r, idx) => {
    const srcId = r.candidate.file.frontmatter.source_event_id;
    const hydratedQuote =
      idx < 3 && srcId ? hydratedMap.get(srcId) : undefined;
    return {
      ...r.item,
      ...(hydratedQuote ? { hydratedQuote } : {}),
    };
  });

  const formattedLines = items.map((item) => {
    const parts = [`- [${item.date}] ${item.summary}`];
    if (item.frontstageNarrative) {
      parts.push(`  我的印象：${item.frontstageNarrative}`);
    }
    if (item.hydratedQuote) {
      parts.push(`  当时原话：${item.hydratedQuote}`);
    }
    return parts.join("\n");
  });

  const formattedBlock = formattedLines.join("\n");
  assertNoInternalLeaks(formattedBlock, "recallMemories");

  return {
    items,
    formattedBlock,
  };
}
