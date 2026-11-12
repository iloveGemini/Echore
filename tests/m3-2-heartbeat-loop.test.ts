import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { EchoreEngine } from "../src/loop/engine.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import type { LLMProvider } from "../src/llm/types.ts";

function createTestEnv(initialTimeIso = "2026-11-10T14:00:00") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-m3-2-"));
  const memoryDir = path.join(tmpDir, "memory");
  fs.mkdirSync(path.join(memoryDir, "people"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "events"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "concerns"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "implicit"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "journal"), { recursive: true });

  fs.writeFileSync(
    path.join(memoryDir, "people", "user.md"),
    [
      "---",
      "id: user",
      "type: 符号定义",
      "date: 2026-11-01",
      "status: 有效",
      "category: preference",
      "allow_forget: false",
      "---",
      "定义([[people/user]], 主互动伙伴)",
      "",
    ].join("\n"),
    "utf8",
  );

  let llmCallCount = 0;
  const mockProvider: LLMProvider = {
    providerName: "mock-m3-2",
    async generate() {
      llmCallCount += 1;
      return {
        text: "我刚忙完手头的事，顺手看看你那边怎么样。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
    async generateSandwich() {
      llmCallCount += 1;
      return {
        text: "我正好趁下午空闲帮你查好了杭州出差的住宿备忘，都在这儿了。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
  };

  const clock = new VirtualClock(initialTimeIso);
  const db = new EchoreDatabase({ dbPath: ":memory:", clock });
  const router = new OrganModelRouter({ defaultProvider: mockProvider });
  const engine = new EchoreEngine({
    clock,
    db,
    memoryDir,
    persona: {
      name: "沈清",
      archetype: "steady_anchor",
      chronotype: "regular",
    },
    router,
  });

  // Set daytime timestamp (local hour 14:00) so it's never inside sleep lock window
  const localDaytime = new Date(2026, 10, 10, 14, 0, 0);
  clock.setNow(localDaytime);
  db.saveHormoneState({
    ...db.getHormoneState(),
    melatonin: 0.08,
    updated_at: clock.nowIso(),
  });

  return {
    tmpDir,
    memoryDir,
    clock,
    db,
    engine,
    getLlmCallCount: () => llmCallCount,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("M3.2 【环 2：自主心跳环】与三环咬合", () => {
  test("1. 分支 C (idle)：激素平稳且无边际感知事件时零 LLM 消耗直接结束本跳", async () => {
    const env = createTestEnv();
    try {
      // 刚初始化时激素位于舒适基线 B_h，无天气突变
      const hb = await env.engine.onHeartbeat({
        weather: { condition: "clear", temperatureC: 22, previousTemperatureC: 23 },
      });

      expect(hb.branch).toBe("idle");
      expect(env.getLlmCallCount()).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  test("2. 分支 B (solitary) 与【环 1】联动：多巴胺跌入无聊区触发 S3 暗中准备，用户上线发消息时自动回捞并核销 has_prep", async () => {
    const env = createTestEnv();
    try {
      // 写入一条活跃日常惦记 (has_prep: false)
      const userLog = env.db.appendEventLog({
        role: "user",
        speaker: "user",
        content: "这周末想去杭州待两天，还没查住哪儿",
      });
      env.db.upsertConcern({
        id: "weekend-hangzhou-plan",
        tier: "minor_worry",
        status: "有效",
        summary: "用户周末去杭州，还没查住宿路线",
        source_event_id: userLog.id,
        created_at: env.clock.nowIso(),
        updated_at: env.clock.nowIso(),
        floor_cort: 0.12,
        cap_ox: 1.0,
        has_prep: false,
      });

      // 将多巴胺压入无聊区 [F_da, B_da)，保持催产素位于舒适基线 B_ox（不触发想念破冰）
      const currentH = env.db.getHormoneState();
      env.db.saveHormoneState({
        ...currentH,
        oxytocin: env.engine.profile.baseline.oxytocin,
        dopamine: env.engine.profile.resting_floor.dopamine + 0.04,
        updated_at: env.clock.nowIso(),
      });

      const hb = await env.engine.onHeartbeat({
        overrideSolitaryNoteText:
          "我记着他周末要去杭州，趁这会儿清闲帮他挑了两家靠近西湖又安静的民宿记在备忘里。",
      });

      expect(hb.branch).toBe("solitary");
      expect(hb.solitaryResult?.actionKind).toBe("secret_prep");
      expect(hb.solitaryResult?.preppedConcernId).toBe("weekend-hangzhou-plan");
      // 多巴胺已回血至 B_da
      expect(hb.hormoneState.dopamine).toBeGreaterThanOrEqual(
        env.engine.profile.baseline.dopamine,
      );
      expect(env.db.getConcernById("weekend-hangzhou-plan")?.has_prep).toBe(
        true,
      );

      // 回归：下一跳心跳因 secret_prep_ready 触发主动破冰招呼时，不提前抹除 has_prep，
      // 确保用户随后回复进入环 1 (onUserMessage) 时仍能拿到完整 secretPrepNote
      env.clock.advanceMinutes(15);
      const hbProactiveTeaser = await env.engine.onHeartbeat({
        overrideProactiveText: "下午顺手帮你看了眼杭州住的地方，等你忙完跟你说。",
      });
      expect(hbProactiveTeaser.branch).toBe("proactive");
      expect(hbProactiveTeaser.proactiveTrigger).toBe("secret_prep_ready");
      expect(env.db.getConcernById("weekend-hangzhou-plan")?.has_prep).toBe(
        true,
      );

      // 用户随后发来消息触发【环 1：实时交互环】，验证自动回捞 secretPrepNote 并核销 has_prep
      const turnOut = await env.engine.onUserMessage("我忙完了，周末去杭州的事你觉得住哪好？", {
        pulseOverride: {
          event_summary: "用户聊起周末杭州住宿",
          confidence: 0.92,
          is_warm: true,
          oxytocin_delta: 0.05,
        },
      });

      expect(turnOut.consumedPrepConcernIds).toContain("weekend-hangzhou-plan");
      expect(
        turnOut.sandwichRequest.dynamicTail.subconsciousBlock,
      ).toContain("靠近西湖又安静的民宿");
      // 核销后 has_prep 归为 false，防止重复献宝
      expect(env.db.getConcernById("weekend-hangzhou-plan")?.has_prep).toBe(
        false,
      );
    } finally {
      env.cleanup();
    }
  });

  test("3. 分支 A (proactive)：天气剧变/久坐触发主动破冰、24h 冷却锁、连续 2 次未回退避锁与冷战封顶拦截", async () => {
    const env = createTestEnv();
    try {
      // 第 1 次主动破冰：暴雨骤降触发
      const hb1 = await env.engine.onHeartbeat({
        weather: {
          condition: "heavy_rain",
          temperatureC: 12,
          previousTemperatureC: 21,
        },
        overrideProactiveText: "我看窗外突然下起暴雨还降温了，你今天出门带伞了吗？",
      });

      expect(hb1.branch).toBe("proactive");
      expect(hb1.proactiveTrigger).toBe("weather_or_long_focus");
      expect(hb1.reflexState.consecutive_unanswered_proactive).toBe(1);
      expect(hb1.reflexState.proactive_lock).toBe(false);

      // 15 分钟后再跳：处于 24h 主动冷却窗内，绝不连续轰炸
      env.clock.advanceMinutes(15);
      const hbCooldown = await env.engine.onHeartbeat({
        weather: {
          condition: "heavy_rain",
          temperatureC: 12,
          previousTemperatureC: 21,
        },
      });
      expect(hbCooldown.branch).not.toBe("proactive");
      expect(hbCooldown.reflexEvaluation.proactiveCooldownLocked).toBe(true);

      // 快进 25 小时跨过冷却窗（仍在白天 15:15），用户仍未回 -> 触发第 2 次主动破冰，满 2 次立即锁死 proactive_lock
      env.clock.advanceHours(25);
      const hb2 = await env.engine.onHeartbeat({
        overrideProactiveText: "看你忙了一天还没动静，顺手放杯热茶在这儿。",
      });
      expect(hb2.branch).toBe("proactive");
      expect(hb2.reflexState.consecutive_unanswered_proactive).toBe(2);
      expect(hb2.reflexState.proactive_lock).toBe(true);

      // 再快进 25 小时：即使跨过 24h 且暴雨，因连续 2 次未回退避锁生效，严禁再发第 3 条主动消息
      env.clock.advanceHours(25);
      const hbLocked = await env.engine.onHeartbeat({
        weather: {
          condition: "storm",
          temperatureC: 10,
          previousTemperatureC: 20,
        },
      });
      expect(hbLocked.branch).not.toBe("proactive");
      expect(hbLocked.reflexEvaluation.proactiveUnansweredLocked).toBe(true);

      // 用户主动发来消息 -> 立即解除退避锁，但若同时爆发冲突进入冷战封顶，依然拦截主动破冰
      await env.engine.onUserMessage("抱歉前两天太忙了", {
        pulseOverride: {
          event_summary: "用户回复解释忙碌",
          confidence: 0.9,
          is_warm: true,
        },
      });
      expect(env.db.getReflexState().proactive_lock).toBe(false);

      // 注入一条 T2 冷战僵持牵挂，验证冷战期严禁触发主动破冰
      env.db.upsertConcern({
        id: "cold-war-test",
        tier: "conflict",
        status: "僵持待解",
        summary: "双方就失约问题仍在冷战僵持",
        source_event_id: "log-20261110-1400-001",
        created_at: env.clock.nowIso(),
        updated_at: env.clock.nowIso(),
        floor_cort: 0.25,
        cap_ox: 0.45,
        has_prep: false,
      });
      const hbColdWar = await env.engine.onHeartbeat({
        weather: {
          condition: "heavy_rain",
          temperatureC: 11,
          previousTemperatureC: 20,
        },
      });
      expect(hbColdWar.branch).not.toBe("proactive");
    } finally {
      env.cleanup();
    }
  });

  test("4. 入睡闸门：夜间跨入睡眠锁且今日未冷写时自动触发【环 3：昼夜新陈代谢环】，同夜不重复触发", async () => {
    const env = createTestEnv();
    try {
      // 白天先聊一句留下热记事
      await env.engine.onUserMessage("今天下午试了家很棒的手冲咖啡店", {
        pulseOverride: {
          event_summary: "用户分享下午去了手冲咖啡店",
          confidence: 0.95,
          is_warm: true,
        },
      });

      // 将时钟推进至当日深夜 02:00（regular 作息睡眠锁窗口 01:00 ~ 08:00）
      const nightTime = new Date(2026, 10, 10, 2, 0, 0);
      env.clock.setNow(nightTime);

      const hbSleep = await env.engine.onHeartbeat({
        sleepCycleOptions: {
          overrideReflectionText: "今天听他聊起下午去的手冲咖啡店，心情很放松，准备睡了。",
          compilationPlanOverride: {
            memories: [],
            rapport_rules: [],
          },
          autoGitCommit: false,
        },
      });

      expect(hbSleep.branch).toBe("sleep_cycle");
      expect(hbSleep.sleepCycleOutput?.coldReflection).toContain("手冲咖啡店");
      expect(hbSleep.sleepCycleOutput?.lintReport.passed).toBe(true);

      // 15 分钟后（02:15）再次心跳：因今日已写过睡前冷叙事，不再重复跑环 3，直接进入静默睡眠呼吸 (idle)
      env.clock.advanceMinutes(15);
      const hbAfterSleep = await env.engine.onHeartbeat();
      expect(hbAfterSleep.branch).toBe("idle");
    } finally {
      env.cleanup();
    }
  });
  test("5. 跨午夜起居日封底与单调睡眠游标：01:00 准确封底昨日、07:00 晨起开启今日新日记且不沦为记忆孤儿、早鸟午夜后不倒流", async () => {
    const env = createTestEnv();
    try {
      // 白天 14:00 发生真实交互
      const turnDay1 = await env.engine.onUserMessage("我最近每天早晨都喝曼特宁手冲咖啡", {
        pulseOverride: {
          event_summary: "用户分享每天早晨喝曼特宁手冲",
          confidence: 0.95,
          is_warm: true,
        },
      });

      // 跨过午夜抵达 00:30（尚未入睡）：熬夜聊天仍归入 2026-11-10 日记
      env.clock.advanceHours(10.5); // 14:00 + 10.5h = 次日 00:30
      expect(env.clock.todayStr()).toBe("2026-11-11");
      expect(env.engine.getCircadianDateStr()).toBe("2026-11-10");
      const turnLateNight = await env.engine.onUserMessage("今晚熬夜把出差行李也收拾好了");

      const day1JournalPath = path.join(env.memoryDir, "journal", "2026-11-10.md");
      expect(fs.existsSync(day1JournalPath)).toBe(true);
      const day1BeforeSleep = fs.readFileSync(day1JournalPath, "utf8");
      expect(day1BeforeSleep).toContain("曼特宁手冲咖啡");
      expect(day1BeforeSleep).toContain("出差行李");

      // 推进 30 分钟抵达次日凌晨 01:00（进入 regular 睡眠锁 01:00~08:00）
      env.clock.advanceMinutes(30);
      expect(env.engine.getCircadianDateStr()).toBe("2026-11-10");

      // 触发心跳：锁定 2026-11-10 执行冷闭环，推进睡眠游标至 00:30 最后一条事件
      const hbSleep1 = await env.engine.onHeartbeat({
        sleepCycleOptions: {
          compilationPlanOverride: {
            memories: [
              {
                id: "evt-manning-coffee",
                type: "事件记录",
                rel_path: "events/2026-11-10-manning-coffee.md",
                category: "preference",
                date: "2026-11-10",
                status: "有效",
                source_event_id: turnDay1.userEventId,
                assertions: ["- 偏好([[people/user]]#咖啡, \"曼特宁手冲\")"],
                frontstage_narrative: "今天和他就“我最近每天早晨都喝曼特宁手冲咖啡”聊了几句",
              },
            ],
            rapport_rules: [],
          },
          autoGitCommit: false,
        },
      });

      expect(hbSleep1.branch).toBe("sleep_cycle");
      expect(hbSleep1.sleepCycleOutput?.dateStr).toBe("2026-11-10");
      expect(hbSleep1.sleepCycleOutput?.compileResult.writtenFiles).toContain(
        "events/2026-11-10-manning-coffee.md",
      );
      expect(env.db.getReflexState().last_sleep_event_id).toBe(
        turnLateNight.assistantEventId,
      );
      expect(env.db.getUnsettledEventLogs().length).toBe(0);

      // 验证 2026-11-10.md 完整落盘了睡前自省，而 2026-11-11.md 尚未被虚假占位
      const day1JournalAfterSleep = fs.readFileSync(day1JournalPath, "utf8");
      expect(day1JournalAfterSleep).toContain("## 睡前自省");
      const day2JournalPath = path.join(env.memoryDir, "journal", "2026-11-11.md");
      expect(fs.existsSync(day2JournalPath)).toBe(false);

      // 15 分钟后（01:15）再次心跳：因昨日起居日已封底，同夜不再重复跑睡眠环
      env.clock.advanceMinutes(15);
      const hbFollowup = await env.engine.onHeartbeat();
      expect(hbFollowup.branch).toBe("idle");

      // 关键临界点：清晨 07:00（仍在 sleepLockEndHour 08:00 之前）用户提早醒来发消息！
      // 因 2026-11-10 已完成睡前自省封底，07:00 必须归入 2026-11-11 新日记，绝不倒流污染 2026-11-10.md，且进入未结转游标队列
      env.clock.advanceHours(5.75); // 01:15 + 5h45m = 07:00
      expect(env.engine.getCircadianDateStr()).toBe("2026-11-11");
      const turnEarlyMorning = await env.engine.onUserMessage("早安！今天早上七点我就起来背单词了");

      expect(fs.existsSync(day2JournalPath)).toBe(true);
      expect(fs.readFileSync(day2JournalPath, "utf8")).toContain("早上七点我就起来背单词了");
      expect(fs.readFileSync(day1JournalPath, "utf8")).not.toContain("早上七点我就起来背单词了");

      // 07:15 心跳（仍在 08:00 前）：即便今日已产生 07:00 热记事，因当夜已封底，绝不在清晨 07:15 误触发第二次睡眠环
      env.clock.advanceMinutes(15);
      const hbMorning = await env.engine.onHeartbeat();
      expect(hbMorning.branch).toBe("idle");

      // 07:00 的早起对话必须留在未结转游标队列中，绝不成为“记忆孤儿”
      const unsettledAfterMorning = env.db.getUnsettledEventLogs();
      expect(unsettledAfterMorning.some((e) => e.id === turnEarlyMorning.userEventId)).toBe(true);

      // 次夜 01:00（2026-11-12 01:00）触发第 2 晚睡眠环：07:00 晨起事件被单调游标完整收入编译
      env.clock.advanceHours(17.75); // 07:15 + 17h45m = 次日 01:00
      const hbSleep2 = await env.engine.onHeartbeat({
        sleepCycleOptions: {
          compilationPlanOverride: {
            memories: [
              {
                id: "evt-early-vocab",
                type: "事件记录",
                rel_path: "events/2026-11-11-early-vocab.md",
                category: "schedule",
                date: "2026-11-11",
                status: "有效",
                source_event_id: turnEarlyMorning.userEventId,
                assertions: ["- 当前状态([[people/user]]#晨间习惯, \"早晨七点起床背单词\")"],
                frontstage_narrative: "今天和他就“早安！今天早上七点我就起来背单词了”聊了几句",
              },
            ],
            rapport_rules: [],
          },
          autoGitCommit: false,
        },
      });
      expect(hbSleep2.branch).toBe("sleep_cycle");
      expect(hbSleep2.sleepCycleOutput?.dateStr).toBe("2026-11-11");
      expect(hbSleep2.sleepCycleOutput?.compileResult.writtenFiles).toContain(
        "events/2026-11-11-early-vocab.md",
      );
      expect(env.db.getUnsettledEventLogs().length).toBe(0);

      // 验证早鸟作息 (early_bird: 23:30~06:30) 午夜前 23:30 入睡封底后，跨过午夜 00:30 绝不倒流回昨日
      env.engine.updatePersona({
        name: "沈清",
        archetype: "steady_anchor",
        chronotype: "early_bird",
      });
      env.clock.setNow(new Date(2026, 10, 12, 23, 30, 0)); // 2026-11-12 23:30
      const hbEarlyBirdSleep = await env.engine.onHeartbeat({
        sleepCycleOptions: {
          overrideReflectionText: "早鸟十一点半准时睡了。",
          compilationPlanOverride: { memories: [], rapport_rules: [] },
          autoGitCommit: false,
        },
      });
      expect(hbEarlyBirdSleep.branch).toBe("sleep_cycle");
      expect(hbEarlyBirdSleep.sleepCycleOutput?.dateStr).toBe("2026-11-12");

      // 推进 1 小时至 2026-11-13 00:30：早鸟昨夜已封底，起居日直接为 2026-11-13
      env.clock.advanceHours(1);
      expect(env.engine.getCircadianDateStr()).toBe("2026-11-13");
    } finally {
      env.cleanup();
    }
  });
});
