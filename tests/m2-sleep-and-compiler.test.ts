import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { resolvePersonaProfile } from "../src/endocrine/archetypes.ts";
import { settleNightlyConcerns } from "../src/endocrine/handover.ts";
import {
  appendHotJournalEntry,
  extractColdReflectionForDate,
  synthesizeBedtimeReflection,
} from "../src/frontstage/journal.ts";
import { runNightlyCompiler } from "../src/hippocampus/compiler.ts";
import {
  ARCHIVAL_STRENGTH_THRESHOLD,
  CATEGORY_HALF_LIFE_DAYS,
  computeDailyRetention,
  INITIAL_MEMORY_STRENGTH,
  reconsolidateRecalledMemories,
  runDailyMemoryDecayAndArchive,
} from "../src/hippocampus/decay.ts";
import { runMemoryLinter } from "../src/hippocampus/linter.ts";
import { recallMemories } from "../src/hippocampus/recall.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import type {
  LLMGenerateParams,
  LLMProvider,
  LLMResponse,
  SandwichRequest,
} from "../src/llm/types.ts";
import { EchoreEngine } from "../src/loop/engine.ts";

function createTempMemoryRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-m2-test-"));
  const templateDir = path.join(process.cwd(), "memory_template");
  fs.cpSync(templateDir, tmpDir, { recursive: true });
  return tmpDir;
}

describe("M2: Nightly Liver Settlement, Hippocampus Compiler, Decay & Sleep Loop", () => {
  test("1. Frontstage bedtime reflection summarizes hot journal in first-person and blocks leaks", async () => {
    const clock = new VirtualClock("2026-11-10T23:30:00.000Z");
    const memDir = createTempMemoryRepo();
    const profile = resolvePersonaProfile({
      name: "阿狸",
      archetype: "cat_aloof",
      chronotype: "night_owl",
    });

    appendHotJournalEntry({
      memoryDir: memDir,
      dateStr: "2026-11-10",
      timeStr: "15:20",
      tag: "独居",
      firstPersonText: "下午窝在沙发上看完了半本悬疑小说，推理节奏还挺紧凑。",
    });
    appendHotJournalEntry({
      memoryDir: memDir,
      dateStr: "2026-11-10",
      timeStr: "20:40",
      tag: "交互",
      firstPersonText: "晚上和他聊了周末去看的展览，顺嘴嫌弃了一下他的拍照技术。",
    });

    const mockProvider: LLMProvider = {
      providerName: "mock",
      async generate(params: LLMGenerateParams): Promise<LLMResponse> {
        expect(params.messages[0]?.content).toContain("悬疑小说");
        expect(params.messages[0]?.content).toContain("展览");
        return {
          text: "今天下午自己看书挺惬意，晚上和他拌嘴聊周末的展览，虽然嘴上嫌弃他，但心里还是挺盼着周末的。",
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
      async generateSandwich(_req: SandwichRequest): Promise<LLMResponse> {
        throw new Error("Unused");
      },
    };

    const router = new OrganModelRouter({
      frontstage: { provider: mockProvider, model: "claude-opus-5-5" },
      endocrine: { provider: mockProvider, model: "claude-haiku-5-5" },
      compiler: { provider: mockProvider, model: "claude-opus-5-5" },
      worker: { provider: mockProvider, model: "claude-sonnet-5-5" },
    });

    const reflection = await synthesizeBedtimeReflection({
      router,
      profile,
      memoryDir: memDir,
      dateStr: "2026-11-10",
      now: clock.now(),
    });

    expect(reflection).toContain("虽然嘴上嫌弃他");
    const extracted = extractColdReflectionForDate(memDir, "2026-11-10");
    expect(extracted).toBe(reflection);

    fs.rmSync(memDir, { recursive: true, force: true });
  });

  test("2. Endocrine nightly liver settlement evolves T1 (7d fade), T2 (5d cold war Cap_ox), T3 (21d scar) and resolved concerns", () => {
    const clock = new VirtualClock("2026-11-01T12:00:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const profile = resolvePersonaProfile({
      archetype: "cat_aloof", // B_ox = 0.45, F_ox = 0.25, B_cort = 0.20
      chronotype: "regular",
    });

    const logWorry = db.appendEventLog({
      id: "log-20261101-1200-001",
      role: "user",
      speaker: "user",
      content: "最近加班有点多，腰有点酸",
    });
    const logConflict = db.appendEventLog({
      id: "log-20261101-1900-002",
      role: "user",
      speaker: "user",
      content: "周末约好的晚饭我临时不去了，行了别烦我",
    });
    const logResolved = db.appendEventLog({
      id: "log-20261101-2100-003",
      role: "user",
      speaker: "user",
      content: "抱歉刚才语气重了，我给你带了夜宵赔罪",
    });

    // Insert T1 minor_worry, T2 acute conflict, and already-resolved concern
    db.upsertConcern({
      id: "con-worry-backache",
      tier: "minor_worry",
      status: "有效",
      summary: "惦记他加班腰酸",
      source_event_id: logWorry.id,
      created_at: "2026-11-01T12:00:00.000Z",
      updated_at: "2026-11-01T12:00:00.000Z",
      floor_cort: 0,
      cap_ox: 1.0,
      has_prep: false,
    });
    db.upsertConcern({
      id: "con-conflict-dinner",
      tier: "conflict",
      status: "有效",
      summary: "周末临时爽约且态度敷衍",
      source_event_id: logConflict.id,
      created_at: "2026-11-01T19:00:00.000Z",
      updated_at: "2026-11-01T19:00:00.000Z",
      floor_cort: 0.42,
      cap_ox: 1.0,
      has_prep: false,
    });
    db.upsertConcern({
      id: "con-resolved-apology",
      tier: "conflict",
      status: "已落定",
      summary: "拌嘴后已带夜宵和解",
      source_event_id: logResolved.id,
      created_at: "2026-11-01T20:00:00.000Z",
      updated_at: "2026-11-01T21:00:00.000Z",
      floor_cort: 0,
      cap_ox: 1.0,
      has_prep: false,
    });

    // Fast-forward 5 days -> 2026-11-06: T2 conflict hits Day 5 -> escalates to 僵持待解 with Cap_ox = B_ox - 0.15 = 0.30
    clock.advanceDays(5);
    const verdictDay5 = settleNightlyConcerns({
      db,
      profile,
      now: clock.now(),
    });

    const t2ItemDay5 = verdictDay5.items.find(
      (i) => i.concern_id === "con-conflict-dinner",
    );
    expect(t2ItemDay5?.action).toBe("escalate_cold_war");
    expect(t2ItemDay5?.next_status).toBe("僵持待解");
    expect(verdictDay5.hormone_bounds_after.cap_ox).toBeCloseTo(0.30, 2);

    const settledItem = verdictDay5.items.find(
      (i) => i.concern_id === "con-resolved-apology",
    );
    expect(settledItem?.action).toBe("settle_resolved");

    // Fast-forward 2 more days -> Day 7 (2026-11-08): T1 minor_worry hits Day 7 -> fades to 已淡化
    // Already-settled `con-resolved-apology` must NOT be re-emitted on subsequent nights
    clock.advanceDays(2);
    const verdictDay7 = settleNightlyConcerns({
      db,
      profile,
      now: clock.now(),
    });
    expect(
      verdictDay7.items.some((i) => i.concern_id === "con-resolved-apology"),
    ).toBe(false);
    const t1ItemDay7 = verdictDay7.items.find(
      (i) => i.concern_id === "con-worry-backache",
    );
    expect(t1ItemDay7?.action).toBe("fade_minor_worry");
    expect(t1ItemDay7?.next_status).toBe("已淡化");
    expect(db.getConcernById("con-worry-backache")?.status).toBe("已淡化");

    // Fast-forward 14 more days -> Day 21 (2026-11-22): T2 stalemate hits Day 21 -> crystallizes into T3 scar (`已结痂`) and releases Cap_ox back to 1.0
    clock.advanceDays(14);
    const verdictDay21 = settleNightlyConcerns({
      db,
      profile,
      now: clock.now(),
    });
    const t3ItemDay21 = verdictDay21.items.find(
      (i) => i.concern_id === "con-conflict-dinner",
    );
    expect(t3ItemDay21?.action).toBe("crystallize_scar");
    expect(t3ItemDay21?.next_tier).toBe("scar");
    expect(t3ItemDay21?.next_status).toBe("已结痂");
    expect(t3ItemDay21?.scar_rule?.slot_tag).toContain("敏感");
    expect(verdictDay21.hormone_bounds_after.cap_ox).toBe(1.0);

    db.close();
  });

  test("3. Hippocampus compiler closes supersedes chains, preserves frontstage narrative, and passes L1~L6 linter", async () => {
    const clock = new VirtualClock("2026-11-05T23:00:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const memDir = createTempMemoryRepo();

    db.appendEventLog({
      id: "log-20261031-2000-001",
      timestamp: "2026-10-31T20:00:00.000Z",
      role: "user",
      speaker: "user",
      content: "下楼散步不小心把脚踝扭伤了",
    });
    db.appendEventLog({
      id: "log-20261105-2140-002",
      timestamp: "2026-11-05T21:40:00.000Z",
      role: "user",
      speaker: "user",
      content: "今天走路脚踝已经完全不疼了，还跟同事阿杰约了周末打球，以后咱们就是加班搭子了",
    });

    // Existing active event from Oct 31 (ankle sprain) + active concern pointing to it
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

## 前台原叙
> 听说他下楼把脚扭了，这两天得提醒他少走动。
`,
      "utf8",
    );

    const compileRes = await runNightlyCompiler({
      memoryDir: memDir,
      db,
      now: clock.now(),
      dateStr: "2026-11-05",
      verdict: {
        date: "2026-11-05",
        items: [
          {
            concern_id: "con-2026-1031-ankle-worry",
            action: "settle_resolved",
            previous_tier: "minor_worry",
            next_tier: "minor_worry",
            previous_status: "已落定",
            next_status: "已落定",
            summary: "惦记他脚踝扭伤消肿情况",
            source_event_id: "log-20261031-2000-001",
            created_at: "2026-10-31T20:00:00.000Z",
            age_days: 5,
            reason: "脚踝已彻底康复",
          },
        ],
        hormone_bounds_after: { floor_cort: 0.15, cap_ox: 1.0 },
      },
      coldReflection:
        "他今天终于说脚踝彻底消肿不疼了。这几天每次聊起出门都替他捏把汗，现在这块石头总算落了地。",
      planOverride: {
        memories: [
          {
            rel_path: "events/2026-11-05-ankle-healed.md",
            id: "evt-2026-1105-ankle-healed",
            type: "状态变更",
            date: "2026-11-05",
            status: "有效",
            // Intentionally omit supersedes to test automatic slot-conflict detection & supersedes closure!
            source_event_id: "log-20261105-2140-002",
            category: "health",
            allow_forget: false,
            assertions: [
              "当前状态([[people/user]]#脚踝, 已康复)",
              "历史背景([[events/2026-10-31-ankle-sprain]], 扭伤五天后痊愈)",
              "约定([[people/ajie]], 周末一起打球)",
            ],
          },
        ],
        rapport_rules: [
          {
            section: "专属称呼与黑话",
            predicate_line: '暗号("加班搭子", "指代每晚十点后互相监督早睡")',
            source_event_id: "log-20261105-2140-002",
          },
        ],
      },
    });

    // Verify L1~L6 linter passed with 0 issues
    expect(compileRes.lintReport.passed).toBe(true);
    expect(compileRes.lintReport.issues).toEqual([]);

    // Verify old ankle-sprain file was automatically marked `status: 已取代`
    expect(compileRes.supersededIds).toContain("evt-2026-1031-ankle-sprain");
    const oldParsed = matter(
      fs.readFileSync(
        path.join(memDir, "events", "2026-10-31-ankle-sprain.md"),
        "utf8",
      ),
    );
    expect(oldParsed.data.status).toBe("已取代");

    // Verify new ankle-healed file has `supersedes: evt-2026-1031-ankle-sprain` and preserved frontstage narrative
    const newParsed = matter(
      fs.readFileSync(
        path.join(memDir, "events", "2026-11-05-ankle-healed.md"),
        "utf8",
      ),
    );
    expect(newParsed.data.supersedes).toBe("evt-2026-1031-ankle-sprain");
    expect(newParsed.content).toContain(
      "> 他今天终于说脚踝彻底消肿不疼了。这几天每次聊起出门都替他捏把汗，现在这块石头总算落了地。",
    );

    // Verify undefined symbol [[people/ajie]] was auto-created in people/ajie.md so L1 passed
    expect(fs.existsSync(path.join(memDir, "people", "ajie.md"))).toBe(true);

    // Verify rapport.md received the new rule with [src: log-...]
    const rapportContent = fs.readFileSync(
      path.join(memDir, "implicit", "rapport.md"),
      "utf8",
    );
    expect(rapportContent).toContain(
      '- 暗号("加班搭子", "指代每晚十点后互相监督早睡") [src: log-20261105-2140-002]',
    );

    fs.rmSync(memDir, { recursive: true, force: true });
    db.close();
  });

  test("4. Fixed-step exponential decay hits 0.12 at exactly t = T_cat for zero-access memories, while reconsolidation and allow_forget protect memories", () => {
    const clock = new VirtualClock("2026-11-01T23:50:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const memDir = createTempMemoryRepo();

    db.appendEventLog({
      id: "log-20261101-1000-001",
      role: "user",
      speaker: "user",
      content: "今天中午吃了一碗牛肉面，顺便聊了聊喜欢的电影",
    });

    // 1. Ephemeral chat memory (T_cat = 7d, allow_forget: true)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-11-01-beef-noodle.md"),
      `---
id: evt-2026-1101-beef-noodle
type: 事件记录
date: 2026-11-01
status: 有效
source_event_id: log-20261101-1000-001
category: chat
allow_forget: true
---

## 断言
- 日常([[people/user]], 中午吃了一碗牛肉面)

## 前台原叙
> 他中午去吃了碗牛肉面。
`,
      "utf8",
    );

    // 2. Another chat memory that gets recalled & reconsolidated positively (+0.05 strength, access_count = 1)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-11-01-movie-chat.md"),
      `---
id: evt-2026-1101-movie-chat
type: 事件记录
date: 2026-11-01
status: 有效
source_event_id: log-20261101-1000-001
category: chat
allow_forget: true
---

## 断言
- 话题([[people/user]], 聊起了喜欢的科幻电影)

## 前台原叙
> 我们顺着午饭聊到了他最喜欢的科幻片。
`,
      "utf8",
    );

    // 3. Nail memory (allow_forget: false)
    fs.writeFileSync(
      path.join(memDir, "events", "2026-11-01-allergy-nail.md"),
      `---
id: evt-2026-1101-allergy-nail
type: 状态变更
date: 2026-11-01
status: 有效
source_event_id: log-20261101-1000-001
category: health
allow_forget: false
---

## 断言
- 当前状态([[people/user]]#过敏源, 对花生严重过敏)

## 前台原叙
> 他特意交代自己对花生过敏，这件事我必须牢牢记住。
`,
      "utf8",
    );

    // Verify mathematical formula for all categories at access_count = 0
    for (const [cat, tCat] of Object.entries(CATEGORY_HALF_LIFE_DAYS)) {
      const retention = computeDailyRetention(
        cat as keyof typeof CATEGORY_HALF_LIFE_DAYS,
        0,
      );
      const afterTCat = INITIAL_MEMORY_STRENGTH * Math.pow(retention, tCat);
      expect(afterTCat).toBeCloseTo(ARCHIVAL_STRENGTH_THRESHOLD, 6);
    }

    // Reconsolidate movie-chat once on Day 1 (positive turn -> +0.05 strength to 0.80, access_count = 1)
    reconsolidateRecalledMemories({
      db,
      memoryDir: memDir,
      recalledItems: [
        {
          id: "evt-2026-1101-movie-chat",
          symbolKey: "events/2026-11-01-movie-chat",
          relPath: "events/2026-11-01-movie-chat.md",
          type: "事件记录",
          category: "chat",
          status: "有效",
          date: "2026-11-01",
          summary: "聊起科幻电影",
          bucket: "bucket_b_topic",
          score: 0.8,
          scoreBreakdown: { sem: 0.8, kw: 0.8, graph: 0, time: 1, strength: 0.75 },
        },
      ],
      isNegativeOrConflictTurn: false,
      now: clock.now(),
    });
    expect(db.getMemoryMeta("evt-2026-1101-movie-chat")?.strength).toBeCloseTo(
      0.80,
      4,
    );

    // Negative turn recall does NOT increase strength
    reconsolidateRecalledMemories({
      db,
      memoryDir: memDir,
      recalledItems: [
        {
          id: "evt-2026-1101-movie-chat",
          symbolKey: "events/2026-11-01-movie-chat",
          relPath: "events/2026-11-01-movie-chat.md",
          type: "事件记录",
          category: "chat",
          status: "有效",
          date: "2026-11-01",
          summary: "聊起科幻电影",
          bucket: "bucket_b_topic",
          score: 0.8,
          scoreBreakdown: { sem: 0.8, kw: 0.8, graph: 0, time: 1, strength: 0.80 },
        },
      ],
      isNegativeOrConflictTurn: true,
      now: clock.now(),
    });
    expect(db.getMemoryMeta("evt-2026-1101-movie-chat")?.strength).toBeCloseTo(
      0.80,
      4,
    );
    expect(db.getMemoryMeta("evt-2026-1101-movie-chat")?.access_count).toBe(2);

    // Run 6 daily decay cycles (Day 2 ~ Day 7, 6 days elapsed -> not yet archived)
    for (let d = 1; d <= 6; d++) {
      clock.advanceDays(1);
      const rep = runDailyMemoryDecayAndArchive({
        memoryDir: memDir,
        db,
        now: clock.now(),
      });
      expect(rep.archivedIds).not.toContain("evt-2026-1101-beef-noodle");
    }

    // On Day 7 (7th daily decay cycle, 7 days since 2026-11-01):
    // zero-access `beef-noodle` reaches 0.12 and transitions to `status: 已沉底`!
    clock.advanceDays(1);
    const repDay7 = runDailyMemoryDecayAndArchive({
      memoryDir: memDir,
      db,
      now: clock.now(),
    });

    expect(repDay7.archivedIds).toContain("evt-2026-1101-beef-noodle");
    expect(repDay7.archivedIds).not.toContain("evt-2026-1101-movie-chat");
    expect(repDay7.exemptIds).toContain("evt-2026-1101-allergy-nail");

    // Verify file on disk was NOT deleted, and its YAML status is now `已沉底`
    const noodleFile = path.join(memDir, "events", "2026-11-01-beef-noodle.md");
    expect(fs.existsSync(noodleFile)).toBe(true);
    expect(matter(fs.readFileSync(noodleFile, "utf8")).data.status).toBe(
      "已沉底",
    );

    // Verify `已沉底` file is excluded from daytime recall pool
    const recallAfter = recallMemories({
      memoryDir: memDir,
      db,
      query: "牛肉面",
      now: clock.now(),
    });
    expect(
      recallAfter.items.some((i) => i.id === "evt-2026-1101-beef-noodle"),
    ).toBe(false);

    fs.rmSync(memDir, { recursive: true, force: true });
    db.close();
  });

  test("5. Loop 3 End-to-End: EchoreEngine.runSleepCycle() orchestrates reflection, verdict, compilation, decay, L1~L6 linter and git commit", async () => {
    const clock = new VirtualClock("2026-11-10T20:00:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const tmpMemDir = createTempMemoryRepo();

    const mockProvider: LLMProvider = {
      providerName: "mock-all",
      async generate(params: LLMGenerateParams): Promise<LLMResponse> {
        const sys = params.system ?? "";
        if (sys.includes("内分泌脉冲评估器")) {
          return {
            text: JSON.stringify({
              event_summary: "用户说脚伤已经好利索了",
              confidence: 0.95,
              is_conflict: false,
              is_reconciliation: true,
              is_warm: true,
              is_novel: false,
              matched_rapport_joke: false,
              cortisol_delta: -0.05,
              oxytocin_delta: 0.08,
              dopamine_delta: 0.04,
            }),
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        if (sys.includes("睡前时刻")) {
          return {
            text: "今晚听他说脚踝彻底不疼了，悬了好几天的心总算放了下来。",
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        if (sys.includes("夜间唯一 Markdown 编译器")) {
          const logMatch = params.messages[0]?.content.match(/\[(log-[^\]]+)\]/);
          const validLogId = logMatch?.[1] ?? "log-20261110-2000-001";
          return {
            text: JSON.stringify({
              memories: [
                {
                  rel_path: "events/2026-11-10-ankle-recovered.md",
                  id: "evt-2026-1110-ankle-recovered",
                  type: "状态变更",
                  date: "2026-11-10",
                  status: "有效",
                  source_event_id: validLogId,
                  category: "health",
                  allow_forget: false,
                  assertions: [
                    "当前状态([[people/user]]#脚踝, 彻底康复)",
                  ],
                },
              ],
              rapport_rules: [
                {
                  section: "语感与边界默契",
                  predicate_line:
                    '默契([[people/user]], "报喜不报忧，身体恢复后会第一时间安抚我")',
                  source_event_id: validLogId,
                },
              ],
            }),
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        return {
          text: "太好了，那周末总算能出去透透气了。",
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
      async generateSandwich(_req: SandwichRequest): Promise<LLMResponse> {
        return {
          text: "太好了，那周末总算能出去透透气了。",
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
    };

    const router = new OrganModelRouter({
      frontstage: { provider: mockProvider, model: "claude-opus-5-5" },
      endocrine: { provider: mockProvider, model: "claude-haiku-5-5" },
      compiler: { provider: mockProvider, model: "claude-opus-5-5" },
      worker: { provider: mockProvider, model: "claude-sonnet-5-5" },
    });

    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir: tmpMemDir,
      persona: {
        name: "阿狸",
        archetype: "steady_anchor",
        chronotype: "regular",
      },
      router,
    });

    // Daytime interaction turn (Loop 1)
    await engine.onUserMessage("跟你说个好消息，我的脚踝今天彻底消肿不疼了！");

    // Advance to bedtime (23:45) and run Sleep Cycle (Loop 3)
    clock.advanceHours(3.75);
    const sleepOut = await engine.runSleepCycle();

    expect(sleepOut.coldReflection).toContain("悬了好几天的心总算放了下来");
    expect(sleepOut.lintReport.passed).toBe(true);
    expect(sleepOut.compileResult.writtenFiles).toContain(
      "events/2026-11-10-ankle-recovered.md",
    );
    expect(sleepOut.compileResult.addedRapportRules.length).toBe(1);
    expect(sleepOut.gitCommitHash).not.toBeNull();

    // Verify compiled file exists and contains the frontstage bedtime reflection
    const compiledEvent = fs.readFileSync(
      path.join(tmpMemDir, "events", "2026-11-10-ankle-recovered.md"),
      "utf8",
    );
    expect(compiledEvent).toContain("悬了好几天的心总算放了下来");

    fs.rmSync(tmpMemDir, { recursive: true, force: true });
    db.close();
  });

  test("6. Review regressions: Night-0 strength retention, multi-slot supersedes, concern narrative preservation, path re-ID & anti-rumination on conflict events", async () => {
    const clock = new VirtualClock("2026-11-01T23:30:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const memDir = createTempMemoryRepo();

    const log1 = db.appendEventLog({
      id: "log-20261101-2000-001",
      timestamp: "2026-11-01T20:00:00.000Z",
      role: "user",
      speaker: "user",
      content: "这周在赶项目，膝盖也有点旧伤不舒服",
    });
    const log2 = db.appendEventLog({
      id: "log-20261101-2100-002",
      timestamp: "2026-11-01T21:00:00.000Z",
      role: "user",
      speaker: "user",
      content: "刚才在电话里吵了两句，挂了电话心里不痛快",
    });

    db.upsertConcern({
      id: "con-phone-spat",
      tier: "conflict",
      status: "有效",
      summary: "电话里拌嘴不欢而散",
      source_event_id: log2.id,
      created_at: "2026-11-01T21:00:00.000Z",
      updated_at: "2026-11-01T21:00:00.000Z",
      floor_cort: 0.42,
      cap_ox: 1.0,
      has_prep: false,
    });

    // Night 0: Compile two separate slot files + 1 ephemeral chat file + 1 conflict event file
    const profile = resolvePersonaProfile({
      archetype: "cat_aloof",
      chronotype: "regular",
    });
    const verdict0 = settleNightlyConcerns({ db, profile, now: clock.now() });

    await runNightlyCompiler({
      memoryDir: memDir,
      db,
      now: clock.now(),
      dateStr: "2026-11-01",
      verdict: verdict0,
      coldReflection: "今晚和他因为电话拌嘴心里有点堵，但也惦记着他赶项目和膝盖旧伤。",
      planOverride: {
        memories: [
          {
            rel_path: "events/2026-11-01-work-busy.md",
            id: "evt-work-busy",
            type: "状态变更",
            date: "2026-11-01",
            status: "有效",
            source_event_id: log1.id,
            category: "schedule",
            allow_forget: true,
            assertions: ["当前状态([[people/user]]#工作节奏, 赶项目繁忙)"],
          },
          {
            rel_path: "events/2026-11-01-knee-ache.md",
            id: "evt-knee-ache",
            type: "状态变更",
            date: "2026-11-01",
            status: "有效",
            source_event_id: log1.id,
            category: "health",
            allow_forget: true,
            assertions: ["当前状态([[people/user]]#膝盖, 旧伤隐痛)"],
          },
          {
            rel_path: "events/2026-11-01-late-snack.md",
            id: "evt-late-snack",
            type: "事件记录",
            date: "2026-11-01",
            status: "有效",
            source_event_id: log1.id,
            category: "chat",
            allow_forget: true,
            assertions: ["日常([[people/user]], 随口提了句想吃宵夜)"],
          },
          {
            rel_path: "events/2026-11-01-phone-conflict-evt.md",
            id: "evt-phone-conflict",
            type: "事件记录",
            date: "2026-11-01",
            status: "有效",
            source_event_id: log2.id,
            category: "life_event",
            allow_forget: true,
            assertions: ["冲突([[people/user]], 电话拌嘴挂断)"],
          },
        ],
        rapport_rules: [],
      },
    });

    // Run Night 0 decay right after compilation (as in runSleepCycle Step 4):
    // Newly compiled Day-0 memories MUST stay at INITIAL_MEMORY_STRENGTH (0.75)!
    const decayNight0 = runDailyMemoryDecayAndArchive({
      memoryDir: memDir,
      db,
      now: clock.now(),
    });
    expect(decayNight0.archivedIds).toEqual([]);
    expect(db.getMemoryMeta("evt-late-snack")?.strength).toBe(
      INITIAL_MEMORY_STRENGTH,
    );

    // Recalling the conflict-linked event `evt-phone-conflict` on a calm turn must NOT boost its strength (+0.05 anti-rumination guard)
    reconsolidateRecalledMemories({
      db,
      memoryDir: memDir,
      recalledItems: [
        {
          id: "evt-phone-conflict",
          symbolKey: "events/2026-11-01-phone-conflict-evt",
          relPath: "events/2026-11-01-phone-conflict-evt.md",
          type: "事件记录",
          category: "life_event",
          status: "有效",
          date: "2026-11-01",
          summary: "电话拌嘴",
          bucket: "bucket_a_mainline",
          score: 0.75,
          scoreBreakdown: { sem: 0.5, kw: 0.5, graph: 0.5, time: 1, strength: 0.75 },
        },
      ],
      isNegativeOrConflictTurn: false,
      now: clock.now(),
    });
    expect(db.getMemoryMeta("evt-phone-conflict")?.strength).toBe(
      INITIAL_MEMORY_STRENGTH,
    );
    expect(db.getMemoryMeta("evt-phone-conflict")?.access_count).toBe(1);

    // Advance 5 days to 2026-11-06:
    // 1) T2 concern transitions to `僵持待解`, but its `## 前台原叙` from 2026-11-01 MUST be preserved!
    // 2) A single new event updates BOTH `#工作节奏` and `#膝盖` slots at once (multi-slot conflict) and passes self-supersedes guard
    // 3) Re-compiling an existing rel_path (`events/2026-11-01-late-snack.md`) with a new id & category updates memory_meta cleanly
    clock.advanceDays(5);
    const logDay5 = db.appendEventLog({
      id: "log-20261106-2000-001",
      timestamp: "2026-11-06T20:00:00.000Z",
      role: "user",
      speaker: "user",
      content: "项目终于上线交差了，膝盖贴了膏药也完全不疼了",
    });

    const verdictDay5 = settleNightlyConcerns({ db, profile, now: clock.now() });
    const compileDay5 = await runNightlyCompiler({
      memoryDir: memDir,
      db,
      now: clock.now(),
      dateStr: "2026-11-06",
      verdict: verdictDay5,
      coldReflection: "今天各自忙完，平平淡淡。",
      planOverride: {
        memories: [
          {
            rel_path: "events/2026-11-06-both-recovered.md",
            id: "evt-both-recovered",
            type: "状态变更",
            date: "2026-11-06",
            status: "有效",
            // Self-supersedes should be ignored, and both evt-work-busy & evt-knee-ache must be superseded
            supersedes: "evt-both-recovered",
            source_event_id: logDay5.id,
            category: "health",
            allow_forget: false,
            assertions: [
              "当前状态([[people/user]]#工作节奏, 项目已上线轻松)",
              "当前状态([[people/user]]#膝盖, 贴膏药后痊愈)",
            ],
          },
          {
            rel_path: "events/2026-11-01-late-snack.md",
            id: "evt-late-snack-renamed",
            type: "事件记录",
            date: "2026-11-01",
            status: "有效",
            source_event_id: log1.id,
            category: "preference",
            allow_forget: true,
            assertions: ["偏好([[people/user]], 夜里爱吃清淡宵夜)"],
          },
        ],
        rapport_rules: [],
      },
    });

    expect(compileDay5.lintReport.passed).toBe(true);
    expect(compileDay5.supersededIds).toContain("evt-work-busy");
    expect(compileDay5.supersededIds).toContain("evt-knee-ache");
    expect(db.getMemoryMeta("evt-late-snack-renamed")?.category).toBe(
      "preference",
    );

    // Check that the concern file kept its original Day-0 narrative ("今晚和他因为电话拌嘴心里有点堵...")
    const concernContent = fs.readFileSync(
      path.join(memDir, "concerns", "2026-11-01-con-phone-spat.md"),
      "utf8",
    );
    expect(concernContent).toContain("今晚和他因为电话拌嘴心里有点堵");
    expect(concernContent).toContain("僵持待解");

    const finalLint = runMemoryLinter({
      memoryDir: memDir,
      db,
      now: clock.now(),
    });
    expect(finalLint.passed).toBe(true);

    fs.rmSync(memDir, { recursive: true, force: true });
    db.close();
  });
});
