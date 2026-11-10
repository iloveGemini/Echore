import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { runMemoryLinter } from "../src/hippocampus/linter.ts";
import { recallMemories } from "../src/hippocampus/recall.ts";

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

    // Verify Pre-Hydration inlined original quote and stripped log-* IDs
    expect(recalled.formattedBlock).toContain(
      "2026-11-09 他说：“下周二我要去杭州出差三天，顺便想去灵隐寺走走”",
    );
    expect(recalled.formattedBlock).not.toMatch(/log-\d+/);

    fs.rmSync(memDir, { recursive: true, force: true });
    db.close();
  });
});
