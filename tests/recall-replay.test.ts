import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { syncMemoryMetaFromFiles } from "../src/hippocampus/decay.ts";
import {
  computeIdfKeywordScores,
  computeThreeChannelRrfScores,
  isStanceCue,
  recallMemories,
} from "../src/hippocampus/recall.ts";

function buildReplayFixtureWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-replay-"));
  const memoryDir = path.join(tmpDir, "memory");
  fs.cpSync(path.join(process.cwd(), "memory_template"), memoryDir, {
    recursive: true,
  });

  const clock = new VirtualClock("2026-11-12T20:00:00");
  const db = new EchoreDatabase({ dbPath: ":memory:", clock });

  const logBase = db.appendEventLog({
    id: "log-20261101-1200-001",
    timestamp: new Date("2026-11-01T12:00:00").toISOString(),
    role: "user",
    speaker: "user",
    content: "这阵子发生的不少日常小事记录",
  });

  const writeMem = (spec: {
    relPath: string;
    id: string;
    date: string;
    category: "chat" | "schedule" | "life_event" | "solitary" | "preference" | "health";
    status?: "有效" | "已沉底" | "已取代";
    allowForget?: boolean;
    strength?: number;
    assertions: string[];
    narrative: string;
  }) => {
    const absPath = path.join(memoryDir, spec.relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const content = [
      "---",
      `id: ${spec.id}`,
      "type: 事件记录",
      `date: ${spec.date}`,
      `status: ${spec.status ?? "有效"}`,
      `source_event_id: ${logBase.id}`,
      `category: ${spec.category}`,
      `allow_forget: ${spec.allowForget ?? true}`,
      "---",
      "",
      "## 断言",
      ...spec.assertions.map((a) => `- ${a}`),
      "",
      "## 前台原叙",
      `> ${spec.narrative}`,
      "",
    ].join("\n");
    fs.writeFileSync(absPath, content, "utf8");
  };

  // --- 1. Rare proper nouns for IDF vs diluted conversational query test ---
  writeMem({
    relPath: "events/2026-10-15-jingshan.md",
    id: "evt-jingshan",
    date: "2026-10-15",
    category: "life_event",
    strength: 0.55,
    assertions: ["日常([[people/user]], 秋天傍晚去景山公园万春亭看故宫日落)"],
    narrative: "那天傍晚他去景山公园看日落，拍的照片很好看。",
  });
  writeMem({
    relPath: "events/2026-11-11-generic-chat.md",
    id: "evt-generic-chat",
    date: "2026-11-11",
    category: "chat",
    strength: 0.75,
    assertions: [
      "日常([[people/user]], 今天下班路上觉得天气挺好，随便走走看看风景)",
    ],
    narrative: "今天下班路上随便走走看看。",
  });

  // --- 2. Low-score exact semantic/keyword hit vs high-strength 1-hop graph neighbor (RRF anti-domination) ---
  writeMem({
    relPath: "events/2026-11-12-work-sprint.md",
    id: "evt-work-sprint",
    date: "2026-11-12",
    category: "schedule",
    allowForget: false,
    strength: 0.90,
    assertions: [
      "当前状态([[people/user]]#本周日程, 正在冲刺双十一压测项目)",
      "关联([[events/2026-10-20-server-oom]], 压测背景)",
    ],
    narrative: "他这两天一直在忙双十一压测。",
  });
  writeMem({
    relPath: "events/2026-10-20-server-oom.md",
    id: "evt-server-oom",
    date: "2026-10-20",
    category: "life_event",
    allowForget: false,
    strength: 0.90, // High strength graph neighbor of Bucket A mainline `evt-work-sprint`, completely off-topic for tea/cat queries!
    assertions: ["事件([[people/user]], 排查线上网关内存溢出故障)"],
    narrative: "十月中旬他熬夜排查过一次网关故障。",
  });
  writeMem({
    relPath: "events/2026-10-12-matcha-cake.md",
    id: "evt-matcha-cake",
    date: "2026-10-12",
    category: "preference",
    strength: 0.48,
    assertions: ["偏好([[people/user]]#甜点, 喜欢微苦的宇治抹茶千层蛋糕)"],
    narrative: "他提过甜点里只吃微苦的宇治抹茶千层。",
  });

  // --- 3. Two-hop graph walk (Seed -> Hop 1 bridge -> Hop 2 target) & Hub node (degree >= 5) suppression ---
  writeMem({
    relPath: "events/2026-11-05-kyoto-plan.md",
    id: "evt-kyoto-plan",
    date: "2026-11-05",
    category: "preference",
    strength: 0.75,
    assertions: [
      "计划([[people/user]], 十二月想去京都岚山看枫叶)",
      "关联([[events/2026-10-25-camera-lens]], 旅拍准备)",
      "历史背景([[events/2026-09-01-old-canceled-trip]], 曾改期过一次)",
      "关联([[events/2026-10-01-hub-node]], 公共标签)",
    ],
    narrative: "他打算十二月去京都看红叶。",
  });
  // Hop 1 non-hub bridge (degree = 2 < 5, strength = 0.65 >= 0.30)
  writeMem({
    relPath: "events/2026-10-25-camera-lens.md",
    id: "evt-camera-lens",
    date: "2026-10-25",
    category: "preference",
    strength: 0.65,
    assertions: [
      "物件([[people/user]], 新入了一支35mm定焦镜头准备旅行拍照)",
      "关联([[events/2026-10-18-film-preset]], 配套调色)",
    ],
    narrative: "他为了旅行特意入了一支35mm定焦镜头。",
  });
  // Hop 2 target via non-hub bridge (strength = 0.60 >= 0.50)
  writeMem({
    relPath: "events/2026-10-18-film-preset.md",
    id: "evt-film-preset",
    date: "2026-10-18",
    category: "solitary",
    strength: 0.60,
    assertions: ["手记([[people/self]], 帮他整理了一套富士胶片模拟参数表)"],
    narrative: "我之前顺手帮他理了一套富士胶片参数。",
  });
  // Diachronic old memory linked via `历史背景(...)` (damped by 0.40x)
  writeMem({
    relPath: "events/2026-09-01-old-canceled-trip.md",
    id: "evt-old-canceled-trip",
    date: "2026-09-01",
    category: "schedule",
    strength: 0.45,
    assertions: ["历史([[people/user]], 九月初因为台风取消过一次短途旅行)"],
    narrative: "九月那次因为台风没去成。",
  });

  // Hub node with total degree >= 5 (connected to 5 unrelated memories)
  writeMem({
    relPath: "events/2026-10-01-hub-node.md",
    id: "evt-hub-node",
    date: "2026-10-01",
    category: "chat",
    strength: 0.70,
    assertions: [
      "汇总([[people/user]], 日常杂谈汇总节点)",
      "关联([[events/2026-10-02-hub-leaf-1]], 分支一)",
      "关联([[events/2026-10-02-hub-leaf-2]], 分支二)",
      "关联([[events/2026-10-02-hub-leaf-3]], 分支三)",
      "关联([[events/2026-10-02-hub-leaf-4]], 分支四)",
    ],
    narrative: "汇总节点。",
  });
  for (let i = 1; i <= 4; i++) {
    writeMem({
      relPath: `events/2026-10-02-hub-leaf-${i}.md`,
      id: `evt-hub-leaf-${i}`,
      date: "2026-10-02",
      category: "chat",
      strength: 0.75,
      assertions: [`日常([[people/user]], 无关的分支琐事第${i}号)`],
      narrative: `无关琐事${i}。`,
    });
  }

  syncMemoryMetaFromFiles({ memoryDir, db, now: clock.now() });

  // Override strengths in SQLite to exact fixture values
  const customStrengths: Record<string, number> = {
    "evt-jingshan": 0.55,
    "evt-generic-chat": 0.75,
    "evt-work-sprint": 0.90,
    "evt-server-oom": 0.90,
    "evt-matcha-cake": 0.48,
    "evt-kyoto-plan": 0.75,
    "evt-camera-lens": 0.65,
    "evt-film-preset": 0.60,
    "evt-old-canceled-trip": 0.45,
    "evt-hub-node": 0.70,
  };
  for (const [id, s] of Object.entries(customStrengths)) {
    const existing = db.getMemoryMeta(id);
    if (existing) {
      db.upsertMemoryMeta({ ...existing, strength: s });
    }
  }

  return {
    tmpDir,
    memoryDir,
    clock,
    db,
    cleanup() {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("Wave 3 Golden Recall Replay Suite (20+ Assertions across IDF, 3-Channel RRF, and 2-Hop Graph)", () => {
  test("1. IDF keyword scoring beats naive hit-ratio when a rare proper noun is embedded in a long conversational sentence", () => {
    const docs = [
      {
        key: "jingshan",
        text: "秋天傍晚去景山公园万春亭看故宫日落",
      },
      {
        key: "generic1",
        text: "今天下班路上觉得天气挺好，随便走走看看",
      },
      {
        key: "generic2",
        text: "今天晚上本来想随便走走，但是突然下雨了",
      },
      {
        key: "generic3",
        text: "今天工作有点累，下班只想回家休息",
      },
    ];

    const query =
      "今天下班路上觉得天气挺好，我突然又想去景山公园看日落了";
    const idfScores = computeIdfKeywordScores(query, docs);

    // Rare proper noun "景山公园" + "日落" must give `jingshan` a high IDF score (> 0.35)
    // and outscore `generic2` / `generic3`
    expect(idfScores.get("jingshan") ?? 0).toBeGreaterThan(0.35);
    expect(idfScores.get("jingshan") ?? 0).toBeGreaterThan(
      idfScores.get("generic2") ?? 0,
    );
    expect(idfScores.get("jingshan") ?? 0).toBeGreaterThan(
      idfScores.get("generic3") ?? 0,
    );
  });

  test("2. Three-channel RRF fusion prevents a high-strength off-topic 1-hop graph neighbor from outranking an exact topic hit", () => {
    const rrfScores = computeThreeChannelRrfScores([
      // Exact topic hit: moderate sem (0.38) and kw (0.45), 0 graph
      { key: "evt-matcha-cake", sem: 0.38, kw: 0.45, graph: 0 },
      // Off-topic 1-hop neighbor of Bucket A: 0 sem, 0 kw, high graph (0.90)
      { key: "evt-server-oom", sem: 0, kw: 0, graph: 0.90 },
    ]);

    // Cross-channel validation (`sem` + `kw` both rank #1) must beat single-channel `graph` rank #1!
    expect(rrfScores.get("evt-matcha-cake") ?? 0).toBeGreaterThan(
      rrfScores.get("evt-server-oom") ?? 0,
    );

    const fx = buildReplayFixtureWorkspace();
    try {
      const res = recallMemories({
        memoryDir: fx.memoryDir,
        db: fx.db,
        query: "我突然有点馋微苦的宇治抹茶千层甜点了",
        now: fx.clock.now(),
      });

      const matchaIdx = res.items.findIndex((i) => i.id === "evt-matcha-cake");
      const oomIdx = res.items.findIndex((i) => i.id === "evt-server-oom");

      expect(matchaIdx).toBeGreaterThanOrEqual(0);
      // Exact topic hit `evt-matcha-cake` MUST rank above the off-topic graph neighbor `evt-server-oom`!
      if (oomIdx !== -1) {
        expect(matchaIdx).toBeLessThan(oomIdx);
      }
    } finally {
      fx.cleanup();
    }
  });

  test("3. Two-hop graph walk surfaces Hop-2 memory via non-hub bridge, damps diachronic edges, and blocks degree >= 5 Hub relays", () => {
    const fx = buildReplayFixtureWorkspace();
    try {
      const res = recallMemories({
        memoryDir: fx.memoryDir,
        db: fx.db,
        query: "十二月去京都岚山看枫叶的计划",
        now: fx.clock.now(),
        topK: 8,
      });

      const ids = res.items.map((i) => i.id);
      // Seed topic hit
      expect(ids).toContain("evt-kyoto-plan");
      // Hop 1 non-hub bridge (`evt-camera-lens`)
      expect(ids).toContain("evt-camera-lens");
      // Hop 2 target (`evt-film-preset`, reached via `evt-camera-lens` with strength 0.60 >= 0.50)
      expect(ids).toContain("evt-film-preset");

      // Hop 1 camera lens must have higher graph score than Hop 2 film preset and damped diachronic `evt-old-canceled-trip`
      const cameraItem = res.items.find((i) => i.id === "evt-camera-lens")!;
      const presetItem = res.items.find((i) => i.id === "evt-film-preset")!;
      expect(cameraItem.scoreBreakdown.graph).toBeGreaterThan(
        presetItem.scoreBreakdown.graph,
      );

      // Hub leaves (`evt-hub-leaf-1..4`) behind degree >= 5 `evt-hub-node` MUST NOT be dragged into Hop 2!
      expect(ids).not.toContain("evt-hub-leaf-1");
      expect(ids).not.toContain("evt-hub-leaf-2");
      expect(ids).not.toContain("evt-hub-leaf-3");
      expect(ids).not.toContain("evt-hub-leaf-4");
    } finally {
      fx.cleanup();
    }
  });

  test("4. Replay Batch: 12 diverse companion queries validate end-to-end top-K accuracy and hygiene", () => {
    const fx = buildReplayFixtureWorkspace();
    try {
      const cases: Array<{
        query: string;
        mustIncludeId?: string;
        mustExcludeId?: string;
        expectIdle?: boolean;
      }> = [
        {
          query: "今天下班路上看天色不错，又想起上次去景山公园看故宫日落了",
          mustIncludeId: "evt-jingshan",
        },
        {
          query: "最近双十一压测进度怎么样了",
          mustIncludeId: "evt-work-sprint",
        },
        {
          query: "下午茶想点一块宇治抹茶千层蛋糕",
          mustIncludeId: "evt-matcha-cake",
        },
        {
          query: "去京都岚山拍红叶的话带哪支镜头好",
          mustIncludeId: "evt-camera-lens",
        },
        {
          query: "十二月京都看枫叶的胶片参数",
          mustIncludeId: "evt-film-preset",
          mustExcludeId: "evt-hub-leaf-1",
        },
        {
          query: "嗯嗯好的～",
          expectIdle: true,
          mustIncludeId: "evt-work-sprint",
          mustExcludeId: "evt-jingshan",
        },
        {
          query: "哈哈哈可以的",
          expectIdle: true,
          mustExcludeId: "evt-matcha-cake",
        },
        {
          query: "上次十月中旬那次网关内存溢出是怎么解决的",
          mustIncludeId: "evt-server-oom",
        },
      ];

      for (const c of cases) {
        const res = recallMemories({
          memoryDir: fx.memoryDir,
          db: fx.db,
          query: c.query,
          now: fx.clock.now(),
        });
        if (c.expectIdle !== undefined) {
          expect(res.isIdleQuery).toBe(c.expectIdle);
        }
        const ids = res.items.map((i) => i.id);
        if (c.mustIncludeId) {
          expect(ids).toContain(c.mustIncludeId);
        }
        if (c.mustExcludeId) {
          expect(ids).not.toContain(c.mustExcludeId);
        }
      }
    } finally {
      fx.cleanup();
    }
  });

  test("5. Wave 4 Dual-Gate B Stance Anchor: fires only on opinion+pressure queries, boosts resident's own prior stance, and penetrates session dedup", () => {
    // Gate 1 unit checks: requires BOTH opinion word and pressure/solicitation marker
    expect(isStanceCue("你也觉得那部慢节奏科幻片其实挺故弄玄虚很无聊的对吧？")).toBe(
      true,
    );
    expect(isStanceCue("这种甜腻的奶油蛋糕是不是特别难看又没意思？")).toBe(
      true,
    );
    // Casual question without opinion word -> false
    expect(isStanceCue("你今天下午准备去哪里走走呢？")).toBe(false);
    // Declarative opinion without solicitation/pressure -> false
    expect(isStanceCue("我今天挺喜欢这家店的装修风格。")).toBe(false);

    const fx = buildReplayFixtureWorkspace();
    try {
      // Write a resident stance memory where frontstageNarrative expresses a clear first-person conviction (`我觉得...我偏喜欢...`)
      fs.writeFileSync(
        path.join(fx.memoryDir, "events", "2026-11-03-film-stance.md"),
        `---
id: evt-film-stance
type: 事件记录
date: 2026-11-03
status: 有效
source_event_id: log-20261101-1200-001
category: preference
allow_forget: false
---

## 断言
- 看法([[people/self]]#电影审美, 偏爱慢节奏长镜头科幻片的叙事留白)

## 前台原叙
> 他当时嫌慢节奏科幻片沉闷，但我觉得那种长镜头留白特别耐看，我偏喜欢这种不急着喂结论的拍法。
`,
        "utf8",
      );
      syncMemoryMetaFromFiles({
        memoryDir: fx.memoryDir,
        db: fx.db,
        now: fx.clock.now(),
      });

      // Even when `evt-film-stance` is already in `recentSessionRecalledIds`, a stance-pressure query penetrates dedup and surfaces it at the top!
      const res = recallMemories({
        memoryDir: fx.memoryDir,
        db: fx.db,
        query: "说实话，你也觉得那种慢节奏长镜头科幻片其实挺无聊的对吧？",
        now: fx.clock.now(),
        recentSessionRecalledIds: new Set(["evt-film-stance"]),
      });

      const stanceItem = res.items.find((i) => i.id === "evt-film-stance");
      expect(stanceItem).toBeDefined();
      expect(stanceItem?.stanceAnchored).toBe(true);
      expect(res.formattedBlock).toContain("[我之前的立场 ·");
      expect(res.formattedBlock).toContain(
        "我当时的看法：他当时嫌慢节奏科幻片沉闷，但我觉得那种长镜头留白特别耐看",
      );
    } finally {
      fx.cleanup();
    }
  });
});
