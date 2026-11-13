import {
  formatLocalDateStr,
  formatVagueWhen,
  localCalendarDaysBetween,
} from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import { PROMPTS_DIR, readPrompt } from "../core/prompts.ts";
import {
  assertNoInternalLeaks,
  type ConcernRecord,
  type MemoryCategory,
  type MemoryStatus,
  type MemoryType,
} from "../core/schemas.ts";
import { extractHotEntriesForDate } from "../frontstage/journal.ts";
import type { OrganModelRouter } from "../llm/router.ts";
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
  stanceAnchored?: boolean;
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
export const HOP1_MIN_STRENGTH = 0.30;
export const HOP2_MIN_STRENGTH = 0.50;
export const HUB_DEGREE_THRESHOLD = 5;
export const DIACHRONIC_EDGE_DAMPING = 0.40;
export const RRF_DEFAULT_K = 60;
export const STANCE_ANCHOR_BOOST = 0.22;
export const STANCE_CUE_VERIFY_TIMEOUT_MS = 1200;
export const QUERY_EMBEDDING_TIMEOUT_MS = 1200;
export const TRANSITION_RECALL_MIN_WEIGHT = 0.20;
export const TRANSITION_RECALL_COEFF = 0.70;

export type StanceBinaryVerifier = (input: {
  userMessage: string;
  lastAssistantReply: string;
}) => Promise<boolean>;

const STANCE_OPINION_RE =
  /觉得|认为|看法|喜欢|讨厌|烦|无聊|没(?:什么)?意思|好看|难看|故弄玄虚|烂|吹过头|蠢|没劲|过誉|矫情/;
const STANCE_PRESSURE_RE =
  /对吧|是不是|对不对|你说呢|怎么看|肯定也|算了吧|吧[？?~～!！。]*$|呢[？?~～!！。]*$|吗[？?~～!！。]*$/;
const RESIDENT_STANCE_RE =
  /我觉得|我认为|我喜欢|我讨厌|我不喜欢|我最喜欢|我最讨厌|我不信|我反而|我不同意|在我看来|我宁可|我偏|我倒觉得|我向来|我才不/;
const SELF_STANCE_PREDICATE_RE =
  /^(?:-\s*)?(?:偏好|立场|底线|原则|看法)\s*\(\s*\[\[people\/self\]\]/m;

const DIACHRONIC_GRAPH_PREDICATES = new Set([
  "历史背景",
  "曾用状态",
  "情境表态",
  "结转",
]);

const CONVERSATIONAL_STOP_TOKENS = new Set([
  "的",
  "了",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "哦",
  "嘛",
  "呗",
  "我",
  "你",
  "他",
  "她",
  "它",
  "是",
  "在",
  "有",
  "和",
  "就",
  "都",
  "而",
  "及",
  "与",
  "着",
  "或",
  "一个",
  "一下",
  "今天",
  "刚才",
  "现在",
  "觉得",
  "突然",
  "可以",
  "什么",
  "怎么",
  "我们",
  "你们",
  "自己",
]);

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
  const normalizedAck = withoutFillers.replace(/的+$/u, "");
  return (
    Array.from(normalizedAck).length <= 1 ||
    ACK_SHORT_WORDS.has(withoutFillers) ||
    ACK_SHORT_WORDS.has(normalizedAck)
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

/**
 * Wave 4.3 双门控 B 立场锚 — 门控 1：检测用户话语是否同时包含「评价主张词」与「征询/施压反问词」
 */
export function isStanceCue(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return STANCE_OPINION_RE.test(trimmed) && STANCE_PRESSURE_RE.test(trimmed);
}

/**
 * Wave 6.1 两段式门控（Stage 1 异步二元复筛）：
 * - Stage 0 未命中 isStanceCue() 直接返回 false（零延迟）；
 * - Stage 0 命中后不再设歧义正则预筛，全部送入轻量二元判定（钉死走 `endocrine` 路由槽位或测试桩）；
 * - 超时（默认 1200ms）或异常时安全降级返回 true（回退 Stage 0 正则结果）。
 */
export async function verifyStanceCueWithOrgan(params: {
  userMessage: string;
  lastAssistantReply?: string;
  router?: OrganModelRouter;
  verifier?: StanceBinaryVerifier;
  timeoutMs?: number;
  promptsDir?: string;
}): Promise<boolean> {
  const {
    userMessage,
    lastAssistantReply = "",
    router,
    verifier,
    timeoutMs = STANCE_CUE_VERIFY_TIMEOUT_MS,
    promptsDir = PROMPTS_DIR,
  } = params;

  if (!isStanceCue(userMessage)) {
    return false;
  }

  const trimmedPrev = lastAssistantReply.trim().slice(-500);
  const runWithTimeout = async <T>(
    taskFactory: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const task = Promise.resolve().then(taskFactory);
      const timeoutPromise = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      });
      return await Promise.race([task, timeoutPromise]);
    } catch {
      return fallback;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  if (verifier) {
    return runWithTimeout(
      () =>
        verifier({
          userMessage,
          lastAssistantReply: trimmedPrev,
        }),
      true,
    );
  }

  if (!router) {
    return true;
  }

  return runWithTimeout(async () => {
    const route = router.getRoute("endocrine");
    const system = readPrompt("stance-cue-judge.md", promptsDir).text;
    const promptBody = trimmedPrev
      ? `我先对用户说：「${trimmedPrev}」\n用户接着对我说：「${userMessage}」\n（要判断的是用户接着说的这一条：用户是在针对『我』的看法/喜好发问或施压表态吗？若只是在转述或吐槽第三方，答 NO。只输出 YES 或 NO。）`
      : `用户对我说：「${userMessage}」\n（用户是在针对『我』的看法/喜好发问或施压表态吗？若只是在转述或吐槽第三方，答 NO。只输出 YES 或 NO。）`;

    const resp = await route.provider.generate({
      model: route.model,
      maxTokens: 16,
      system,
      messages: [{ role: "user", content: promptBody }],
    });
    const text = resp.text.trim();
    if (/^(?:NO|否|不是的?|不对)(?:[\s\p{P}]|$)|\bNO\b/iu.test(text)) {
      return false;
    }
    if (/^(?:YES|是的?|对)(?:[\s\p{P}]|$)|\bYES\b/iu.test(text)) {
      return true;
    }
    return true;
  }, true);
}

/**
 * Wave 4.3 双门控 B 立场锚 — 门控 2：检测记忆文件是否承载住户自身明确表态或原则立场
 */
export function hasMemoryStance(file: ParsedMemoryFile): boolean {
  const { frontstageNarrative } = extractBodySections(file.body);
  if (frontstageNarrative && RESIDENT_STANCE_RE.test(frontstageNarrative)) {
    return true;
  }
  return SELF_STANCE_PREDICATE_RE.test(file.body);
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
  const qTokens = Array.from(new Set(tokenizeBigramsAndWords(query))).filter(
    (t) => !CONVERSATIONAL_STOP_TOKENS.has(t),
  );
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

/**
 * Wave 3.2 实词 IDF 字面打分（吸收自 Psyche `surface.ts`）：
 * 按候选文档集计算每个命中实词的稀有度 IDF，并用文档集对数容量归一，防止长句日常闲聊词稀释核心专名得分。
 */
export function computeIdfKeywordScores(
  query: string,
  docs: ReadonlyArray<{ key: string; text: string }>,
): Map<string, number> {
  const result = new Map<string, number>();
  if (docs.length === 0) return result;

  const rawTokens = Array.from(new Set(tokenizeBigramsAndWords(query)));
  const filteredTokens = rawTokens.filter(
    (t) =>
      !CONVERSATIONAL_STOP_TOKENS.has(t) &&
      (Array.from(t).length >= 2 || /[a-z0-9]/i.test(t)),
  );
  const qTokens = filteredTokens.length > 0 ? filteredTokens : rawTokens;
  if (qTokens.length === 0) {
    for (const d of docs) result.set(d.key, 0);
    return result;
  }

  const lowerDocs = new Map<string, string>();
  for (const d of docs) {
    lowerDocs.set(d.key, d.text.toLowerCase());
  }

  const nDocs = Math.max(docs.length + 1, 6);
  const dfMap = new Map<string, number>();
  for (const token of qTokens) {
    let df = 0;
    for (const d of docs) {
      if (lowerDocs.get(d.key)!.includes(token)) {
        df += 1;
      }
    }
    dfMap.set(token, df);
  }

  const normDenom = Math.max(Math.log(nDocs) * 1.8, 1);
  for (const d of docs) {
    const low = lowerDocs.get(d.key)!;
    let idfSum = 0;
    for (const token of qTokens) {
      if (low.includes(token)) {
        const df = dfMap.get(token) ?? 0;
        idfSum += Math.log(nDocs / (df + 1));
      }
    }
    result.set(d.key, Math.min(1, Number((idfSum / normDenom).toFixed(6))));
  }

  return result;
}

/**
 * Wave 3.2 三检索通道（sem / kw / graph）加权 RRF 融合（吸收自 LMC-5 `RECALL_FUSION_AB`）：
 * 仅对真正的查询检索/关联通道排 RRF（不含固有标量 time / strength），压制单通道固定高分霸榜并奖励跨通道互证。
 */
export function computeThreeChannelRrfScores(
  candidates: ReadonlyArray<{
    key: string;
    sem: number;
    kw: number;
    graph: number;
  }>,
  k = RRF_DEFAULT_K,
  channelWeights = { sem: 1.0, kw: 1.0, graph: 0.8 },
): Map<string, number> {
  const rawRrf = new Map<string, number>();
  for (const c of candidates) {
    rawRrf.set(c.key, 0);
  }

  const addChannelRanks = (
    getter: (c: { key: string; sem: number; kw: number; graph: number }) => number,
    weight: number,
  ) => {
    if (weight <= 0) return;
    const active = candidates
      .filter((c) => getter(c) > 0)
      .sort((a, b) => getter(b) - getter(a));
    active.forEach((c, idx) => {
      rawRrf.set(c.key, (rawRrf.get(c.key) ?? 0) + weight / (k + idx + 1));
    });
  };

  addChannelRanks((c) => c.sem, channelWeights.sem);
  addChannelRanks((c) => c.kw, channelWeights.kw);
  addChannelRanks((c) => c.graph, channelWeights.graph);

  const maxPossible =
    (channelWeights.sem + channelWeights.kw + channelWeights.graph) / (k + 1);
  const normalized = new Map<string, number>();
  for (const [key, val] of rawRrf.entries()) {
    normalized.set(
      key,
      maxPossible > 0 ? Math.min(1, Number((val / maxPossible).toFixed(6))) : 0,
    );
  }
  return normalized;
}

export interface TypedMemoryEdge {
  targetSymbol: string;
  isDiachronic: boolean;
}

function extractTypedEdges(body: string): TypedMemoryEdge[] {
  const edgeMap = new Map<string, boolean>();
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) {
      continue;
    }
    const predMatch = trimmed.match(/^(?:-\s*)?([^\s(（#>-]+)\s*\((.+)\)/);
    const predName = predMatch?.[1] ?? "";
    const isDiachronic = DIACHRONIC_GRAPH_PREDICATES.has(predName);
    const matches = trimmed.matchAll(/\[\[([^\]#]+)(?:#[^\]]+)?\]\]/g);
    for (const m of matches) {
      const sym = m[1]?.trim();
      if (!sym) continue;
      const existing = edgeMap.get(sym);
      // 若同一目标在共时谓词中也出现过，优先保留共时有效边（isDiachronic = false）
      if (existing === undefined || (existing === true && !isDiachronic)) {
        edgeMap.set(sym, isDiachronic);
      }
    }
  }
  return Array.from(edgeMap.entries()).map(([targetSymbol, isDiachronic]) => ({
    targetSymbol,
    isDiachronic,
  }));
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
 * Wave 5.1 记忆向量化编码源文本合成：
 * `when_to_recall ? `${when_to_recall}\n${summary}` : summary`
 */
export function buildMemoryEmbeddingText(file: ParsedMemoryFile): string {
  const { summary } = extractBodySections(file.body);
  const cue = file.frontmatter.when_to_recall?.trim();
  return cue ? `${cue}\n${summary}` : summary;
}

/**
 * Wave 5.1 查询侧异步向量编码（带超时与降级保护，供同步 recallMemories / probeWhatIf 调用前计算）：
 * - 空档输入或未配置 embedding 路由时直接返回 undefined（零开销回退词法+IDF）；
 * - 超时（默认 1200ms）或异常时安全返回 undefined。
 */
export async function embedQueryWithOrgan(params: {
  query: string;
  router?: OrganModelRouter;
  timeoutMs?: number;
}): Promise<number[] | undefined> {
  const { query, router, timeoutMs = QUERY_EMBEDDING_TIMEOUT_MS } = params;
  const trimmed = query.trim();
  if (!trimmed || isIdleQuery(trimmed) || !router?.getEmbeddingRoute()) {
    return undefined;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const task = Promise.resolve()
      .then(() => router.embedTexts([trimmed]))
      .then((vecs) =>
        vecs && Array.isArray(vecs[0]) && vecs[0].length > 0
          ? vecs[0]
          : undefined,
      );
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    return await Promise.race([task, timeoutPromise]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  stanceCueOverride?: boolean;
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
    stanceCueOverride,
  } = params;

  const idle = isIdleQuery(query);
  const bypassedSessionDedup = isExplicitReaskQuery(query);
  const literalTriggered = hasLiteralRecallTrigger(query);
  const stanceCueActive = !idle && (stanceCueOverride ?? isStanceCue(query));

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
    stanceAnchored: boolean;
    sessionPenalty: number;
    fingerprint: string;
    edges: string[];
    typedEdges: TypedMemoryEdge[];
  }

  const scoredMap = new Map<string, ScoredCandidate>();
  const byIdToSymbol = new Map<string, string>();
  const idfMap = idle
    ? new Map<string, number>()
    : computeIdfKeywordScores(
        query,
        candidateFiles.map((f) => ({
          key: f.symbolKey,
          text: f.frontmatter.when_to_recall
            ? `${f.frontmatter.when_to_recall}\n${f.body}`
            : f.body,
        })),
      );

  for (const file of candidateFiles) {
    byIdToSymbol.set(file.frontmatter.id, file.symbolKey);
    const meta = db.getMemoryMeta(file.frontmatter.id);
    const strength = meta?.strength ?? 0.75;

    const ageHours = localCalendarDaysBetween(file.frontmatter.date, now) * 24;
    const timeScore = Math.pow(2, -ageHours / 72); // 72h half-life for recency feature

    const cueText = file.frontmatter.when_to_recall?.trim();
    let sem = 0;
    if (!idle) {
      if (queryEmbedding && meta?.embedding) {
        sem = cosineSimilarity(queryEmbedding, meta.embedding);
      } else {
        const sBody = computeLexicalSemanticSimilarity(query, file.body);
        if (cueText) {
          const sCue = computeLexicalSemanticSimilarity(query, cueText);
          sem = Math.min(1, Math.max(sBody, 0.85 * sCue + 0.15 * sBody));
        } else {
          sem = sBody;
        }
      }
    }

    const kw = idle ? 0 : (idfMap.get(file.symbolKey) ?? 0);

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

    // Wave 4.3 双门控立场锚：同时满足门控 1（用户评价+施压反问）与门控 2（住户历史表态 + 实质话题重叠 sem > 0.30 或 kw > 0.25）
    const stanceAnchored =
      stanceCueActive &&
      hasMemoryStance(file) &&
      (sem > TOPIC_RECALL_FLOOR || kw > 0.25);

    const isSessionRepeated =
      !bypassedSessionDedup &&
      !isLinkedToActiveConcern &&
      !stanceAnchored &&
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
      stanceAnchored,
      sessionPenalty: isSessionRepeated ? SESSION_REPEAT_PENALTY : 1.0,
      fingerprint: normalizeContentFingerprint(summary),
      edges: extractReferencedSymbols(file.body),
      typedEdges: extractTypedEdges(file.body),
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
    // 2. 桶 B · 话题直命槽（保底最多 5 条，语义 > 0.30 或关键词命中，立场锚给予 +0.22 加成并豁免会话去重）
    const bucketBCandidates = Array.from(scoredMap.values())
      .filter(
        (c) =>
          !selectedBucket.has(c.file.symbolKey) &&
          (c.sem > TOPIC_RECALL_FLOOR || c.kw > 0),
      )
      .sort((a, b) => {
        const boostA = a.stanceAnchored ? STANCE_ANCHOR_BOOST : 0;
        const boostB = b.stanceAnchored ? STANCE_ANCHOR_BOOST : 0;
        return (
          (b.sem * 0.7 + b.kw * 0.3 + boostB) * b.sessionPenalty -
          (a.sem * 0.7 + a.kw * 0.3 + boostA) * a.sessionPenalty
        );
      });

    for (const c of bucketBCandidates) {
      if (bucketBHitCount >= 5) break;
      if (trySelect(c, "bucket_b_topic")) {
        bucketBHitCount += 1;
      }
    }

    // 3. 桶 C · 显式图谱顺藤摸瓜槽（Wave 3.3：支持 2 跳安全扩散，Hop1 >= 0.30 / Hop2 >= 0.50，历时边 0.40x 阻尼，度数 >= 5 的 Hub 节点不做二跳中继）
    const seedSymbols = new Set<string>(selectedBucket.keys());

    // 预计算活跃记忆图谱中每个符号的总度数（入度+出度，不含 people/*）以识别 Hub 节点
    const neighborSets = new Map<string, Set<string>>();
    const ensureNeighborSet = (sym: string): Set<string> => {
      let s = neighborSets.get(sym);
      if (!s) {
        s = new Set<string>();
        neighborSets.set(sym, s);
      }
      return s;
    };
    for (const [symKey, cand] of scoredMap.entries()) {
      for (const edge of cand.typedEdges) {
        if (edge.targetSymbol.startsWith("people/")) continue;
        if (scoredMap.has(edge.targetSymbol) && edge.targetSymbol !== symKey) {
          ensureNeighborSet(symKey).add(edge.targetSymbol);
          ensureNeighborSet(edge.targetSymbol).add(symKey);
        }
      }
    }

    const hop1Scores = new Map<string, number>();

    for (const seedKey of seedSymbols) {
      const seed = scoredMap.get(seedKey);
      if (!seed) continue;

      // Hop 1 Outgoing edges from seed -> target
      for (const edge of seed.typedEdges) {
        const targetCand = scoredMap.get(edge.targetSymbol);
        if (!targetCand || targetCand.strength < HOP1_MIN_STRENGTH) continue;
        const edgeWeight = edge.isDiachronic ? DIACHRONIC_EDGE_DAMPING : 1.0;
        const s = targetCand.strength * edgeWeight * 0.85;
        hop1Scores.set(
          edge.targetSymbol,
          Math.max(hop1Scores.get(edge.targetSymbol) ?? 0, s),
        );
        graphScores.set(
          edge.targetSymbol,
          Math.max(graphScores.get(edge.targetSymbol) ?? 0, s),
        );
      }

      // Wave 5.2: 时序共现注意力转移边一跳联想（隐式共现补边；先过滤失效/已选中/低强度目标后再取前 3 条有效邻居）
      const transitions = db.listTransitionsFrom(seed.file.frontmatter.id);
      let acceptedTransitions = 0;
      for (const tr of transitions) {
        if (tr.weight < TRANSITION_RECALL_MIN_WEIGHT) break;
        const targetSym = byIdToSymbol.get(tr.to_memory_id);
        if (!targetSym || targetSym === seedKey || seedSymbols.has(targetSym)) {
          continue;
        }
        const targetCand = scoredMap.get(targetSym);
        if (!targetCand || targetCand.strength < HOP1_MIN_STRENGTH) continue;
        const transScore =
          targetCand.strength *
          Math.min(1.0, tr.weight) *
          TRANSITION_RECALL_COEFF;
        graphScores.set(
          targetSym,
          Math.max(graphScores.get(targetSym) ?? 0, transScore),
        );
        acceptedTransitions += 1;
        if (acceptedTransitions >= 3) break;
      }

      // Hop 1 Incoming edges: other active files referencing seed or sharing non-people entity
      for (const [otherKey, otherCand] of scoredMap.entries()) {
        if (otherKey === seedKey || otherCand.strength < HOP1_MIN_STRENGTH) {
          continue;
        }
        const directEdgeToSeed = otherCand.typedEdges.find(
          (e) => e.targetSymbol === seedKey,
        );
        const sharedEntityEdge = otherCand.typedEdges.find(
          (e) =>
            !e.targetSymbol.startsWith("people/") &&
            seed.edges.includes(e.targetSymbol),
        );
        const matchedEdge = directEdgeToSeed ?? sharedEntityEdge;
        if (matchedEdge) {
          const edgeWeight = matchedEdge.isDiachronic
            ? DIACHRONIC_EDGE_DAMPING
            : 1.0;
          const s = otherCand.strength * edgeWeight * 0.85;
          hop1Scores.set(otherKey, Math.max(hop1Scores.get(otherKey) ?? 0, s));
          graphScores.set(
            otherKey,
            Math.max(graphScores.get(otherKey) ?? 0, s),
          );
        }
      }
    }

    // Hop 2 expansion from non-Hub Hop 1 nodes (degree < HUB_DEGREE_THRESHOLD)
    for (const [hop1Key] of hop1Scores.entries()) {
      if (hop1Key.startsWith("people/")) continue;
      const degree = neighborSets.get(hop1Key)?.size ?? 0;
      if (degree >= HUB_DEGREE_THRESHOLD) {
        // Hub avoidance: skip high-degree hub nodes as 2-hop intermediaries
        continue;
      }
      const hop1Cand = scoredMap.get(hop1Key);
      if (!hop1Cand) continue;

      // Hop 2 Outgoing from hop1 -> hop2
      for (const edge of hop1Cand.typedEdges) {
        const hop2Sym = edge.targetSymbol;
        if (seedSymbols.has(hop2Sym) || hop2Sym === hop1Key) continue;
        const hop2Cand = scoredMap.get(hop2Sym);
        if (!hop2Cand || hop2Cand.strength < HOP2_MIN_STRENGTH) continue;
        const edgeWeight = edge.isDiachronic ? DIACHRONIC_EDGE_DAMPING : 1.0;
        const hop2Score = hop2Cand.strength * edgeWeight * 0.55;
        graphScores.set(
          hop2Sym,
          Math.max(graphScores.get(hop2Sym) ?? 0, hop2Score),
        );
      }

      // Hop 2 Incoming to hop1
      for (const [otherKey, otherCand] of scoredMap.entries()) {
        if (
          seedSymbols.has(otherKey) ||
          otherKey === hop1Key ||
          otherCand.strength < HOP2_MIN_STRENGTH
        ) {
          continue;
        }
        const edgeToHop1 = otherCand.typedEdges.find(
          (e) => e.targetSymbol === hop1Key,
        );
        if (edgeToHop1) {
          const edgeWeight = edgeToHop1.isDiachronic
            ? DIACHRONIC_EDGE_DAMPING
            : 1.0;
          const hop2Score = otherCand.strength * edgeWeight * 0.55;
          graphScores.set(
            otherKey,
            Math.max(graphScores.get(otherKey) ?? 0, hop2Score),
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

  // Wave 3.2: 使用三检索通道（sem / kw / graph）加权 RRF 合成检索相关性分 S_rel，并叠加 0.10*time + 0.10*strength 先验
  const useCustomWeights = params.weights !== undefined;
  const rrfScoreMap = computeThreeChannelRrfScores(
    finalCandidates.map((c) => {
      const bucket = selectedBucket.get(c.file.symbolKey)!;
      const gScore =
        graphScores.get(c.file.symbolKey) ??
        (bucket === "bucket_a_mainline" ? 0.35 : 0);
      return {
        key: c.file.symbolKey,
        sem: c.sem,
        kw: c.kw,
        graph: gScore,
      };
    }),
    RRF_DEFAULT_K,
    {
      sem: weights.sem > 0 ? 1.0 : 0,
      kw: weights.kw > 0 ? 1.0 : 0,
      graph: weights.graph > 0 ? 0.8 : 0,
    },
  );

  const ranked: Array<{
    candidate: ScoredCandidate;
    item: RecalledMemoryItem;
  }> = finalCandidates
    .map((c) => {
      const bucket = selectedBucket.get(c.file.symbolKey)!;
      const gScore =
        graphScores.get(c.file.symbolKey) ??
        (bucket === "bucket_a_mainline" ? 0.35 : 0);
      const rrfRel = rrfScoreMap.get(c.file.symbolKey) ?? 0;
      const stanceBoost = c.stanceAnchored ? STANCE_ANCHOR_BOOST : 0;
      const rawTotalScore = useCustomWeights
        ? weights.sem * c.sem +
          weights.kw * c.kw +
          weights.graph * gScore +
          weights.time * c.time +
          weights.strength * c.strength +
          stanceBoost
        : 0.80 * rrfRel + 0.10 * c.time + 0.10 * c.strength + stanceBoost;
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
          ...(c.stanceAnchored ? { stanceAnchored: true } : {}),
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
        const cueText = file.frontmatter.when_to_recall?.trim();
        const searchText = cueText ? `${cueText}\n${file.body}` : file.body;
        let sem: number;
        if (queryEmbedding && meta?.embedding) {
          sem = cosineSimilarity(queryEmbedding, meta.embedding);
        } else {
          const sBody = computeLexicalSemanticSimilarity(query, file.body);
          if (cueText) {
            const sCue = computeLexicalSemanticSimilarity(query, cueText);
            sem = Math.min(1, Math.max(sBody, 0.85 * sCue + 0.15 * sBody));
          } else {
            sem = sBody;
          }
        }
        const kw = computeKeywordScore(query, searchText);
        const hasSpecificTokenHit = queryCjkOrWords.some((t) =>
          searchText.toLowerCase().includes(t),
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
          stanceAnchored: false,
          sessionPenalty: 1.0,
          fingerprint: fp,
          edges: [],
          typedEdges: [],
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
      const timeLabel = formatVagueWhen(ev.timestamp, now);
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
    // 回想只给大概：前台上下文只出现模糊时间，不并列精确日期。
    // 模型不会自己换算时间——上下文里一旦出现精确日期，它就会原样引用，监控感就回来了。
    const timeTag = item.vagueWhen ?? item.date;
    const prefixTag = item.reactivatedFromArchive
      ? `[翻出的旧记忆 · ${timeTag}]`
      : item.stanceAnchored
        ? `[我之前的立场 · ${timeTag}]`
        : `[${timeTag}]`;
    const parts = [`- ${prefixTag} ${item.summary}`];
    if (item.frontstageNarrative) {
      parts.push(
        item.stanceAnchored
          ? `  我当时的看法：${item.frontstageNarrative}`
          : `  我的印象：${item.frontstageNarrative}`,
      );
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
