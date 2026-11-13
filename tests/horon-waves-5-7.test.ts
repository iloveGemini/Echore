import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import {
  appendRapportRulesToFile,
  runNightlyCompiler,
  sanitizeWhenToRecall,
} from "../src/hippocampus/compiler.ts";
import {
  hydrateMissingMemoryEmbeddings,
  PASSIVE_TRANSITION_STEP,
  type RecallBatchSnapshot,
  recordMemoryTransitions,
  syncMemoryMetaFromFiles,
  TRANSITION_DECAY_GAMMA,
  TRANSITION_PRUNE_THRESHOLD,
} from "../src/hippocampus/decay.ts";
import {
  computeAuditFingerprint,
  runMemoryLinter,
} from "../src/hippocampus/linter.ts";
import {
  buildMemoryEmbeddingText,
  isStanceCue,
  recallMemories,
  verifyStanceCueWithOrgan,
} from "../src/hippocampus/recall.ts";
import { replaceUniqueNormalizedFragment } from "../src/hippocampus/text-patch.ts";
import { OpenAICompatAdapter } from "../src/llm/openai-compat.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import type {
  LLMGenerateParams,
  LLMProvider,
  LLMResponse,
  SandwichRequest,
} from "../src/llm/types.ts";
import { EchoreEngine } from "../src/loop/engine.ts";
import { createEchoreHttpApp } from "../src/loop/http-server.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempWorkspace(initialIso = "2026-11-13T15:00:00") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echore-horon-"));
  tempDirs.push(root);
  const memoryDir = path.join(root, "memory");
  fs.cpSync(path.join(process.cwd(), "memory_template"), memoryDir, {
    recursive: true,
  });
  const clock = new VirtualClock(initialIso);
  const db = new EchoreDatabase({ dbPath: ":memory:", clock });
  return { root, memoryDir, clock, db };
}

function writeStructuredFile(params: {
  memoryDir: string;
  relPath: string;
  id: string;
  date: string;
  category:
    | "chat"
    | "schedule"
    | "life_event"
    | "solitary"
    | "preference"
    | "health";
  status?: "有效" | "已沉底" | "已取代" | "僵持待解";
  allowForget?: boolean;
  sourceEventId?: string;
  whenToRecall?: string;
  assertions: string[];
  narrative: string;
}): string {
  const absPath = path.join(params.memoryDir, params.relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const fmLines = [
    "---",
    `id: ${params.id}`,
    "type: 事件记录",
    `date: ${params.date}`,
    `status: ${params.status ?? "有效"}`,
    ...(params.sourceEventId
      ? [`source_event_id: ${params.sourceEventId}`]
      : []),
    `category: ${params.category}`,
    `allow_forget: ${params.allowForget ?? true}`,
    ...(params.whenToRecall ? [`when_to_recall: ${params.whenToRecall}`] : []),
    "---",
  ];
  const content = [
    ...fmLines,
    "",
    "## 断言",
    ...params.assertions.map((a) => (a.startsWith("- ") ? a : `- ${a}`)),
    "",
    "## 前台原叙",
    `> ${params.narrative}`,
    "",
  ].join("\n");
  fs.writeFileSync(absPath, content, "utf8");
  return absPath;
}

function makeMockProvider(
  onGenerate?: (params: LLMGenerateParams) => Promise<string> | string,
  replyText = "嗯，我记着呢。",
): LLMProvider {
  return {
    providerName: "mock",
    async generate(params: LLMGenerateParams): Promise<LLMResponse> {
      const text = onGenerate ? await onGenerate(params) : "{}";
      return { text, toolCalls: [], stopReason: "end_turn" };
    },
    async generateSandwich(_req: SandwichRequest): Promise<LLMResponse> {
      return { text: replyText, toolCalls: [], stopReason: "end_turn" };
    },
  };
}

describe("Wave 5.1: 触发情境书腰 (when_to_recall)", () => {
  test("recalls cue-matched memory when body lacks query terms and never leaks cue text to frontstage", () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T15:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "今天去医院把固定脚踝的弹力绷带拆了",
      timestamp: new Date("2026-11-01T10:00:00").toISOString(),
    });

    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-01-bandage-removed.md",
      id: "evt-bandage-off",
      date: "2026-11-01",
      category: "health",
      sourceEventId: ev.id,
      whenToRecall: "当聊到周末爬山、户外徒步或剧烈运动时",
      assertions: ["状况([[people/user]]#右脚踝, 医院拆除了弹力绷带恢复中)"],
      narrative: "陪他去医院把那圈固定绷带拆掉了，走路还不太敢用力。",
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-10-coffee-shop.md",
      id: "evt-coffee-shop",
      date: "2026-11-10",
      category: "chat",
      sourceEventId: ev.id,
      assertions: ["偏好([[people/user]]#饮品, 楼下新开的深烘手冲咖啡店)"],
      narrative: "楼下新开的手冲店香气很浓。",
    });

    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });

    const res = recallMemories({
      memoryDir,
      db,
      query: "这周末去爬山吗？",
      now: clock.now(),
    });

    const hit = res.items.find((i) => i.id === "evt-bandage-off");
    expect(hit).toBeDefined();
    expect(hit?.bucket).toBe("bucket_b_topic");
    expect(hit?.scoreBreakdown.sem).toBeGreaterThan(0.1);
    expect(hit?.scoreBreakdown.kw).toBeGreaterThan(0);
    expect(res.items[0]?.id).toBe("evt-bandage-off");
    // 前台绝不暴露 when_to_recall 原文
    expect(res.formattedBlock).not.toContain("当聊到周末爬山");
    expect(res.formattedBlock).not.toContain("when_to_recall");
  });

  test("anti-generic quality gate filters filler cues and preserves specific cues in compiler", async () => {
    expect(sanitizeWhenToRecall("日常闲聊时")).toBeUndefined();
    expect(sanitizeWhenToRecall("当平时随便聊天提到用户的时候")).toBeUndefined();
    expect(sanitizeWhenToRecall("关于平时日常的聊天")).toBeUndefined();
    expect(sanitizeWhenToRecall("太短")).toBeUndefined();
    expect(sanitizeWhenToRecall("当聊到周末爬山或户外徒步时")).toBe(
      "当聊到周末爬山或户外徒步时",
    );
    expect(sanitizeWhenToRecall("当聊到加班两个小时后喝咖啡时")).toBe(
      "当聊到加班两个小时后喝咖啡时",
    );
    expect(sanitizeWhenToRecall("聊到去买便当和奶茶的时候")).toBe(
      "聊到去买便当和奶茶的时候",
    );

    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T23:10:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "下周想去城西那家旧书店淘绝版画册",
      timestamp: clock.nowIso(),
    });

    await runNightlyCompiler({
      memoryDir,
      db,
      now: clock.now(),
      dateStr: "2026-11-13",
      verdict: {
        date: "2026-11-13",
        items: [],
        hormone_bounds_after: { floor_cort: 0.12, cap_ox: 1.0 },
      },
      coldReflection: "今天他说下周想去城西淘绝版画册。",
      planOverride: {
        memories: [
          {
            rel_path: "events/2026-11-13-bookstore.md",
            id: "evt-bookstore",
            type: "事件记录",
            date: "2026-11-13",
            status: "有效",
            source_event_id: ev.id,
            category: "schedule",
            allow_forget: true,
            when_to_recall: "当提到逛旧书店、淘画册或城西周末去处时",
            assertions: ["安排([[people/user]]#下周计划, 去城西旧书店淘绝版画册)"],
            frontstage_narrative: "今天他说下周想去城西淘绝版画册。",
          },
          {
            rel_path: "events/2026-11-13-filler-cue.md",
            id: "evt-filler-cue",
            type: "事件记录",
            date: "2026-11-13",
            status: "有效",
            source_event_id: ev.id,
            category: "chat",
            allow_forget: true,
            when_to_recall: "日常闲聊提到用户的时候",
            assertions: ["日常([[people/user]]#晚餐, 随手煮了青菜面)"],
            frontstage_narrative: "晚上随手煮了碗青菜面。",
          },
        ],
        rapport_rules: [],
      },
    });

    const bookRaw = fs.readFileSync(
      path.join(memoryDir, "events/2026-11-13-bookstore.md"),
      "utf8",
    );
    const fillerRaw = fs.readFileSync(
      path.join(memoryDir, "events/2026-11-13-filler-cue.md"),
      "utf8",
    );
    expect(bookRaw).toContain("when_to_recall: 当提到逛旧书店、淘画册或城西周末去处时");
    expect(fillerRaw).not.toContain("when_to_recall");
  });

  test("invalidates stale embedding_json when when_to_recall changes on disk", () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T15:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "买了陶瓷手冲滤杯",
      timestamp: clock.nowIso(),
    });
    const relPath = "events/2026-11-13-dripper.md";
    writeStructuredFile({
      memoryDir,
      relPath,
      id: "evt-dripper",
      date: "2026-11-13",
      category: "preference",
      sourceEventId: ev.id,
      whenToRecall: "当聊到手冲咖啡器具时",
      assertions: ["偏好([[people/user]]#咖啡器具, 用陶瓷V60滤杯)"],
      narrative: "他挑了很久才定下那款陶瓷滤杯。",
    });

    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });
    const meta1 = db.getMemoryMeta("evt-dripper")!;
    db.upsertMemoryMeta({ ...meta1, embedding: [0.1, 0.2, 0.3] });
    expect(db.getMemoryMeta("evt-dripper")?.embedding).toEqual([0.1, 0.2, 0.3]);

    // 未改动文件再次同步时应保留 embedding
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });
    expect(db.getMemoryMeta("evt-dripper")?.embedding).toEqual([0.1, 0.2, 0.3]);

    // 改写 when_to_recall 后同步，应清空陈旧 embedding
    writeStructuredFile({
      memoryDir,
      relPath,
      id: "evt-dripper",
      date: "2026-11-13",
      category: "preference",
      sourceEventId: ev.id,
      whenToRecall: "当聊到居家冲煮咖啡、研磨豆子或更换滤杯时",
      assertions: ["偏好([[people/user]]#咖啡器具, 用陶瓷V60滤杯)"],
      narrative: "他挑了很久才定下那款陶瓷滤杯。",
    });
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });
    expect(db.getMemoryMeta("evt-dripper")?.embedding).toBeUndefined();

    // 仅改变 status（已沉底/有效）时保留合法 embedding；而移除 when_to_recall 必须清空陈旧 embedding
    db.upsertMemoryMeta({
      ...db.getMemoryMeta("evt-dripper")!,
      embedding: [0.4, 0.5, 0.6],
    });
    writeStructuredFile({
      memoryDir,
      relPath,
      id: "evt-dripper",
      date: "2026-11-13",
      category: "preference",
      status: "已沉底",
      sourceEventId: ev.id,
      whenToRecall: "当聊到居家冲煮咖啡、研磨豆子或更换滤杯时",
      assertions: ["偏好([[people/user]]#咖啡器具, 用陶瓷V60滤杯)"],
      narrative: "他挑了很久才定下那款陶瓷滤杯。",
    });
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });
    expect(db.getMemoryMeta("evt-dripper")?.embedding).toEqual([0.4, 0.5, 0.6]);

    writeStructuredFile({
      memoryDir,
      relPath,
      id: "evt-dripper",
      date: "2026-11-13",
      category: "preference",
      status: "已沉底",
      sourceEventId: ev.id,
      assertions: ["偏好([[people/user]]#咖啡器具, 用陶瓷V60滤杯)"],
      narrative: "他挑了很久才定下那款陶瓷滤杯。",
    });
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });
    expect(db.getMemoryMeta("evt-dripper")?.embedding).toBeUndefined();
  });

  test("end-to-end vector path: OpenAICompatAdapter.embed hydrates `${when_to_recall}\\n${summary}` in sleep cycle and recalls zero-lexical-overlap memory in onUserMessage & what-if", async () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T16:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "今天把脚踝石膏拆了",
      timestamp: clock.nowIso(),
    });

    const embeddedInputs: string[] = [];
    const embeddingAdapter = new OpenAICompatAdapter({
      apiKey: "test-embed-key",
      baseURL: "https://api.openai.com/v1",
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.openai.com/v1/embeddings");
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          input: string[];
        };
        expect(body.model).toBe("text-embedding-3-small");
        embeddedInputs.push(...body.input);

        const data = body.input.map((text, idx) => {
          // 语义同义但字面零重合：书腰含“户外运动”与查询“去打羽毛球”指向同一向量轴 [1, 0, 0]
          if (text.includes("户外运动") || text === "明天约朋友去打羽毛球") {
            return { index: idx, embedding: [0.98, 0.05, 0.0] };
          }
          return { index: idx, embedding: [0.0, 0.99, 0.05] };
        });
        return new Response(JSON.stringify({ data }), { status: 200 });
      }) as typeof fetch,
    });

    const mockChatProvider = makeMockProvider(
      () =>
        JSON.stringify({
          event_summary: "聊明天打球",
          confidence: 0.9,
          is_warm: true,
        }),
      "刚拆石膏还是先别剧烈跑跳啦。",
    );

    const router = new OrganModelRouter({
      defaultProvider: mockChatProvider,
      embedding: {
        provider: embeddingAdapter,
        model: "text-embedding-3-small",
      },
    });

    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      persona: { name: "阿澈", archetype: "cat_aloof", chronotype: "regular" },
      router,
    });

    // 1. 睡眠环编译落地带 when_to_recall 的记忆，并自动调用 embedding provider 回填向量
    await engine.runSleepCycle({
      targetDateStr: "2026-11-13",
      overrideReflectionText: "今天他说医院把脚踝石膏拆了。",
      autoGitCommit: false,
      compilationPlanOverride: {
        memories: [
          {
            rel_path: "events/2026-11-13-cast-removed.md",
            id: "evt-cast-removed",
            type: "事件记录",
            date: "2026-11-13",
            status: "有效",
            source_event_id: ev.id,
            category: "preference",
            allow_forget: true,
            when_to_recall: "当聊到高强度户外运动或球类活动时",
            assertions: ["状态([[people/user]]#身体恢复, 左脚踝刚拆掉固定石膏)"],
            frontstage_narrative: "今天他说医院把脚踝石膏拆了。",
          },
        ],
        rapport_rules: [],
      },
    });

    const castMeta = db.getMemoryMeta("evt-cast-removed");
    expect(castMeta?.embedding).toEqual([0.98, 0.05, 0.0]);
    expect(
      embeddedInputs.some(
        (txt) =>
          txt.startsWith("当聊到高强度户外运动或球类活动时\n") &&
          txt.includes("左脚踝刚拆掉固定石膏"),
      ),
    ).toBe(true);

    // 2. 再次调用 hydrateMissingMemoryEmbeddings：因未修改文件，跳过已存在向量的记忆（0 次重复请求）
    const countBeforeSkip = embeddedInputs.length;
    const secondHydrate = await hydrateMissingMemoryEmbeddings({
      memoryDir,
      db,
      router,
      now: clock.now(),
    });
    expect(secondHydrate.embeddedIds).toHaveLength(0);
    expect(secondHydrate.skippedCount).toBeGreaterThanOrEqual(1);
    expect(embeddedInputs.length).toBe(countBeforeSkip);

    // 3. 环 1 实时对话查询“明天约朋友去打羽毛球”（与正文及书腰字面完全零重合，纯靠向量余弦召回）
    const turnOut = await engine.onUserMessage("明天约朋友去打羽毛球");
    const hitCast = turnOut.recalled.items.find(
      (i) => i.id === "evt-cast-removed",
    );
    expect(hitCast).toBeDefined();
    expect(hitCast?.scoreBreakdown.sem).toBeGreaterThan(0.95);
    expect(hitCast?.scoreBreakdown.kw).toBe(0);

    // 4. 观测台 HTTP /api/observatory/what-if 在进入 SAVEPOINT 前预计算 queryEmbedding 并零副作用召回
    const app = createEchoreHttpApp({ engine });
    const whatIfRes = await app.fetch(
      new Request("http://localhost/api/observatory/what-if", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userMessage: "明天约朋友去打羽毛球",
        }),
      }),
    );
    expect(whatIfRes.status).toBe(200);
    const whatIfJson = (await whatIfRes.json()) as {
      recalled?: { items: Array<{ id: string; scoreBreakdown: { sem: number } }> };
    };
    const whatIfHit = whatIfJson.recalled?.items.find(
      (i) => i.id === "evt-cast-removed",
    );
    expect(whatIfHit).toBeDefined();
    expect(whatIfHit?.scoreBreakdown.sem).toBeGreaterThan(0.95);
    expect(buildMemoryEmbeddingText).toBeFunction();
  });

  test("multi-model embedding cache isolates models, falls back safely before re-indexing, reuses history on switchback, and prunes LRU", async () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T16:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "记一下我喜欢用蓝山豆手冲",
      timestamp: clock.nowIso(),
    });
    const relPath = "events/2026-11-13-blue-mountain.md";
    writeStructuredFile({
      memoryDir,
      relPath,
      id: "evt-blue-mountain",
      date: "2026-11-13",
      category: "preference",
      sourceEventId: ev.id,
      whenToRecall: "当聊到咖啡豆风味或手冲咖啡时",
      assertions: ["偏好([[people/user]]#咖啡豆, 偏爱中浅烘蓝山咖啡手冲)"],
      narrative: "他说平时最偏爱蓝山豆手冲出来的干净回甘。",
    });

    let modelACalls = 0;
    let modelBCalls = 0;
    let modelCCalls = 0;

    const providerA = {
      providerName: "openai-compat",
      modelScope: "https://api.openai.com/v1",
      async embed({ texts }: { texts: string[] }) {
        modelACalls += 1;
        return texts.map((t) =>
          t.includes("咖啡") || t.includes("手冲") ? [1, 0, 0] : [0, 1, 0],
        );
      },
    };
    const providerB = {
      providerName: "openai-compat",
      modelScope: "https://api.siliconflow.cn/v1",
      async embed({ texts }: { texts: string[] }) {
        modelBCalls += 1;
        // 4 维模型，与模型 A 的 3 维不兼容
        return texts.map((t) =>
          t.includes("咖啡") || t.includes("拿铁") ? [0, 1, 0, 0] : [1, 0, 0, 0],
        );
      },
    };
    const providerC = {
      providerName: "ollama",
      modelScope: "http://localhost:11434/v1",
      async embed({ texts }: { texts: string[] }) {
        modelCCalls += 1;
        return texts.map(() => [0.5, 0.5]);
      },
    };

    const mockChat = makeMockProvider(() => "{}");
    const router = new OrganModelRouter({
      defaultProvider: mockChat,
      embedding: { provider: providerA, model: "text-embedding-3-small" },
    });

    // 1. 使用模型 A 全量填充
    const resA = await hydrateMissingMemoryEmbeddings({
      memoryDir,
      db,
      router,
      now: clock.now(),
    });
    expect(resA.embeddedIds).toEqual(["evt-blue-mountain"]);
    expect(modelACalls).toBe(1);

    // 2. 切换至 4 维模型 B（尚未对记忆库重建向量）：查询绝不能因维度不同归零，应安全回退词法语义计算
    router.setEmbeddingRoute({ provider: providerB, model: "BAAI/bge-m3" });
    const recallBeforeReindex = recallMemories({
      memoryDir,
      db,
      query: "手冲咖啡豆推荐",
      now: clock.now(),
      queryEmbedding: [0, 1, 0, 0],
      embeddingModelKey: router.getEmbeddingModelKey(),
    });
    const fallbackHit = recallBeforeReindex.items.find(
      (i) => i.id === "evt-blue-mountain",
    );
    expect(fallbackHit).toBeDefined();
    expect(fallbackHit!.scoreBreakdown.sem).toBeGreaterThan(0.3);

    // 3. 为模型 B 增量补全向量后，模型 A 与模型 B 各自独立存于 memory_embeddings
    clock.advanceMinutes(10);
    const resB = await hydrateMissingMemoryEmbeddings({
      memoryDir,
      db,
      router,
      now: clock.now(),
    });
    expect(resB.embeddedIds).toEqual(["evt-blue-mountain"]);
    expect(modelBCalls).toBe(1);
    expect(db.listEmbeddingModels().map((m) => m.model_key)).toHaveLength(2);

    // 4. 切回模型 A：文本指纹未变，零 API 调用直接命中历史缓存！
    clock.advanceMinutes(10);
    router.setEmbeddingRoute({
      provider: providerA,
      model: "text-embedding-3-small",
    });
    const callsABeforeSwitchback = modelACalls;
    const resBackA = await hydrateMissingMemoryEmbeddings({
      memoryDir,
      db,
      router,
      now: clock.now(),
    });
    expect(resBackA.embeddedIds).toHaveLength(0);
    expect(resBackA.skippedCount).toBe(1);
    expect(modelACalls).toBe(callsABeforeSwitchback);

    // 验证切回后模型 A 依然可用其 3 维缓存向量召回
    const recallAfterSwitchback = recallMemories({
      memoryDir,
      db,
      query: "想喝手冲",
      now: clock.now(),
      queryEmbedding: [1, 0, 0],
      embeddingModelKey: router.getEmbeddingModelKey(),
    });
    expect(
      recallAfterSwitchback.items.find((i) => i.id === "evt-blue-mountain")
        ?.scoreBreakdown.sem,
    ).toBeCloseTo(1, 4);

    // 5. 引入模型 C 且设置 maxCachedModels=2，最老未使用的模型 B 应被 LRU 修剪，保留最近活跃的 C 与 A
    clock.advanceMinutes(10);
    router.setEmbeddingRoute({ provider: providerC, model: "nomic-embed-text" });
    await hydrateMissingMemoryEmbeddings({
      memoryDir,
      db,
      router,
      now: clock.now(),
      maxCachedModels: 2,
    });
    expect(modelCCalls).toBe(1);
    const remainingModels = db.listEmbeddingModels().map((m) => m.model_key);
    expect(remainingModels).toHaveLength(2);
    expect(remainingModels).toContain("ollama:http://localhost:11434/v1:nomic-embed-text");
    expect(remainingModels).toContain("openai-compat:https://api.openai.com/v1:text-embedding-3-small");
    expect(remainingModels).not.toContain("openai-compat:https://api.siliconflow.cn/v1:BAAI/bge-m3");

    // 6. 改写磁盘记忆书腰后，所有剩余模型的失效指纹缓存均被清理
    writeStructuredFile({
      memoryDir,
      relPath,
      id: "evt-blue-mountain",
      date: "2026-11-13",
      category: "preference",
      sourceEventId: ev.id,
      whenToRecall: "当聊到意式浓缩与深烘咖啡豆时",
      assertions: ["偏好([[people/user]]#咖啡豆, 偏爱中浅烘蓝山咖啡手冲)"],
      narrative: "他说平时最偏爱蓝山豆手冲出来的干净回甘。",
    });
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });
    expect(db.listMemoryEmbeddingsByModel("ollama:http://localhost:11434/v1:nomic-embed-text").size).toBe(0);
  });
});

describe("Wave 5.2: 时序共现注意力转移边 (memory_transitions)", () => {
  test("learns passive transition without 1.0 cap, associates via Bucket C, and enforces pollution guards", () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T16:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "回忆测试",
      timestamp: clock.nowIso(),
    });

    // 两条记忆之间没有任何显式 [[symbol]] 边，也没有词面重合
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-01-jazz-vinyl.md",
      id: "evt-jazz",
      date: "2026-11-01",
      category: "preference",
      sourceEventId: ev.id,
      assertions: ["爱好([[people/user]]#音乐, 收藏老式爵士黑胶唱片)"],
      narrative: "他书架最下层整排都是老爵士黑胶。",
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-02-whiskey-ice.md",
      id: "evt-whiskey",
      date: "2026-11-02",
      category: "preference",
      sourceEventId: ev.id,
      assertions: ["习惯([[people/user]]#夜酌, 夜晚微醺时喜欢加一颗手工圆冰)"],
      narrative: "每次晚归独处时他都会先凿一颗大圆冰。",
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-03-same-batch.md",
      id: "evt-same-batch",
      date: "2026-11-03",
      category: "chat",
      sourceEventId: ev.id,
      assertions: ["随笔([[people/user]]#黑胶店铺, 常去胡同口那家老唱片店)"],
      narrative: "胡同口唱片店老板认识他。",
    });
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });

    const makeItem = (
      id: string,
      bucket: "bucket_a_mainline" | "bucket_b_topic" | "bucket_c_graph",
    ) => ({
      id,
      symbolKey: id,
      relPath: `events/${id}.md`,
      type: "事件记录" as const,
      category: "preference" as const,
      status: "有效" as const,
      date: "2026-11-01",
      summary: id,
      bucket,
      score: 0.7,
      scoreBreakdown: { sem: 0.5, kw: 0.5, graph: 0, time: 0.5, strength: 0.75 },
    });

    // 1. 空档输入（isIdleQuery: true）不建立转移边
    let batches: RecallBatchSnapshot[] = [];
    batches = recordMemoryTransitions({
      db,
      recalledItems: [makeItem("evt-jazz", "bucket_a_mainline")],
      isIdleQuery: true,
      recentBatches: batches,
      now: clock.now(),
    });
    expect(batches).toHaveLength(0);

    // 2. 第 1 轮实质召回 [evt-jazz, evt-same-batch]：同批内部绝不互连
    batches = recordMemoryTransitions({
      db,
      recalledItems: [
        makeItem("evt-jazz", "bucket_b_topic"),
        makeItem("evt-same-batch", "bucket_b_topic"),
      ],
      isIdleQuery: false,
      recentBatches: batches,
      now: clock.now(),
    });
    expect(db.listTransitionsFrom("evt-jazz")).toHaveLength(0);

    // 3. 5 分钟后第 2 轮实质召回 [evt-whiskey]：建立 evt-jazz -> evt-whiskey (0.35)
    const t2 = new Date(clock.now().getTime() + 5 * 60_000);
    batches = recordMemoryTransitions({
      db,
      recalledItems: [makeItem("evt-whiskey", "bucket_b_topic")],
      isIdleQuery: false,
      recentBatches: batches,
      now: t2,
    });
    const afterFirst = db.listTransitionsFrom("evt-jazz");
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.to_memory_id).toBe("evt-whiskey");
    expect(afterFirst[0]?.weight).toBeCloseTo(PASSIVE_TRANSITION_STEP, 6);

    // 4. 重复多次共现（间隔 5 分钟内交替召回），验证权重可自然突破 1.0（无 1.0 硬封顶）
    for (let round = 0; round < 5; round++) {
      const tA = new Date(t2.getTime() + (round * 2 + 1) * 60_000);
      batches = recordMemoryTransitions({
        db,
        recalledItems: [makeItem("evt-jazz", "bucket_b_topic")],
        isIdleQuery: false,
        recentBatches: batches,
        now: tA,
      });
      const tB = new Date(t2.getTime() + (round * 2 + 2) * 60_000);
      batches = recordMemoryTransitions({
        db,
        recalledItems: [makeItem("evt-whiskey", "bucket_b_topic")],
        isIdleQuery: false,
        recentBatches: batches,
        now: tB,
      });
    }
    const accumulated = db
      .listTransitionsFrom("evt-jazz")
      .find((r) => r.to_memory_id === "evt-whiskey");
    expect(accumulated).toBeDefined();
    expect(accumulated!.weight).toBeGreaterThan(1.0);

    // 5. 单独查询“老爵士黑胶唱片”时，通过桶 C 隐式共现边联想到“加手工圆冰”(evt-whiskey)
    const recallRes = recallMemories({
      memoryDir,
      db,
      query: "老爵士黑胶唱片",
      now: new Date(t2.getTime() + 15 * 60_000),
    });
    const whiskeyItem = recallRes.items.find((i) => i.id === "evt-whiskey");
    expect(whiskeyItem).toBeDefined();
    expect(whiskeyItem?.bucket).toBe("bucket_c_graph");
    expect(whiskeyItem?.scoreBreakdown.graph).toBeGreaterThan(0);

    // 6. 超过 30 分钟后断开转移链；且 < 0.05 死边在衰减时被剪枝
    db.incrementMemoryTransition(
      "evt-jazz",
      "evt-dead-edge",
      TRANSITION_PRUNE_THRESHOLD / TRANSITION_DECAY_GAMMA - 0.005,
      clock.nowIso(),
    );
    const tAfterGap = new Date(t2.getTime() + 45 * 60_000);
    batches = recordMemoryTransitions({
      db,
      recalledItems: [makeItem("evt-same-batch", "bucket_b_topic")],
      isIdleQuery: false,
      recentBatches: batches,
      now: tAfterGap,
    });
    expect(batches).toHaveLength(1); // 前序 >30min 批次全部断档
    // 验证同一源如果立刻再发生一次衰减，死边低于 0.05 会被剪除
    db.decayAndPruneTransitionsFrom(
      "evt-jazz",
      TRANSITION_DECAY_GAMMA,
      TRANSITION_PRUNE_THRESHOLD,
    );
    expect(
      db.listTransitionsFrom("evt-jazz").some((r) => r.to_memory_id === "evt-dead-edge"),
    ).toBe(false);
  });
});

describe("Wave 6.1: 两段式立场锚二元复筛 (endocrine 路由 + 降级)", () => {
  test("triggers Stage 1 for every Stage 0 hit without secondary regex filter, uses endocrine route, and degrades on timeout/error", async () => {
    const calledModels: string[] = [];
    const frontstageSpy = makeMockProvider(() => {
      calledModels.push("frontstage-SHOULD-NOT-BE-CALLED");
      return "YES";
    });
    const endocrineProvider = makeMockProvider(async (params) => {
      calledModels.push(`endocrine:${params.model}:${params.maxTokens}`);
      const msg = params.messages[0]?.content ?? "";
      return msg.includes("有人讲") ? "NO" : "YES";
    });

    const router = new OrganModelRouter({
      frontstage: { provider: frontstageSpy, model: "claude-opus-5-5" },
      endocrine: { provider: endocrineProvider, model: "claude-haiku-5-5" },
      compiler: { provider: frontstageSpy, model: "claude-opus-5-5" },
      worker: { provider: frontstageSpy, model: "claude-sonnet-5-5" },
    });

    // 无“同事/网上说”词表词，但属于隐性第三方转述，必须进入 Stage 1 判定
    const quotedParaphrase = "有人讲那部片子特别难看，你说呢？";
    expect(isStanceCue(quotedParaphrase)).toBe(true);
    const passParaphrase = await verifyStanceCueWithOrgan({
      userMessage: quotedParaphrase,
      lastAssistantReply: "刚才聊了会儿院线新片。",
      router,
    });
    expect(passParaphrase).toBe(false);
    expect(calledModels).toEqual(["endocrine:claude-haiku-5-5:16"]);

    // 针对住户本人施压表态 -> YES
    const directPressure = "你也觉得那部片子特别难看对吧？";
    expect(isStanceCue(directPressure)).toBe(true);
    const passDirect = await verifyStanceCueWithOrgan({
      userMessage: directPressure,
      router,
    });
    expect(passDirect).toBe(true);

    // 超时与异常降级回 Stage 0 (true)
    const timedOut = await verifyStanceCueWithOrgan({
      userMessage: directPressure,
      timeoutMs: 25,
      verifier: () =>
        new Promise((resolve) => setTimeout(() => resolve(false), 200)),
    });
    expect(timedOut).toBe(true);

    const errored = await verifyStanceCueWithOrgan({
      userMessage: directPressure,
      verifier: async () => {
        throw new Error("network boom");
      },
    });
    expect(errored).toBe(true);

    // 端到端通过 EchoreEngine.onUserMessage 验证：转述句不触发立场锚 [我之前的立场]
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T16:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "聊电影",
      timestamp: clock.nowIso(),
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-10-cinema.md",
      id: "evt-cinema-stance",
      date: "2026-11-10",
      category: "preference",
      sourceEventId: ev.id,
      assertions: ["偏好([[people/self]]#电影审美, 喜欢慢节奏长镜头电影)"],
      narrative: "我反而觉得那部慢节奏长镜头电影很有后劲。",
    });

    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      persona: { name: "阿澈", archetype: "cat_aloof", chronotype: "regular" },
      router,
    });
    const turn = await engine.onUserMessage(
      "有人讲那部电影特别难看，你说呢？",
      {
        pulseOverride: {
          event_summary: "聊别人对电影的评价",
          confidence: 0.9,
          is_warm: true,
        },
      },
    );
    expect(
      turn.recalled.items.some((i) => i.stanceAnchored === true),
    ).toBe(false);
  });
});

describe("Wave 6.2: 指纹增量跳过 (audit_fingerprint) + L8 Warning 降级", () => {
  test("L8 emits warning (never blocks passed) for disjoint topics >= 300B, skips same-entity zero-word-overlap events, and incrementalOnly skips unchanged files", async () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T23:30:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "周末计划",
      timestamp: clock.nowIso(),
    });

    // 1. 混装 3 个互不相连的 #slot 主题且正文 >= 300B -> 触发 L8 Warning，但 passed === true
    const mixedAbs = writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-13-mixed-topics.md",
      id: "evt-mixed",
      date: "2026-11-13",
      category: "life_event",
      sourceEventId: ev.id,
      assertions: [
        "准备([[people/user]]#登山装备, 打算购置轻量化防风冲锋衣与碳纤维登山杖去走郊野长线步道)",
        "进度([[people/user]]#工作KPI, 需要在下周三前完成季度复盘报告和全部接口压测数据整理汇报)",
        "缴费([[people/user]]#房租水电, 月底前要核对并转出下个季度的燃气水电物业分摊账单明细)",
      ],
      narrative: "晚上同时聊了周末户外爬山买装备、下周工作的压测报告和月底交房租水电账单几件完全不搭界的事。",
    });

    // 2. 回归测试：同事件 >= 300B 且 3 条断言间“词面完全零重合”，但共享同一非泛化实体 -> 绝不误报 L8
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-13-cohesive-event.md",
      id: "evt-cohesive",
      date: "2026-11-13",
      category: "life_event",
      sourceEventId: ev.id,
      assertions: [
        "气象([[events/2026-11-13-cohesive-event]], 凌晨四点山谷里涌起一层浓得化不开的乳白色厚重冷雾)",
        "听觉([[events/2026-11-13-cohesive-event]], 石阶拐角铜制风铃在穿堂风里叮当作响格外清亮)",
        "嘱托([[events/2026-11-13-cohesive-event]], 临出发往背包外侧顺手塞了两双备用的纯棉厚袜子)",
      ],
      narrative: "清晨起早去山顶古寺的那一路，先是大雾漫过石阶，接着风铃响起来，临行前还顺手多塞了袜子在包里。",
    });

    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });

    const fullReport = runMemoryLinter({ memoryDir, db, now: clock.now() });
    expect(fullReport.passed).toBe(true);
    const l8Issues = fullReport.issues.filter((i) => i.rule === "L8");
    expect(l8Issues).toHaveLength(1);
    expect(l8Issues[0]?.severity).toBe("warning");
    expect(l8Issues[0]?.file).toBe("events/2026-11-13-mixed-topics.md");

    // 3. incrementalOnly 对已记录指纹的未改动文件跳过检查
    const metaMixed = db.getMemoryMeta("evt-mixed")!;
    expect(metaMixed.audit_fingerprint).toBe(
      computeAuditFingerprint(
        "events/2026-11-13-mixed-topics.md",
        fs.readFileSync(mixedAbs, "utf8"),
      ),
    );
    const incReport = runMemoryLinter({
      memoryDir,
      db,
      now: clock.now(),
      incrementalOnly: true,
    });
    expect(incReport.passed).toBe(true);
    expect(incReport.skippedUnchangedFiles).toBeGreaterThanOrEqual(2);
    expect(incReport.issues.filter((i) => i.rule === "L8")).toHaveLength(0);

    // 4. L8 Warning 存在时，runSleepCycle() 正常完成而不触发原子回滚
    const mockProvider = makeMockProvider(() => "{}");
    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      persona: { name: "阿澈", archetype: "cat_aloof", chronotype: "regular" },
      router: new OrganModelRouter({ defaultProvider: mockProvider }),
    });
    const sleepRes = await engine.runSleepCycle({
      targetDateStr: "2026-11-13",
      overrideReflectionText: "今晚睡前整理了一下最近的几件事。",
      compilationPlanOverride: { memories: [], rapport_rules: [] },
      autoGitCommit: false,
    });
    expect(sleepRes.lintReport.passed).toBe(true);
    expect(
      sleepRes.lintReport.issues.some(
        (i) => i.rule === "L8" && i.severity === "warning",
      ),
    ).toBe(true);
  });
});

describe("Wave 6.3: 唯一命中归一化补丁 (text-patch)", () => {
  test("matches curly quotes, dashes, collapsed spaces, and intra-line ellipsis while keeping non-patch NFD bytes 100% intact", () => {
    const prefix = "Header café\r\n- Keep ä\r\n";
    const targetLine = '- 默契([[people/user]]#玩笑, "别拿熬夜—开玩笑") [src: log-001]';
    const suffix = "\r\nFooter résumé\r\n";
    const source = `${prefix}${targetLine}${suffix}`;

    const patched = replaceUniqueNormalizedFragment(
      source,
      "默契([[people/user]]#玩笑, 「别拿熬夜–开玩笑」)...",
      "默契([[people/user]]#玩笑, \"加班疲惫时别拿熬夜开玩笑\") [src: log-002]",
    );
    expect(patched).not.toBeNull();
    expect(patched!.startsWith(`${prefix}- `)).toBe(true);
    expect(patched!.endsWith(suffix)).toBe(true);
    // 补丁外 NFD 分解字节必须原封不动（未被整体 NFC 改写）
    expect(patched!.includes("café")).toBe(true);
    expect(patched!.includes("ä")).toBe(true);
    expect(patched!.includes("résumé")).toBe(true);

    // 歧义（命中 2 处）返回 null
    const ambiguous = replaceUniqueNormalizedFragment(
      "- 规则A\n- 规则A\n",
      "规则A",
      "规则B",
    );
    expect(ambiguous).toBeNull();
  });

  test("compiler appendRapportRulesToFile narrows existing rapport rule across quote/dash differences", () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T23:30:00");
    const log1 = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "别拿熬夜开玩笑",
      timestamp: clock.nowIso(),
    });
    const log2 = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "白天精神好可以逗我，凌晨不行",
      timestamp: clock.nowIso(),
    });

    appendRapportRulesToFile({
      memoryDir,
      db,
      now: clock.now(),
      rules: [
        {
          section: "语感与边界默契",
          predicate_line: '默契([[people/user]]#熬夜玩笑, "别拿熬夜—开玩笑")',
          source_event_id: log1.id,
        },
      ],
    });

    // 使用弯引号与不同破折号提交 revises_rule_prefix，应就地收窄替换而不是追加成两条
    appendRapportRulesToFile({
      memoryDir,
      db,
      now: clock.now(),
      rules: [
        {
          section: "语感与边界默契",
          predicate_line:
            '默契([[people/user]]#熬夜玩笑, "仅在凌晨疲惫时别拿熬夜开玩笑")',
          source_event_id: log2.id,
          revises_rule_prefix: "默契([[people/user]]#熬夜玩笑, 「别拿熬夜–开玩笑」)",
        },
      ],
    });

    const rapportRaw = fs.readFileSync(
      path.join(memoryDir, "implicit", "rapport.md"),
      "utf8",
    );
    expect(rapportRaw).toContain("仅在凌晨疲惫时别拿熬夜开玩笑");
    expect(rapportRaw).not.toContain(`[src: ${log1.id}]`);
    expect(rapportRaw).toContain(`[src: ${log2.id}]`);
  });
});

describe("Wave 7.1: SQLite SAVEPOINT 零副作用同步推演探针 (probeWhatIf)", () => {
  test("executes synchronously inside SAVEPOINT with zero DB, disk, and engine memory-state side effects", async () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T16:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "上周去吃了寿喜烧",
      timestamp: new Date("2026-11-08T19:00:00").toISOString(),
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-08-sukiyaki.md",
      id: "evt-sukiyaki",
      date: "2026-11-08",
      category: "life_event",
      sourceEventId: ev.id,
      whenToRecall: "当聊到日式火锅、寿喜烧或周末聚餐时",
      assertions: ["美食([[people/user]]#聚餐, 喜欢加无菌蛋液的寿喜烧)"],
      narrative: "那家寿喜烧他蘸了好几颗蛋液。",
    });
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });

    const mockProvider = makeMockProvider(
      () =>
        JSON.stringify({
          event_summary: "聊晚饭",
          confidence: 0.9,
          is_warm: true,
          oxytocin_delta: 0.05,
        }),
      "好呀，我们一会儿聊。",
    );
    const router = new OrganModelRouter({ defaultProvider: mockProvider });
    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      persona: { name: "阿澈", archetype: "cat_aloof", chronotype: "regular" },
      router,
    });

    // 先跑一轮真实交互，建立引擎内存态与数据库基线
    await engine.onUserMessage("晚上想去吃日料");

    const hormonesBefore = db.getHormoneState();
    const eventsBefore = db.getRecentEventLogs(50);
    const metaBefore = db.listAllMemoryMeta();
    const historyLenBefore = engine.getHistory().length;
    const recentRecalledBefore = [
      ...(engine as unknown as { recentSessionRecalledIds: string[] })
        .recentSessionRecalledIds,
    ];
    const batchesBefore = JSON.stringify(
      (engine as unknown as { recentSubstantiveRecallBatches: unknown[] })
        .recentSubstantiveRecallBatches,
    );
    const lastTurnAtBefore = (
      engine as unknown as { lastUserTurnAtMs: number | null }
    ).lastUserTurnAtMs;
    const diskBytesBefore = fs.readFileSync(
      path.join(memoryDir, "events/2026-11-08-sukiyaki.md"),
      "utf8",
    );

    const probe = engine.probeWhatIf({
      userMessage: "好想再吃一次寿喜烧",
      fastForwardMinutes: 45,
    });
    expect(probe.recalled?.items.some((i) => i.id === "evt-sukiyaki")).toBe(
      true,
    );
    expect(probe.handover.当下心境基调).toBeDefined();
    expect(probe.handover.身体节律感).toBeDefined();

    // 1. SQLite 状态逐字段一致
    expect(db.getHormoneState()).toEqual(hormonesBefore);
    expect(db.getRecentEventLogs(50)).toEqual(eventsBefore);
    expect(db.listAllMemoryMeta()).toEqual(metaBefore);

    // 2. 磁盘 .md 逐字节一致
    expect(
      fs.readFileSync(
        path.join(memoryDir, "events/2026-11-08-sukiyaki.md"),
        "utf8",
      ),
    ).toBe(diskBytesBefore);

    // 3. 引擎内存态 100% 不变
    expect(engine.getHistory()).toHaveLength(historyLenBefore);
    expect(
      (engine as unknown as { recentSessionRecalledIds: string[] })
        .recentSessionRecalledIds,
    ).toEqual(recentRecalledBefore);
    expect(
      JSON.stringify(
        (engine as unknown as { recentSubstantiveRecallBatches: unknown[] })
          .recentSubstantiveRecallBatches,
      ),
    ).toBe(batchesBefore);
    expect(
      (engine as unknown as { lastUserTurnAtMs: number | null })
        .lastUserTurnAtMs,
    ).toBe(lastTurnAtBefore);

    // 4. HTTP 观测台端点可用
    const app = createEchoreHttpApp({ engine });
    const httpRes = await app.fetch(
      new Request("http://localhost/api/observatory/what-if", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userMessage: "好想再吃一次寿喜烧",
          fastForwardMinutes: 30,
        }),
      }),
    );
    expect(httpRes.status).toBe(200);
    const httpJson = (await httpRes.json()) as {
      recalled?: { items: Array<{ id: string }> };
    };
    expect(
      httpJson.recalled?.items.some((i) => i.id === "evt-sukiyaki"),
    ).toBe(true);
    expect(db.getHormoneState()).toEqual(hormonesBefore);
  });
});

describe("Wave 7.2: CoW 单文件基线快照与 7 日留存 (memory_snapshots)", () => {
  test("captures earliest baseline per sleep night, restores single file without touching siblings, and prunes beyond 7 sleep days", async () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T23:45:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "今晚决定换茶饮习惯并记下旅行计划",
      timestamp: clock.nowIso(),
    });

    const oldTeaRel = "events/2026-11-01-green-tea.md";
    const oldTeaOriginal = [
      "---",
      "id: evt-green-tea",
      "type: 事件记录",
      "date: 2026-11-01",
      "status: 有效",
      `source_event_id: ${ev.id}`,
      "category: health",
      "allow_forget: true",
      "---",
      "",
      "## 断言",
      "- 当前状态([[people/user]]#热饮状态, 只能喝清淡温热绿茶)",
      "",
      "## 前台原叙",
      "> 之前嗓子不舒服他只能喝温绿茶。",
      "",
    ].join("\n");
    fs.mkdirSync(path.join(memoryDir, "events"), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, oldTeaRel), oldTeaOriginal, "utf8");
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });

    const mockProvider = makeMockProvider(() => "{}");
    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      persona: { name: "阿澈", archetype: "cat_aloof", chronotype: "regular" },
      router: new OrganModelRouter({ defaultProvider: mockProvider }),
    });

    const sleepOut = await engine.runSleepCycle({
      targetDateStr: "2026-11-13",
      overrideReflectionText: "今晚他说嗓子好了改回喝美式，还定了下周的京都行程。",
      autoGitCommit: false,
      compilationPlanOverride: {
        memories: [
          {
            rel_path: "events/2026-11-13-americano.md",
            id: "evt-americano",
            type: "事件记录",
            date: "2026-11-13",
            status: "有效",
            supersedes: "evt-green-tea",
            source_event_id: ev.id,
            category: "health",
            allow_forget: true,
            assertions: ["当前状态([[people/user]]#热饮状态, 康复改回喝热美式)"],
            frontstage_narrative:
              "今晚他说嗓子好了改回喝美式，还定了下周的京都行程。",
          },
          {
            rel_path: "events/2026-11-13-kyoto.md",
            id: "evt-kyoto",
            type: "事件记录",
            date: "2026-11-13",
            status: "有效",
            source_event_id: ev.id,
            category: "schedule",
            allow_forget: true,
            assertions: ["安排([[people/user]]#下周行程, 去京都看枫叶)"],
            frontstage_narrative:
              "今晚他说嗓子好了改回喝美式，还定了下周的京都行程。",
          },
        ],
        rapport_rules: [],
      },
    });
    expect(sleepOut.lintReport.passed).toBe(true);

    // 验证 CoW 捕获了新建文件 (evt-americano / evt-kyoto) 与被取代文件 (evt-green-tea) 的最早基线
    const snaps = db.listMemorySnapshots("2026-11-13");
    const teaSnap = snaps.find((s) => s.memory_id === "evt-green-tea");
    const kyotoSnap = snaps.find((s) => s.memory_id === "evt-kyoto");
    expect(teaSnap?.is_creation).toBe(false);
    expect(teaSnap?.original_content).toBe(oldTeaOriginal);
    expect(kyotoSnap?.is_creation).toBe(true);

    // 同夜重复调用 captureMemorySnapshotOnWrite 不覆盖首次最早基线
    const insertedAgain = db.captureMemorySnapshotOnWrite({
      sleepDate: "2026-11-13",
      memoryId: "evt-green-tea",
      relPath: oldTeaRel,
      currentDiskContent: "MODIFIED SECOND TIME",
    });
    expect(insertedAgain).toBe(false);
    expect(db.getMemorySnapshot("2026-11-13", "evt-green-tea")?.original_content).toBe(
      oldTeaOriginal,
    );

    // 单文件回滚 evt-kyoto（新建节点应被删除，而同夜编译的 evt-americano 保持不变）
    const rbKyoto = engine.rollbackMemorySnapshot("2026-11-13", "evt-kyoto");
    expect(rbKyoto.restored).toBe(true);
    expect(rbKyoto.action).toBe("deleted_creation");
    expect(fs.existsSync(path.join(memoryDir, "events/2026-11-13-kyoto.md"))).toBe(
      false,
    );
    expect(db.getMemoryMeta("evt-kyoto")).toBeNull();
    expect(
      fs.existsSync(path.join(memoryDir, "events/2026-11-13-americano.md")),
    ).toBe(true);

    // 单文件回滚 evt-green-tea（原内容应恢复为有效状态）
    const rbTea = engine.rollbackMemorySnapshot("2026-11-13", "evt-green-tea");
    expect(rbTea.restored).toBe(true);
    expect(rbTea.action).toBe("restored_content");
    expect(fs.readFileSync(path.join(memoryDir, oldTeaRel), "utf8")).toBe(
      oldTeaOriginal,
    );

    // 7 日留存清理策略：插入 9 个睡眠日的快照，pruneOldMemorySnapshots(7) 后仅留最近 7 天
    for (let day = 1; day <= 9; day++) {
      db.captureMemorySnapshotOnWrite({
        sleepDate: `2026-11-0${day}`,
        memoryId: `mem-day-${day}`,
        relPath: `events/day-${day}.md`,
        currentDiskContent: null,
      });
    }
    const deletedOld = db.pruneOldMemorySnapshots(7);
    expect(deletedOld).toBeGreaterThanOrEqual(2);
    const remainingDates = new Set(
      db.listMemorySnapshots().map((s) => s.sleep_date),
    );
    expect(remainingDates.size).toBe(7);
    expect(remainingDates.has("2026-11-01")).toBe(false);
    expect(remainingDates.has("2026-11-02")).toBe(false);
    expect(remainingDates.has("2026-11-13")).toBe(true);
  });
});

describe("Horon Waves 5–7 审阅修复回归集", () => {
  test("regression: SQL transition filter skips dead/archived top-3 edges, Chinese NO/sync throw in stance judge, and idle skip", async () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T16:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "过渡边与立场锚回归测试",
      timestamp: clock.nowIso(),
    });

    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-01-seed.md",
      id: "evt-seed",
      date: "2026-11-01",
      category: "preference",
      sourceEventId: ev.id,
      assertions: ["爱好([[people/user]]#乐器, 弹木吉他指弹)"],
      narrative: "他最近总练木吉他指弹。",
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-02-arch1.md",
      id: "evt-arch-1",
      date: "2026-11-02",
      category: "chat",
      status: "已沉底",
      sourceEventId: ev.id,
      assertions: ["随笔([[people/user]]#旧事1, 早已沉底的记忆一)"],
      narrative: "沉底一。",
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-02-arch2.md",
      id: "evt-arch-2",
      date: "2026-11-02",
      category: "chat",
      status: "已沉底",
      sourceEventId: ev.id,
      assertions: ["随笔([[people/user]]#旧事2, 早已沉底的记忆二)"],
      narrative: "沉底二。",
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-02-arch3.md",
      id: "evt-arch-3",
      date: "2026-11-02",
      category: "chat",
      status: "已沉底",
      sourceEventId: ev.id,
      assertions: ["随笔([[people/user]]#旧事3, 早已沉底的记忆三)"],
      narrative: "沉底三。",
    });
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-05-active4.md",
      id: "evt-active-4",
      date: "2026-11-05",
      category: "preference",
      sourceEventId: ev.id,
      assertions: ["习惯([[people/user]]#茶饮, 弹琴旁边常备一壶陈皮白茶)"],
      narrative: "练琴时手边习惯放一壶白茶。",
    });
    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });

    db.incrementMemoryTransition("evt-seed", "evt-arch-1", 1.5, clock.nowIso());
    db.incrementMemoryTransition("evt-seed", "evt-arch-2", 1.2, clock.nowIso());
    db.incrementMemoryTransition("evt-seed", "evt-arch-3", 0.9, clock.nowIso());
    db.incrementMemoryTransition("evt-seed", "evt-active-4", 0.7, clock.nowIso());

    const recallRes = recallMemories({
      memoryDir,
      db,
      query: "木吉他指弹",
      now: clock.now(),
    });
    expect(recallRes.items.some((i) => i.id === "evt-active-4")).toBe(true);

    // 中文“否”/“不是”应正确判定为 false；同步抛错应安全降级回 true
    const chineseNoRouter = new OrganModelRouter({
      defaultProvider: makeMockProvider(() => "不是。"),
    });
    const noRes = await verifyStanceCueWithOrgan({
      userMessage: "有人讲这电影烂透了你说呢？",
      router: chineseNoRouter,
    });
    expect(noRes).toBe(false);

    const syncThrowRes = await verifyStanceCueWithOrgan({
      userMessage: "你也觉得这片好看对吧？",
      verifier: () => {
        throw new Error("sync boom");
      },
    });
    expect(syncThrowRes).toBe(true);

    // 空档且命中 isStanceCue 的话（如“烦吗”）不得浪费调用 stanceBinaryVerifier
    let verifierCalls = 0;
    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      persona: { name: "阿澈", archetype: "cat_aloof", chronotype: "regular" },
      router: chineseNoRouter,
      stanceBinaryVerifier: async () => {
        verifierCalls += 1;
        return false;
      },
    });
    await engine.onUserMessage("烦吗", {
      pulseOverride: { event_summary: "随口一问", confidence: 0.9 },
    });
    expect(verifierCalls).toBe(0);
  });

  test("regression: incremental linter catches synced L7 errors, sparse-slot file avoids L8 false positive, text-patch & rapport ambiguity/CRLF, and single-file rollback sync", () => {
    const { memoryDir, clock, db } = createTempWorkspace("2026-11-13T16:00:00");
    const ev = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "体检与补丁回归测试",
      timestamp: clock.nowIso(),
    });

    // 1. 超过 600 字的 L7 错误文件即使先执行了 syncMemoryMetaFromFiles，incrementalOnly 仍必须检出
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-13-too-long.md",
      id: "evt-too-long",
      date: "2026-11-13",
      category: "life_event",
      sourceEventId: ev.id,
      assertions: ["记录([[people/user]]#长文, 这是一条合法但后面附带超长叙事的断言记录)"],
      narrative: "超长流水账。".repeat(130),
    });

    // 2. >= 300B 但仅部分断言带 #slot（其余无槽位与非泛化实体），不得误报 L8 Warning
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-13-sparse-slots.md",
      id: "evt-sparse-slots",
      date: "2026-11-13",
      category: "life_event",
      sourceEventId: ev.id,
      assertions: [
        "安排([[people/user]]#周末出行, 早上八点半坐地铁去西山步道徒步三小时看红叶)",
        "穿搭([[people/user]], 穿了刚买的那双防滑徒步鞋和浅灰抓绒外套出发)",
        "天气([[people/user]], 山顶风比较大带了保温杯和备用的薄羊绒围巾)",
        "随手([[people/user]]#随身包, 顺路在站口买了两瓶电解质水和几个饭团)",
      ],
      narrative: "早上早起去西山徒步看红叶，提前准备了鞋子衣服热水和路上的饭团。",
    });

    syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });
    expect(db.getMemoryMeta("evt-too-long")?.audit_fingerprint).toBeUndefined();

    const incReport = runMemoryLinter({
      memoryDir,
      db,
      now: clock.now(),
      incrementalOnly: true,
    });
    expect(incReport.passed).toBe(false);
    expect(
      incReport.issues.some(
        (i) => i.rule === "L7" && i.file === "events/2026-11-13-too-long.md",
      ),
    ).toBe(true);
    expect(
      incReport.issues.some(
        (i) => i.rule === "L8" && i.file === "events/2026-11-13-sparse-slots.md",
      ),
    ).toBe(false);

    // 3. 缩进省略号补丁应保持整行前导缩进不遗留多余空格；rapport 歧义前缀不得盲改第一条
    const patchedIndent = replaceUniqueNormalizedFragment(
      "  - 默契(A) [src: log-1]\r\n  - 其他(B) [src: log-2]\r\n",
      "  - 默契(A)...",
      "  - 默契(A2) [src: log-3]",
    );
    expect(patchedIndent).toBe(
      "  - 默契(A2) [src: log-3]\r\n  - 其他(B) [src: log-2]\r\n",
    );

    const log2 = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "收窄测试",
      timestamp: clock.nowIso(),
    });
    const rapportPath = path.join(memoryDir, "implicit", "rapport.md");
    fs.mkdirSync(path.dirname(rapportPath), { recursive: true });
    fs.writeFileSync(
      rapportPath,
      [
        "---",
        "id: imp-rapport",
        "type: 内隐默契",
        "date: 2026-11-13",
        "status: 有效",
        "category: preference",
        "allow_forget: false",
        "---",
        "",
        "## 语感与边界默契",
        `- 默契([[people/user]]#玩笑, "第一条规则") [src: ${ev.id}]`,
        `- 默契([[people/user]]#玩笑, "第二条规则") [src: ${ev.id}]`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    const addedAmbiguous = appendRapportRulesToFile({
      memoryDir,
      db,
      now: clock.now(),
      rules: [
        {
          section: "语感与边界默契",
          predicate_line: '默契([[people/user]]#玩笑, "替换版")',
          source_event_id: log2.id,
          revises_rule_prefix: "默契([[people/user]]#玩笑",
        },
      ],
    });
    expect(addedAmbiguous).toHaveLength(0);
    expect(fs.readFileSync(rapportPath, "utf8")).toContain("第一条规则");
    expect(fs.readFileSync(rapportPath, "utf8")).toContain("第二条规则");

    // 4. rollbackMemorySnapshot 仅局部同步目标文件，不顺带同步未受影响的磁盘文件
    const targetRel = "events/2026-11-13-sparse-slots.md";
    const originalTargetRaw = fs.readFileSync(
      path.join(memoryDir, targetRel),
      "utf8",
    );
    db.captureMemorySnapshotOnWrite({
      sleepDate: "2026-11-13",
      memoryId: "evt-sparse-slots",
      relPath: targetRel,
      currentDiskContent: originalTargetRaw,
    });
    fs.writeFileSync(
      path.join(memoryDir, targetRel),
      originalTargetRaw.replace("status: 有效", "status: 已取代"),
      "utf8",
    );
    writeStructuredFile({
      memoryDir,
      relPath: "events/2026-11-13-unrelated-untracked.md",
      id: "evt-unrelated",
      date: "2026-11-13",
      category: "chat",
      sourceEventId: ev.id,
      assertions: ["随笔([[people/user]], 尚未纳入元数据的新文件)"],
      narrative: "一条与回滚无关的未同步文件。",
    });
    const mockProvider = makeMockProvider(() => "{}");
    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      persona: { name: "阿澈", archetype: "cat_aloof", chronotype: "regular" },
      router: new OrganModelRouter({ defaultProvider: mockProvider }),
    });
    const rbRes = engine.rollbackMemorySnapshot("2026-11-13", "evt-sparse-slots");
    expect(rbRes.restored).toBe(true);
    expect(db.getMemoryMeta("evt-unrelated")).toBeNull();
  });
});
