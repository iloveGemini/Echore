import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import {
  formatGapHint,
  formatVagueWhen,
  VirtualClock,
} from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import {
  REACTIVATED_ARCHIVE_STRENGTH,
  reconsolidateRecalledMemories,
  syncMemoryMetaFromFiles,
} from "../src/hippocampus/decay.ts";
import { runMemoryLinter } from "../src/hippocampus/linter.ts";
import { formatEventFlowWithGapHints } from "../src/hippocampus/pre-hydrator.ts";
import {
  isExplicitReaskQuery,
  isIdleQuery,
  recallMemories,
} from "../src/hippocampus/recall.ts";

function createTempMemoryRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-mem-test-"));
  const templateDir = path.join(process.cwd(), "memory_template");
  fs.cpSync(templateDir, tmpDir, { recursive: true });
  return tmpDir;
}

describe("Hippocampus: L1~L6 Memory CI Linter & 3-Bucket 5-Way Recall", () => {
  test("memory_template passes L1~L6 linter cleanly out of the box", () => {
    const clock = new VirtualClock("2026-11-10T12:00:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const templateDir = path.join(process.cwd(), "memory_template");

    const report = runMemoryLinter({
      memoryDir: templateDir,
      db,
      now: clock.now(),
    });
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    db.close();
  });

  test("L1~L6 Linter catches every single violation rule accurately", () => {
    const clock = new VirtualClock("2026-11-10T12:00:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const memDir = createTempMemoryRepo();

    db.appendEventLog({
      id: "log-20261031-2000-001",
      role: "user",
      speaker: "user",
      content: "下楼散步不小心把脚踝扭伤了",
    });

    // 1. Write old event (still marked 有效 instead of 已取代 -> triggers L3 & L4 when new file claims supersedes)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-10-31-ankle-sprain.md"),
      `---
id: evt-2026-1031-ankle-sprain
type: 状态变更
date: 2026-10-31
status: 有效
source_event_id: log-20261031-2000-001
category: health
allow_forget: false
---
## 断言
- 当前状态([[people/user]]#脚踝, 扭伤未愈)
- 关联状态([[people/ghost_undefined]], 未知人物)
`,
      "utf8",
    );

    // 2. Write new event superseding old event, but missing valid source_event_id in DB (triggers L5)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-11-05-ankle-healed.md"),
      `---
id: evt-2026-1105-ankle-healed
type: 状态变更
date: 2026-11-05
status: 有效
supersedes: evt-2026-1031-ankle-sprain
source_event_id: log-99999999-missing
category: health
allow_forget: false
---
## 断言
- 当前状态([[people/user]]#脚踝, 已康复)
`,
      "utf8",
    );

    // 3. Write an expired T1 minor_worry (10 days old, still 有效 -> triggers L6)
    fs.writeFileSync(
      path.join(memDir, "concerns", "2026-10-31-ankle-worry.md"),
      `---
id: con-2026-1031-ankle-worry
type: 牵挂注
tier: minor_worry
date: 2026-10-31
status: 有效
source_event_id: log-20261031-2000-001
category: health
allow_forget: true
---
## 断言
- 挂钩([[events/2026-10-31-ankle-sprain]], 惦记脚伤)
`,
      "utf8",
    );

    const report1 = runMemoryLinter({
      memoryDir: memDir,
      db,
      now: clock.now(),
    });
    expect(report1.passed).toBe(false);
    const rulesHit = new Set(report1.issues.map((i) => i.rule));
    expect(rulesHit.has("L1")).toBe(true); // [[people/ghost_undefined]]
    expect(rulesHit.has("L3")).toBe(true); // supersedes target still 有效
    expect(rulesHit.has("L4")).toBe(true); // [[people/user]]#脚踝 has two conflicting active values
    expect(rulesHit.has("L5")).toBe(true); // log-99999999-missing not in DB
    expect(rulesHit.has("L6")).toBe(true); // T1 minor_worry >= 7 days still 有效

    // Test L2: when old event is properly marked 已取代, but active concern still has synchronic 约定() to it
    fs.writeFileSync(
      path.join(memDir, "concerns", "2026-10-31-ankle-worry.md"),
      `---
id: con-2026-1031-ankle-worry
type: 牵挂注
tier: normal
date: 2026-10-31
status: 有效
source_event_id: log-20261031-2000-001
category: health
allow_forget: true
---
## 断言
- 约定([[events/2026-10-31-ankle-sprain]], 复查脚伤)
`,
      "utf8",
    );

    fs.writeFileSync(
      path.join(memDir, "events", "2026-10-31-ankle-sprain.md"),
      `---
id: evt-2026-1031-ankle-sprain
type: 状态变更
date: 2026-10-31
status: 已取代
source_event_id: log-20261031-2000-001
category: health
allow_forget: false
---
## 断言
- 当前状态([[people/user]]#脚踝, 扭伤未愈)
`,
      "utf8",
    );

    const report2 = runMemoryLinter({
      memoryDir: memDir,
      db,
      now: clock.now(),
    });
    expect(report2.issues.some((i) => i.rule === "L2")).toBe(true);
    expect(
      report2.issues.some(
        (i) => i.rule === "L6" && i.message.includes("缺失合法的 tier 分级"),
      ),
    ).toBe(true);

    fs.rmSync(memDir, { recursive: true, force: true });
    db.close();
  });

  test("3-Bucket + 5-Way Recall retrieves mainline, topic, and 1-hop graph neighbors with Pre-Hydrated quotes", () => {
    const clock = new VirtualClock("2026-11-10T18:00:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const memDir = createTempMemoryRepo();

    db.appendEventLog({
      id: "log-20261109-2000-001",
      timestamp: "2026-11-09T20:00:00.000Z",
      role: "user",
      speaker: "user",
      content: "下周二我要去杭州出差三天，顺便想去灵隐寺走走",
    });
    db.appendEventLog({
      id: "log-20261020-2100-002",
      timestamp: "2026-10-20T21:00:00.000Z",
      role: "user",
      speaker: "user",
      content: "每次去杭州我都一定要喝龙井拿铁",
    });

    // Recent schedule memory (Bucket A Mainline <= 72h)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-11-09-hangzhou-trip.md"),
      `---
id: evt-2026-1109-hangzhou-trip
type: 事件记录
date: 2026-11-09
status: 有效
source_event_id: log-20261109-2000-001
category: schedule
allow_forget: false
---
## 断言
- 当前状态([[people/user]]#近期行程, 下周二去杭州出差三天)
- 关联状态([[events/2026-10-20-hangzhou-coffee]], 杭州出行习惯)

## 前台原叙
> 他说下周二要去杭州出差，还惦记着去灵隐寺逛逛。
`,
      "utf8",
    );

    // Older preference memory linked via [[events/2026-10-20-hangzhou-coffee]] (Bucket C Graph / Bucket B Topic)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-10-20-hangzhou-coffee.md"),
      `---
id: evt-2026-1020-hangzhou-coffee
type: 事件记录
date: 2026-10-20
status: 有效
source_event_id: log-20261020-2100-002
category: preference
allow_forget: false
---
## 断言
- 偏好([[people/user]]#饮品, 去杭州必喝龙井拿铁)

## 前台原叙
> 我记得他提过每次去杭州都要找家店喝龙井拿铁。
`,
      "utf8",
    );

    const recalled = recallMemories({
      memoryDir: memDir,
      db,
      query: "我明天开始收拾行李准备出差了",
      now: clock.now(),
    });

    expect(recalled.items.length).toBe(2);
    const ids = recalled.items.map((i) => i.id);
    expect(ids).toContain("evt-2026-1109-hangzhou-trip");
    expect(ids).toContain("evt-2026-1020-hangzhou-coffee");

    // Verify Bucket C graph expansion worked for the linked coffee preference
    const coffeeItem = recalled.items.find(
      (i) => i.id === "evt-2026-1020-hangzhou-coffee",
    );
    expect(coffeeItem?.bucket).toBe("bucket_c_graph");

    // Verify Pre-Hydration inlined original quote with vague time only
    // (回想只给大概：近期引文只给模糊时段，精确日期不进入前台上下文；
    //  时段标签随本地时区而变，断言只锁“模糊时段 + 原话内容”与“无精确日期”)
    expect(recalled.formattedBlock).toContain(
      "他说：“下周二我要去杭州出差三天，顺便想去灵隐寺走走”",
    );
    expect(recalled.formattedBlock).toMatch(
      /(今天|昨天|前天)(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜) 他说：“下周二我要去杭州出差三天/,
    );
    expect(recalled.formattedBlock).not.toContain("2026-11-09");
    expect(recalled.formattedBlock).not.toMatch(/log-\d+/);

    fs.rmSync(memDir, { recursive: true, force: true });
    db.close();
  });

  test("Wave 2: isIdleQuery short-circuit, session dedup with re-ask exemption, 3-tier cascade (event_log_fts + cold archive reactivation), and vagueWhen/gapHint", () => {
    const clock = new VirtualClock("2026-11-10T21:30:00");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const memDir = createTempMemoryRepo();

    const logMainline = db.appendEventLog({
      id: "log-20261110-1000-001",
      timestamp: new Date("2026-11-10T10:00:00").toISOString(),
      role: "user",
      speaker: "user",
      content: "今天上午要去医院做个常规体检",
    });
    const logTopicA = db.appendEventLog({
      id: "log-20261105-2000-002",
      timestamp: new Date("2026-11-05T20:00:00").toISOString(),
      role: "user",
      speaker: "user",
      content: "我最喜欢的悬疑导演是诺兰，尤其是星际穿越",
    });
    const logTopicB = db.appendEventLog({
      id: "log-20261104-2000-003",
      timestamp: new Date("2026-11-04T20:00:00").toISOString(),
      role: "user",
      speaker: "user",
      content: "我也挺喜欢看丹尼斯维伦纽瓦拍的银翼杀手2049",
    });
    const logCold = db.appendEventLog({
      id: "log-20261001-1900-004",
      timestamp: new Date("2026-10-01T19:00:00").toISOString(),
      role: "user",
      speaker: "user",
      content: "十月初那家胡同里的桂花乌龙茶特别惊艳",
    });
    // Raw event only in SQLite event_log (not yet compiled into any .md file)
    db.appendEventLog({
      id: "log-20261110-1500-005",
      timestamp: new Date("2026-11-10T15:00:00").toISOString(),
      role: "user",
      speaker: "user",
      content: "顺便提一嘴，我们的秘密代号叫「深海蓝鲸」",
    });

    // 1) Recent mainline file (Bucket A)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-11-10-checkup.md"),
      `---
id: evt-checkup
type: 事件记录
date: 2026-11-10
status: 有效
source_event_id: ${logMainline.id}
category: health
allow_forget: true
---
## 断言
- 当前状态([[people/user]]#体检, 今天上午去医院做常规体检)

## 前台原叙
> 他今天上午去医院体检了。
`,
      "utf8",
    );

    // 2) Two movie preference files (Bucket B candidates)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-11-05-nolan.md"),
      `---
id: evt-nolan
type: 事件记录
date: 2026-11-05
status: 有效
source_event_id: ${logTopicA.id}
category: preference
allow_forget: true
---
## 断言
- 偏好([[people/user]]#科幻电影导演, 喜欢看诺兰拍的科幻片星际穿越)

## 前台原叙
> 他很喜欢看诺兰的科幻电影。
`,
      "utf8",
    );

    fs.writeFileSync(
      path.join(memDir, "events", "2026-11-04-villeneuve.md"),
      `---
id: evt-villeneuve
type: 事件记录
date: 2026-11-04
status: 有效
source_event_id: ${logTopicB.id}
category: preference
allow_forget: true
---
## 断言
- 偏好([[people/user]]#科幻电影风格, 喜欢看维伦纽瓦拍的科幻片银翼杀手)

## 前台原叙
> 他也很欣赏维伦纽瓦的科幻电影美学。
`,
      "utf8",
    );

    // 3) Cold archived file (`status: 已沉底`, strength = 0.12)
    const coldRelPath = "events/2026-10-01-osmanthus-tea.md";
    fs.writeFileSync(
      path.join(memDir, coldRelPath),
      `---
id: evt-osmanthus-tea
type: 事件记录
date: 2026-10-01
status: 已沉底
source_event_id: ${logCold.id}
category: chat
allow_forget: true
---
## 断言
- 日常([[people/user]], 夸胡同里的桂花乌龙茶好喝)

## 前台原叙
> 那天他特意夸了桂花乌龙茶。
`,
      "utf8",
    );

    syncMemoryMetaFromFiles({ memoryDir: memDir, db, now: clock.now() });
    db.upsertMemoryMeta({
      ...db.getMemoryMeta("evt-osmanthus-tea")!,
      status: "已沉底",
      strength: 0.12,
    });

    // --- A. Verify isIdleQuery & reconsolidation anti-farming ---
    expect(isIdleQuery("嗯")).toBe(true);
    expect(isIdleQuery("好的呀～")).toBe(true);
    expect(isIdleQuery("哈哈哈")).toBe(true);
    expect(isIdleQuery("今天去看了科幻电影")).toBe(false);

    const idleRecall = recallMemories({
      memoryDir: memDir,
      db,
      query: "好的嗯嗯",
      now: clock.now(),
    });
    expect(idleRecall.isIdleQuery).toBe(true);
    expect(
      idleRecall.items.every((i) => i.bucket === "bucket_a_mainline"),
    ).toBe(true);

    reconsolidateRecalledMemories({
      db,
      memoryDir: memDir,
      recalledItems: idleRecall.items,
      isNegativeOrConflictTurn: false,
      isIdleQuery: idleRecall.isIdleQuery,
      now: clock.now(),
    });
    // Strength and access_count must NOT be farmed on idle turns
    expect(db.getMemoryMeta("evt-checkup")?.access_count).toBe(0);
    expect(db.getMemoryMeta("evt-checkup")?.strength).toBe(0.75);

    // --- B. Verify Session Recall Dedup & Explicit Re-ask Exemption ---
    const turn1 = recallMemories({
      memoryDir: memDir,
      db,
      query: "聊一聊诺兰的科幻电影",
      now: clock.now(),
      topK: 2,
    });
    const turn1TopicIds = turn1.items
      .filter((i) => i.bucket === "bucket_b_topic")
      .map((i) => i.id);
    expect(turn1TopicIds[0]).toBe("evt-nolan");

    // Next turn on "科幻电影" with `evt-nolan` in recentSessionRecalledIds -> `evt-villeneuve` ranks ahead of `evt-nolan`
    const turn2Deduped = recallMemories({
      memoryDir: memDir,
      db,
      query: "那还有什么喜欢的科幻电影片子",
      now: clock.now(),
      recentSessionRecalledIds: new Set(["evt-nolan"]),
    });
    const turn2TopicIds = turn2Deduped.items
      .filter((i) => i.bucket === "bucket_b_topic")
      .map((i) => i.id);
    expect(turn2TopicIds[0]).toBe("evt-villeneuve");

    // Explicit re-ask ("刚才说的诺兰科幻电影再讲一遍") bypasses session dedup penalty!
    expect(isExplicitReaskQuery("把刚才说的诺兰科幻电影再讲一遍")).toBe(true);
    const turn3Reask = recallMemories({
      memoryDir: memDir,
      db,
      query: "把刚才说的诺兰科幻电影再讲一遍",
      now: clock.now(),
      recentSessionRecalledIds: new Set(["evt-nolan"]),
    });
    expect(turn3Reask.bypassedSessionDedup).toBe(true);
    const turn3TopicIds = turn3Reask.items
      .filter((i) => i.bucket === "bucket_b_topic")
      .map((i) => i.id);
    expect(turn3TopicIds[0]).toBe("evt-nolan");

    // --- C. Verify Stage 2 (Literal raw event FTS fallback) ---
    const rawFallbackRecall = recallMemories({
      memoryDir: memDir,
      db,
      query: "你还记得「深海蓝鲸」这个代号吗？",
      now: clock.now(),
    });
    expect(rawFallbackRecall.rawEventSnippets.length).toBeGreaterThanOrEqual(1);
    expect(rawFallbackRecall.formattedBlock).toContain("深海蓝鲸");
    expect(rawFallbackRecall.formattedBlock).toContain("[当时原话线索");

    // --- D. Verify Stage 3 (Cold archive `已沉底` wakeup + reconsolidation reactivation to 0.435) ---
    const coldRecall = recallMemories({
      memoryDir: memDir,
      db,
      query: "你还记得之前喝过的桂花乌龙茶吗？",
      now: clock.now(),
    });
    expect(coldRecall.reactivatedArchiveIds).toContain("evt-osmanthus-tea");
    expect(coldRecall.formattedBlock).toContain("[翻出的旧记忆");

    reconsolidateRecalledMemories({
      db,
      memoryDir: memDir,
      recalledItems: coldRecall.items,
      isNegativeOrConflictTurn: false,
      isIdleQuery: coldRecall.isIdleQuery,
      now: clock.now(),
    });
    const reactivatedMeta = db.getMemoryMeta("evt-osmanthus-tea");
    expect(reactivatedMeta?.status).toBe("有效");
    expect(reactivatedMeta?.strength).toBeCloseTo(
      REACTIVATED_ARCHIVE_STRENGTH,
      4,
    );
    expect(
      matter(fs.readFileSync(path.join(memDir, coldRelPath), "utf8")).data
        .status,
    ).toBe("有效");

    // --- E. Verify vagueWhen & gapHint time sense ---
    expect(
      formatVagueWhen(new Date("2026-11-10T23:30:00"), clock.now()),
    ).toBe("今天深夜");
    expect(
      formatVagueWhen(new Date("2026-11-09T14:00:00"), clock.now()),
    ).toBe("昨天下午");
    expect(
      formatVagueWhen(new Date("2026-11-08T20:00:00"), clock.now()),
    ).toBe("前天晚上");
    expect(
      formatVagueWhen(new Date("2026-11-05T09:00:00"), clock.now()),
    ).toContain("11-05（周四）上午");
    expect(
      formatVagueWhen(new Date("2026-10-01T09:00:00"), clock.now()),
    ).toBe("2026-10-01");

    expect(formatGapHint(5 * 60_000)).toBeNull();
    expect(formatGapHint(15 * 60_000)).toBe("（过了一会儿）");
    expect(formatGapHint(45 * 60_000)).toBe("（过了半个多小时）");
    expect(formatGapHint(3 * 3600_000)).toBe("（隔了约 3 小时）");
    expect(formatGapHint(48 * 3600_000)).toBe("（隔了约 2 天）");

    const flowLines = formatEventFlowWithGapHints(
      [
        {
          id: "log-20261110-1000-010",
          timestamp: new Date("2026-11-10T10:00:00").toISOString(),
          role: "user",
          speaker: "user",
          content: "我到医院了",
          metadata: {},
        },
        {
          id: "log-20261110-1020-011",
          timestamp: new Date("2026-11-10T10:20:00").toISOString(),
          role: "user",
          speaker: "user",
          content: "刚抽完血",
          metadata: {},
        },
        {
          id: "log-20261110-1430-012",
          timestamp: new Date("2026-11-10T14:30:00").toISOString(),
          role: "user",
          speaker: "user",
          content: "体检报告出来了，一切正常",
          metadata: {},
        },
      ],
      clock.now(),
    );
    expect(flowLines).toContain("── 今天上午 ──");
    expect(flowLines).toContain("（过了一会儿）");
    expect(flowLines).toContain("（隔了约 4 小时）");
    expect(flowLines).toContain("── 今天下午 ──");

    fs.rmSync(memDir, { recursive: true, force: true });
    db.close();
  });
});
