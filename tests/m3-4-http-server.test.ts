import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { assertNoInternalLeaks } from "../src/core/schemas.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import type { LLMProvider } from "../src/llm/types.ts";
import { EchoreEngine } from "../src/loop/engine.ts";
import { createEchoreHttpApp } from "../src/loop/http-server.ts";

function setupHttpTestApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-m3-4-"));
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

  const mockProvider: LLMProvider = {
    providerName: "mock-http-server",
    async generate() {
      return {
        text: "我趁着闲暇翻了几页手记，顺便把今天想聊的事记了下来。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
    async generateSandwich() {
      return {
        text: "听见啦，我刚刚泡好热茶，正想听你说说今天的事呢。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
  };

  const clock = new VirtualClock("2026-11-10T14:00:00");
  const db = new EchoreDatabase({ dbPath: ":memory:", clock });
  const router = new OrganModelRouter({ defaultProvider: mockProvider });
  const engine = new EchoreEngine({
    clock,
    db,
    memoryDir,
    persona: {
      name: "林栖",
      archetype: "cat_aloof",
      chronotype: "regular",
    },
    router,
  });

  const app = createEchoreHttpApp({ engine });

  return {
    tmpDir,
    memoryDir,
    clock,
    db,
    engine,
    app,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("M3.4 主场模式极薄 HTTP + SSE 服务层 (Companion vs Observatory 双通道)", () => {
  test("1. 陪伴主视图通道 (GET /api/companion/state & POST /api/chat)：严守零浮点数与零 log-* 主键泄露", async () => {
    const ctx = setupHttpTestApp();
    try {
      // 1) POST /api/chat 触发环 1
      const chatRes = await ctx.app.fetch(
        new Request("http://localhost:3377/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "今天下午终于把那个棘手的接口重构完了",
            weather: {
              condition: "heavy_rain",
              temperatureC: 12,
              previousTemperatureC: 20,
            },
          }),
        }),
      );
      expect(chatRes.status).toBe(200);
      const chatJson = (await chatRes.json()) as {
        reply: string;
        currentDate: string;
        currentTime: string;
      };
      expect(chatJson.reply).toContain("泡好热茶");
      expect(chatJson.currentDate).toBe("2026-11-10");
      expect(chatJson.currentTime).toBe("14:00");
      expect(() =>
        assertNoInternalLeaks(JSON.stringify(chatJson), "test.http.chat"),
      ).not.toThrow();
      // 陪伴接口绝不返回底层 hormoneState 数字或 userEventId
      expect("hormoneState" in chatJson).toBe(false);
      expect("userEventId" in chatJson).toBe(false);

      // 2) GET /api/companion/state 返回公开陪伴态与历史消息列表
      const stateRes = await ctx.app.fetch(
        new Request("http://localhost:3377/api/companion/state"),
      );
      expect(stateRes.status).toBe(200);
      const stateJson = (await stateRes.json()) as {
        personaName: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(stateJson.personaName).toBe("林栖");
      expect(stateJson.messages).toHaveLength(2);
      expect(() =>
        assertNoInternalLeaks(JSON.stringify(stateJson), "test.http.companion"),
      ).not.toThrow();
    } finally {
      ctx.cleanup();
    }
  });

  test("2. 观测台与时间快进通道 (GET /api/observatory/state, POST /api/heartbeat, POST /api/fast-forward, POST /api/sleep)", async () => {
    const ctx = setupHttpTestApp();
    try {
      // 1) GET /api/observatory/state
      const obsRes = await ctx.app.fetch(
        new Request("http://localhost:3377/api/observatory/state"),
      );
      expect(obsRes.status).toBe(200);
      const obsJson = (await obsRes.json()) as {
        hormoneState: { dopamine: number };
        lintReport: { passed: boolean };
      };
      expect(typeof obsJson.hormoneState.dopamine).toBe("number");
      expect(obsJson.lintReport.passed).toBe(true);

      // 2) POST /api/fast-forward 快进 4h
      const ffRes = await ctx.app.fetch(
        new Request("http://localhost:3377/api/fast-forward", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duration: "4h", stepMinutes: 30 }),
        }),
      );
      expect(ffRes.status).toBe(200);
      const ffJson = (await ffRes.json()) as {
        elapsedHours: number;
        totalTicks: number;
      };
      expect(ffJson.elapsedHours).toBe(4);
      expect(ffJson.totalTicks).toBe(8);

      // 3) POST /api/sleep 手动触发环 3
      const sleepRes = await ctx.app.fetch(
        new Request("http://localhost:3377/api/sleep", {
          method: "POST",
        }),
      );
      expect(sleepRes.status).toBe(200);
      const sleepJson = (await sleepRes.json()) as {
        lintReport: { passed: boolean };
      };
      expect(sleepJson.lintReport.passed).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });

  test("3. SSE 实时事件流 (GET /api/events)：实时推送 connected 与 proactive_message 并在断开时清理订阅", async () => {
    const ctx = setupHttpTestApp();
    try {
      const abortController = new AbortController();
      const sseRes = await ctx.app.fetch(
        new Request("http://localhost:3377/api/events", {
          signal: abortController.signal,
        }),
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("Content-Type")).toContain("text/event-stream");
      expect(ctx.app.getSubscriberCount()).toBe(1);

      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();

      // 读取首帧 connected 握手事件
      const firstChunk = await reader.read();
      const firstText = decoder.decode(firstChunk.value);
      expect(firstText).toContain("event: connected");

      // 触发一次暴雨主动破冰心跳，验证 SSE 收到 proactive_message 且零内部泄露
      await ctx.app.fetch(
        new Request("http://localhost:3377/api/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            weather: {
              condition: "storm",
              temperatureC: 11,
              previousTemperatureC: 21,
            },
            overrideProactiveText: "外面突然刮起雷暴大风了，你窗户关好了吗？",
          }),
        }),
      );

      const secondChunk = await reader.read();
      const secondText = decoder.decode(secondChunk.value);
      expect(secondText).toContain("event: proactive_message");
      expect(secondText).toContain("你窗户关好了吗");
      expect(() =>
        assertNoInternalLeaks(secondText, "test.sse.proactive"),
      ).not.toThrow();

      await reader.cancel();
      expect(ctx.app.getSubscriberCount()).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });
});
