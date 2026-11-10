import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { assertNoInternalLeaks } from "../src/core/schemas.ts";
import { syncMemoryMetaFromFiles } from "../src/hippocampus/decay.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import type { LLMProvider } from "../src/llm/types.ts";
import { EchoreEngine } from "../src/loop/engine.ts";
import { EchoreMcpServer } from "../src/loop/mcp-server.ts";
import {
  parseDurationToMinutes,
  TimeTravelSimulator,
} from "../src/loop/simulator.ts";

function setupTestWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-m3-3-"));
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
    providerName: "mock-m3-3",
    async generate() {
      return {
        text: "我趁着独处翻了几页书，顺手把想法记在了手边。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
    async generateSandwich() {
      return {
        text: "我在呢，刚听你说完。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
  };

  const clock = new VirtualClock(new Date(2026, 10, 10, 14, 0, 0));
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

  return {
    tmpDir,
    memoryDir,
    clock,
    db,
    engine,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("M3.3 MCP 出差模式外壳与时间快进仿真台 (4h / 5d / 15d)", () => {
  test("1. MCP Server 出差外壳：暴露 4 个潜意识接口、支持 JSON-RPC 2.0 调用并严守零浮点数/零 log-* 泄露", async () => {
    const ws = setupTestWorkspace();
    try {
      // 预置 rapport.md（带 [src: log-xxx] 行级溯源）与一条历史事件记忆
      const logRec = ws.db.appendEventLog({
        id: "log-20261109-2000-001",
        timestamp: "2026-11-09T20:00:00.000Z",
        role: "user",
        speaker: "user",
        content: "我下周去京都看红叶，最怕人挤人的景点",
      });

      fs.writeFileSync(
        path.join(ws.memoryDir, "implicit", "rapport.md"),
        [
          "---",
          "id: rapport",
          "type: 内隐默契",
          "date: 2026-11-09",
          "status: 有效",
          "category: preference",
          "allow_forget: false",
          "---",
          "## 专属称呼与黑话",
          "- 默契([[people/user]]#称呼, 夜猫子搭档) [src: log-20261109-2000-001]",
          "",
        ].join("\n"),
        "utf8",
      );

      fs.writeFileSync(
        path.join(ws.memoryDir, "events", "evt-2026-1109-kyoto-trip.md"),
        [
          "---",
          "id: evt-2026-1109-kyoto-trip",
          "type: 事件记录",
          "date: 2026-11-09",
          "status: 有效",
          `source_event_id: ${logRec.id}`,
          "category: schedule",
          "allow_forget: true",
          "---",
          "计划([[people/user]]#出行, 下周去京都看红叶避开人群)",
          "",
          "## 前台原叙",
          "> 我记下他下周要去京都看红叶，他最讨厌人挤人的游客区。",
          "",
        ].join("\n"),
        "utf8",
      );
      syncMemoryMetaFromFiles({
        memoryDir: ws.memoryDir,
        db: ws.db,
        now: ws.clock.now(),
      });

      const mcp = new EchoreMcpServer(ws.engine);

      // 1) JSON-RPC tools/list
      const listResp = await mcp.handleJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const listedTools = (
        listResp.result as { tools: Array<{ name: string }> }
      ).tools.map((t) => t.name);
      expect(listedTools).toEqual([
        "echore_wake_context",
        "echore_recall",
        "echore_digest_turn",
        "echore_write_journal",
      ]);

      // 2) echore_wake_context：包含内隐默契、心境交接单与近期主线记忆，且剥离了 [src: log-*]
      const wakeResp = await mcp.handleJsonRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echore_wake_context",
          arguments: { topicHint: "京都红叶" },
        },
      });
      const wakeText = (
        wakeResp.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(wakeText).toContain("夜猫子搭档");
      expect(wakeText).toContain("当下心境基调");
      expect(wakeText).toContain("京都看红叶");
      expect(() =>
        assertNoInternalLeaks(wakeText, "test.wake"),
      ).not.toThrow();

      // 3) echore_recall：按话题召回并预水合原话引文，无 log-* 主键泄露
      const recallResp = await mcp.handleJsonRpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "echore_recall",
          arguments: { query: "京都红叶景点" },
        },
      });
      const recallText = (
        recallResp.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(recallText).toContain("最怕人挤人的景点");
      expect(() =>
        assertNoInternalLeaks(recallText, "test.recall"),
      ).not.toThrow();

      // 4) echore_digest_turn：将外部聊完的一轮喂回本地 Echore 落盘并更新情绪与热记事
      const digestOut = await mcp.digestTurn({
        userMessage: "我在 Claude Code 里把京都路线排好了，特地选了清晨六点的冷门寺院",
        assistantReply: "算你聪明，清晨六点去才听得到风吹落叶的声音。",
      });
      expect(digestOut.journalEntry).toContain("京都路线");
      expect(ws.engine.getHistory().length).toBeGreaterThanOrEqual(2);
      expect(() =>
        assertNoInternalLeaks(digestOut.handoverYaml, "test.digest"),
      ).not.toThrow();

      // 5) echore_write_journal：随手追加热记事
      const writeResp = await mcp.handleJsonRpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "echore_write_journal",
          arguments: {
            firstPersonText: "我今天陪他在外面改了一下午代码，顺便敲定了京都清晨看红叶的路线。",
            tag: "交互",
          },
        },
      });
      const writeText = (
        writeResp.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(writeText).toContain("敲定了京都清晨看红叶的路线");
    } finally {
      ws.cleanup();
    }
  });

  test("2. 时间快进仿真台 (4h / 5d / 15d)：一键验证独居攒谈资、T2 满 5 天转冷战封顶 Cap_ox 与 15 天记忆沉底", async () => {
    expect(parseDurationToMinutes("4h")).toBe(240);
    expect(parseDurationToMinutes("5d")).toBe(7200);
    expect(parseDurationToMinutes("15d")).toBe(21600);

    const ws = setupTestWorkspace();
    try {
      const sim = new TimeTravelSimulator(ws.engine);

      // --- 阶段 A：快进 4h（验证无聊区触发独居行动并产出本地物证） ---
      ws.db.saveHormoneState({
        ...ws.db.getHormoneState(),
        dopamine: ws.engine.profile.resting_floor.dopamine + 0.03,
        updated_at: ws.clock.nowIso(),
      });

      const report4h = await sim.fastForward("4h", {
        stepMinutes: 30,
        disableGitCommit: true,
      });
      expect(report4h.branchCounts.solitary).toBeGreaterThanOrEqual(1);
      expect(report4h.solitaryArtifacts.length).toBeGreaterThanOrEqual(1);
      expect(report4h.finalHormoneState.dopamine).toBeGreaterThanOrEqual(
        ws.engine.profile.baseline.dopamine,
      );

      // --- 阶段 B：注入一条 T2 急性冲突牵挂与一条 chat(7d) 记忆，快进 5d ---
      const conflictEvent = ws.db.appendEventLog({
        role: "user",
        speaker: "user",
        content: "答应你的事我又爽约了，随便你怎么想吧",
      });
      ws.db.upsertConcern({
        id: "broken-promise-t2",
        tier: "conflict",
        status: "有效",
        summary: "用户再次爽约且态度敷衍引发实质冲突",
        source_event_id: conflictEvent.id,
        created_at: ws.clock.nowIso(),
        updated_at: ws.clock.nowIso(),
        floor_cort: 0.35,
        cap_ox: 1.0,
        has_prep: false,
      });

      const chatFileRel = "events/evt-2026-1110-casual-tea.md";
      const chatFileFull = path.join(ws.memoryDir, chatFileRel);
      fs.writeFileSync(
        chatFileFull,
        [
          "---",
          "id: evt-2026-1110-casual-tea",
          "type: 事件记录",
          "date: 2026-11-10",
          "status: 有效",
          `source_event_id: ${conflictEvent.id}`,
          "category: chat",
          "allow_forget: true",
          "---",
          "闲聊([[people/user]]#下午茶, 随口提起便利店乌龙茶换了包装)",
          "",
          "## 前台原叙",
          "> 我听他随口提了一句楼下便利店的乌龙茶换了新包装。",
          "",
        ].join("\n"),
        "utf8",
      );
      syncMemoryMetaFromFiles({
        memoryDir: ws.memoryDir,
        db: ws.db,
        now: ws.clock.now(),
      });

      const report5d = await sim.fastForward("5d", {
        stepMinutes: 60,
        disableGitCommit: true,
      });

      // 满 5 天夜间肝脏结算后：T2 冲突必须从急性期“有效”转为“僵持待解(冷战期)”，且开启催产素封顶 Cap_ox = B_ox - 0.15
      const coldWarConcern = ws.db.getConcernById("broken-promise-t2");
      expect(coldWarConcern?.status).toBe("僵持待解");
      const expectedCapOx = Number(
        (ws.engine.profile.baseline.oxytocin - 0.15).toFixed(4),
      );
      expect(report5d.finalHormoneState.cap_ox).toBeCloseTo(expectedCapOx, 3);
      expect(report5d.finalHormoneState.oxytocin).toBeLessThanOrEqual(
        expectedCapOx,
      );
      // 冷战期间严禁触发主动破冰
      expect(report5d.branchCounts.proactive).toBe(0);

      // --- 阶段 C：再快进 15d（验证 chat(7d) 记忆沉底归档为 status: 已沉底，且满 21 天冲突结痂为 T3 scar） ---
      const report15d = await sim.fastForward("15d", {
        stepMinutes: 120,
        disableGitCommit: true,
      });

      const chatParsed = matter(fs.readFileSync(chatFileFull, "utf8"));
      expect(chatParsed.data.status).toBe("已沉底");
      // allow_forget: false 的 people/user.md 永远豁免沉底
      const userParsed = matter(
        fs.readFileSync(path.join(ws.memoryDir, "people", "user.md"), "utf8"),
      );
      expect(userParsed.data.status).toBe("有效");

      // 再快进 2d 使总时长跨过 21 天，验证冷战僵持结转为 T3 已结痂 (scar) 并写入 rapport.md
      await sim.fastForward("2d", {
        stepMinutes: 120,
        disableGitCommit: true,
      });
      const scarConcern = ws.db.getConcernById("broken-promise-t2");
      expect(scarConcern?.tier).toBe("scar");
      expect(scarConcern?.status).toBe("已结痂");

      const rapportAfter = fs.readFileSync(
        path.join(ws.memoryDir, "implicit", "rapport.md"),
        "utf8",
      );
      expect(rapportAfter).toContain("## 结痂雷区");
      expect(report15d.dashboardText).toContain("Echore 时间快进仿真台");
    } finally {
      ws.cleanup();
    }
  });
});
