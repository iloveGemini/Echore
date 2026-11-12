import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import {
  listPrompts,
  PROMPTS_DIR,
  parsePrompt,
  readPrompt,
} from "../src/core/prompts.ts";
import { assertNoInternalLeaks } from "../src/core/schemas.ts";
import { resolvePersonaProfile } from "../src/endocrine/archetypes.ts";
import { buildStaticSystemPartA } from "../src/frontstage/performer.ts";
import {
  evaluateReflexGuard,
  recordProactiveSent,
  recordUserMessageReceived,
} from "../src/reflex/guard.ts";

describe("Core: VirtualClock, SQLite & Sovereignty Leak Guard", () => {
  test("VirtualClock advances time deterministically and formats log IDs", () => {
    const clock = new VirtualClock("2026-11-10T10:30:00.000Z");
    expect(clock.nowIso()).toBe("2026-11-10T10:30:00.000Z");
    const id1 = clock.formatLogId();
    expect(id1).toMatch(/^log-20261110-\d{4}-001$/);

    clock.advanceHours(4);
    expect(clock.nowIso()).toBe("2026-11-10T14:30:00.000Z");

    clock.advanceDays(5);
    expect(clock.nowIso()).toBe("2026-11-15T14:30:00.000Z");
  });

  test("assertNoInternalLeaks blocks log-* primary keys and hormone floats", () => {
    expect(() =>
      assertNoInternalLeaks("今天心情还不错，刚才看了一章书。"),
    ).not.toThrow();

    expect(() =>
      assertNoInternalLeaks("引用事件 log-20261105-2140 的对话"),
    ).toThrow(/SovereigntyViolation/);

    expect(() =>
      assertNoInternalLeaks("当前状态 cortisol: 0.65, oxytocin: 0.42"),
    ).toThrow(/SovereigntyViolation/);

    expect(() =>
      assertNoInternalLeaks("皮质醇：0.48"),
    ).toThrow(/SovereigntyViolation/);

    expect(() =>
      assertNoInternalLeaks("我感觉皮质醇已经升到了 0.72"),
    ).toThrow(/SovereigntyViolation/);
  });

  test("EchoreDatabase stores EventLog, FTS5, HormoneState, ReflexState and Concerns", () => {
    const clock = new VirtualClock("2026-11-10T20:15:00");
    expect(clock.todayStr()).toBe("2026-11-10");
    expect(clock.formatLogId(1)).toBe("log-20261110-2015-001");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });

    const evt = db.appendEventLog({
      id: "log-20261110-1200-001",
      role: "user",
      speaker: "user",
      content: "我脚踝今天终于彻底消肿不疼了",
    });
    expect(evt.id).toBe("log-20261110-1200-001");
    expect(db.getEventLogById("log-20261110-1200-001")?.content).toContain(
      "脚踝",
    );

    const ftsHits = db.searchEventLogsFts("脚踝");
    expect(ftsHits.length).toBe(1);
    expect(ftsHits[0]?.id).toBe("log-20261110-1200-001");

    // Natural sentence query with particles ("吗", "了") also matches via stop-particle filtering & OR fallback
    const naturalHits = db.searchEventLogsFts("今天脚踝还疼吗");
    expect(naturalHits.length).toBe(1);
    expect(naturalHits[0]?.id).toBe("log-20261110-1200-001");

    db.close();
  });
});

describe("Reflex Guard: Sleep Lock, Cooldown & 2-Strike Proactive Backoff", () => {
  test("Melatonin >= 0.75 or quiet hours locks proactive wake", () => {
    const nowDay = new Date("2026-11-10T14:00:00");
    const baseState = {
      consecutive_unanswered_proactive: 0,
      last_proactive_at: null,
      last_user_message_at: null,
      proactive_lock: false,
    };

    // High melatonin locks wake even in daytime
    const highMelEval = evaluateReflexGuard({
      reflexState: baseState,
      melatonin: 0.80,
      now: nowDay,
      chronotype: "regular",
    });
    expect(highMelEval.sleepLocked).toBe(true);
    expect(highMelEval.canProactiveWake).toBe(false);

    // Quiet hours (02:30 AM for regular chronotype [01:00 ~ 08:00]) locks wake
    const quietHourEval = evaluateReflexGuard({
      reflexState: baseState,
      melatonin: 0.30,
      now: new Date("2026-11-10T02:30:00"),
      chronotype: "regular",
    });
    expect(quietHourEval.inQuietHours).toBe(true);
    expect(quietHourEval.sleepLocked).toBe(true);
    expect(quietHourEval.canProactiveWake).toBe(false);
  });

  test("2 consecutive unanswered proactive messages lock proactive_lock until user replies", () => {
    const t0 = new Date("2026-11-10T14:00:00.000Z");
    let state = {
      consecutive_unanswered_proactive: 0,
      last_proactive_at: null as string | null,
      last_user_message_at: null as string | null,
      proactive_lock: false,
    };

    // 1st proactive message sent
    state = recordProactiveSent(state, t0.toISOString());
    expect(state.consecutive_unanswered_proactive).toBe(1);
    expect(state.proactive_lock).toBe(false);

    // 12 hours later -> blocked by 24h cooldown
    const t12h = new Date(t0.getTime() + 12 * 3600 * 1000);
    const eval12h = evaluateReflexGuard({
      reflexState: state,
      melatonin: 0.1,
      now: new Date("2026-11-11T14:00:00"), // daytime local, override last_proactive_at check
      chronotype: "regular",
    });
    expect(
      evaluateReflexGuard({
        reflexState: state,
        melatonin: 0.1,
        now: t12h,
        chronotype: "regular",
      }).proactiveCooldownLocked,
    ).toBe(true);
    expect(eval12h).toBeDefined();

    // 25 hours later -> 2nd proactive message sent
    const t25h = new Date(t0.getTime() + 25 * 3600 * 1000);
    state = recordProactiveSent(state, t25h.toISOString());
    expect(state.consecutive_unanswered_proactive).toBe(2);
    expect(state.proactive_lock).toBe(true);

    // Even 72 hours later, proactive_lock remains true!
    const t97h = new Date(t0.getTime() + 97 * 3600 * 1000);
    const evalLocked = evaluateReflexGuard({
      reflexState: state,
      melatonin: 0.1,
      now: t97h,
      chronotype: "regular",
    });
    expect(evalLocked.proactiveUnansweredLocked).toBe(true);
    expect(evalLocked.canProactiveWake).toBe(false);

    // User finally replies -> immediately unlocks proactive_lock
    state = recordUserMessageReceived(state, t97h.toISOString());
    expect(state.consecutive_unanswered_proactive).toBe(0);
    expect(state.proactive_lock).toBe(false);
  });
});

describe("Core: Prompts Loader (prompts/*.md)", () => {
  test("all 9 organ prompt files exist in prompts/, carry version >= 1, and parse cleanly", () => {
    const all = listPrompts(PROMPTS_DIR);
    const names = all.map((p) => p.name);
    expect(names).toEqual([
      "bedtime-reflection.md",
      "endocrine-pulse.md",
      "frontstage-system.md",
      "memory-compiler.md",
      "proactive-wake.md",
      "silent-worker.md",
      "solitary-prep.md",
      "solitary-project.md",
      "solitary-roaming.md",
    ]);

    for (const doc of all) {
      expect(doc.version).toBeGreaterThanOrEqual(1);
      expect(doc.text.length).toBeGreaterThan(10);
      expect(doc.organ).toBeDefined();
      expect(doc.text).not.toContain("---\nversion:");
    }
  });

  test("readPrompt reads live from custom promptsDir without restart", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-prompts-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "frontstage-system.md"),
        "---\nversion: 2\nauthor: system\norgan: frontstage\n---\n## 自定义准绳\n- 保持测试热更新生效。\n",
        "utf8",
      );

      const loaded = readPrompt("frontstage-system.md", tmpDir);
      expect(loaded.version).toBe(2);
      expect(loaded.organ).toBe("frontstage");
      expect(loaded.text).toBe("## 自定义准绳\n- 保持测试热更新生效。");

      const profile = resolvePersonaProfile({
        name: "阿澈",
        core_persona: "清冷克制的建筑师",
        archetype: "cat_aloof",
        chronotype: "regular",
      });
      const systemA = buildStaticSystemPartA(profile, tmpDir);
      expect(systemA).toContain("## 自定义准绳");
      expect(systemA).toContain("保持测试热更新生效");

      const missing = readPrompt("non-existent.md", tmpDir);
      expect(missing).toEqual({ name: "non-existent.md", text: "", version: 0 });
      expect(parsePrompt("plain text without frontmatter", "raw.md")).toEqual({
        name: "raw.md",
        text: "plain text without frontmatter",
        version: 0,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

