import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { createFrontstageMemoryTools } from "../src/frontstage/memory-tools.ts";
import { buildStaticSystemPartA } from "../src/frontstage/performer.ts";
import { runMemoryLinter } from "../src/hippocampus/linter.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import type {
  LLMGenerateParams,
  LLMProvider,
  LLMResponse,
  SandwichRequest,
} from "../src/llm/types.ts";
import { EchoreEngine } from "../src/loop/engine.ts";
import { createEchoreHttpApp } from "../src/loop/http-server.ts";

function copyMemoryTemplate(tmpDir: string): void {
  const templateDir = path.join(process.cwd(), "memory_template");
  fs.cpSync(templateDir, tmpDir, { recursive: true });
}

function setupTestEnv() {
  const tmpMemDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-memtools-"));
  copyMemoryTemplate(tmpMemDir);
  const clock = new VirtualClock("2026-11-13T14:00:00+08:00");
  const db = new EchoreDatabase({ dbPath: ":memory:", clock });
  return { tmpMemDir, clock, db };
}

describe("Frontstage Standard File Tools (glob / grep / read / write / edit)", () => {
  test("read and grep sanitize log-* IDs and enforce path sandbox", async () => {
    const { tmpMemDir, clock, db } = setupTestEnv();
    try {
      const ev = db.appendEventLog({
        role: "user",
        speaker: "user",
        content: "我对芒果严重过敏",
        timestamp: clock.nowIso(),
      });

      fs.writeFileSync(
        path.join(tmpMemDir, "events", "2026-11-13-mango.md"),
        [
          "---",
          "id: evt-2026-1113-mango",
          "type: 事件记录",
          "date: 2026-11-13",
          "status: 有效",
          `source_event_id: ${ev.id}`,
          "category: health",
          "allow_forget: false",
          "---",
          "",
          "## 断言",
          "- 禁忌([[people/user]]#饮食, 严重对芒果过敏)",
          "",
          "## 前台原叙",
          "> 他刚告诉我他对芒果严重过敏。",
          "",
        ].join("\n"),
        "utf8",
      );

      fs.writeFileSync(
        path.join(tmpMemDir, "events", "2026-10-01-old-tea.md"),
        [
          "---",
          "id: evt-2026-1001-old-tea",
          "type: 事件记录",
          "date: 2026-10-01",
          "status: 已沉底",
          `source_event_id: ${ev.id}`,
          "category: chat",
          "allow_forget: true",
          "---",
          "",
          "## 断言",
          "- 偏好([[people/user]]#饮品, 曾尝试过陈皮白茶)",
          "",
        ].join("\n"),
        "utf8",
      );

      fs.writeFileSync(
        path.join(tmpMemDir, "implicit", "rapport.md"),
        [
          "---",
          "id: imp-rapport",
          "type: 内隐默契",
          "date: 2026-11-10",
          "status: 有效",
          "category: preference",
          "allow_forget: false",
          "---",
          "",
          "## 专属称呼与黑话",
          `- 暗号("加班搭子", "互相督促早睡") [src: ${ev.id}]`,
          "",
          "## 语感与边界默契",
          "",
          "## 结痂雷区",
          `- 雷区([[people/self]]#爽约敏感, "爽约后敷衍了事") [src: ${ev.id}]`,
          "",
        ].join("\n"),
        "utf8",
      );

      const tools = createFrontstageMemoryTools({
        memoryDir: tmpMemDir,
        db,
        now: () => clock.now(),
        getProfile: () => ({
          name: "Echore",
          user_name: "阿林",
          user_pronoun: "他",
          relationship: "初识",
          core_persona: "自然真实",
          dominant_archetype: "steady_anchor",
          chronotype: "regular",
          baseline: { cortisol: 0.15, oxytocin: 0.6, dopamine: 0.5 },
          resting_floor: { cortisol: 0.15, oxytocin: 0.38, dopamine: 0.28 },
          sensitivity: { cortisol: 0.7, oxytocin: 1.0, dopamine: 0.9 },
          half_life_hours: { cortisol: 30, oxytocin: 60, dopamine: 12 },
          fast_relief_ratio: 0.75,
          mood_action_slots: {
            when_hurt_or_tense: "沉静",
            when_missing_user: "自然问候",
            when_bored_alone: "看书",
            when_warm_excited: "温和打趣",
          },
        }),
      });

      const byName = new Map(tools.map((t) => [t.name, t]));
      const globRes = await byName.get("glob")!.execute({ pattern: "**/*.md" });
      expect(globRes).toContain("events/2026-11-13-mango.md");
      expect(globRes).toContain("people/self.md");
      expect(globRes).not.toContain("log-");

      // read strips source_event_id and [src: log-*]
      const readMango = await byName
        .get("read")!
        .execute({ path: "events/2026-11-13-mango.md" });
      expect(readMango).toContain("严重对芒果过敏");
      expect(readMango).not.toContain(ev.id);
      expect(readMango).not.toContain("source_event_id");

      const readRapport = await byName
        .get("read")!
        .execute({ path: "implicit/rapport.md" });
      expect(readRapport).toContain("加班搭子");
      expect(readRapport).not.toContain("log-");

      // grep defaults to literal substring matching (so [[people/user]] works), shows archived with include_archived: true, and never leaks log-*
      const grepLiteralBrackets = await byName
        .get("grep")!
        .execute({ pattern: "[[people/user]]#饮食" });
      expect(grepLiteralBrackets).toContain("events/2026-11-13-mango.md");

      const grepRegexMode = await byName
        .get("grep")!
        .execute({ pattern: "芒果.*过敏", regex: true });
      expect(grepRegexMode).toContain("events/2026-11-13-mango.md");

      const grepDefault = await byName.get("grep")!.execute({ pattern: "白茶" });
      expect(grepDefault).toContain("未检出");
      const grepArchived = await byName
        .get("grep")!
        .execute({ pattern: "白茶", include_archived: true });
      expect(grepArchived).toContain("events/2026-10-01-old-tea.md");
      expect(grepArchived).toContain("已沉底");

      const grepLogId = await byName.get("grep")!.execute({ pattern: ev.id });
      expect(grepLogId).toContain("未检出");

      // sandbox path traversal rejected
      expect(() =>
        byName.get("read")!.execute({ path: "../package.json" }),
      ).toThrow();
      expect(() =>
        byName.get("read")!.execute({ path: ".git/HEAD" }),
      ).toThrow();
    } finally {
      db.close();
      fs.rmSync(tmpMemDir, { recursive: true, force: true });
    }
  });

  test("write/edit block daytime writes to events/ & rapport.md, allow journal/ & solitary/, and enforce L1/L7 on people/ edits", async () => {
    const { tmpMemDir, clock, db } = setupTestEnv();
    try {
      const tools = createFrontstageMemoryTools({
        memoryDir: tmpMemDir,
        db,
        now: () => clock.now(),
        getProfile: () => ({
          name: "Echore",
          user_name: "用户",
          user_pronoun: "他",
          relationship: "初识",
          core_persona: "自然真实",
          dominant_archetype: "steady_anchor",
          chronotype: "regular",
          baseline: { cortisol: 0.15, oxytocin: 0.6, dopamine: 0.5 },
          resting_floor: { cortisol: 0.15, oxytocin: 0.38, dopamine: 0.28 },
          sensitivity: { cortisol: 0.7, oxytocin: 1.0, dopamine: 0.9 },
          half_life_hours: { cortisol: 30, oxytocin: 60, dopamine: 12 },
          fast_relief_ratio: 0.75,
          mood_action_slots: {
            when_hurt_or_tense: "沉静",
            when_missing_user: "自然问候",
            when_bored_alone: "看书",
            when_warm_excited: "温和打趣",
          },
        }),
      });
      const byName = new Map(tools.map((t) => [t.name, t]));

      // 1. Read-only daytime zones (events/, implicit/rapport.md, concerns/, solitary/, INDEX.md) are blocked
      expect(() =>
        byName.get("write")!.execute({
          path: "events/2026-11-13-nut-allergy.md",
          content: "## 断言\n- 禁忌([[people/user]]#坚果, 对坚果过敏)",
        }),
      ).toThrow("journal/YYYY-MM-DD.md");
      expect(() =>
        byName.get("edit")!.execute({
          path: "implicit/rapport.md",
          old_string: "## 专属称呼与黑话",
          new_string: '## 专属称呼与黑话\n- 暗号("搭子", "早睡")',
        }),
      ).toThrow("journal/YYYY-MM-DD.md");
      expect(() =>
        byName.get("write")!.execute({
          path: "concerns/2026-11-13-worry.md",
          content: "test",
        }),
      ).toThrow("concerns/");
      expect(() =>
        byName.get("write")!.execute({
          path: "solitary/prep_for_user.md",
          content: "# 伪造的独处备忘",
        }),
      ).toThrow("solitary/");
      expect(() =>
        byName.get("write")!.execute({
          path: "INDEX.md",
          content: "test",
        }),
      ).toThrow("INDEX.md");

      // 2. Full-file write on people/self.md is blocked (must use edit)
      expect(() =>
        byName.get("write")!.execute({
          path: "people/self.md",
          content: "overwrite",
        }),
      ).toThrow("请使用 edit 局部修改");

      // 3. Daytime write & edit on journal/YYYY-MM-DD.md succeed cleanly
      const journalWrite = await byName.get("write")!.execute({
        path: "journal/2026-11-13.md",
        content: "# 2026-11-13 随手记事\n- [14:00 · 随记] 他刚提到对坚果有点过敏，周末想去莫干山徒步。\n",
      });
      expect(journalWrite).toContain("已保存 journal/2026-11-13.md");

      const journalEdit = await byName.get("edit")!.execute({
        path: "journal/2026-11-13.md",
        old_string: "周末想去莫干山徒步。",
        new_string: "下周末想去莫干山徒步。",
      });
      expect(journalEdit).toContain("已更新 journal/2026-11-13.md");

      // 4. IDE-style L1/L7 rejection on people/self.md edit without touching disk
      const selfBefore = fs.readFileSync(
        path.join(tmpMemDir, "people", "self.md"),
        "utf8",
      );
      expect(() =>
        byName.get("edit")!.execute({
          path: "people/self.md",
          old_string: "- 当前状态([[people/self]]#生活状态, 日常平稳)",
          new_string: "- 关联([[people/nobody]], 引用了不存在的符号定义)",
        }),
      ).toThrow("L1 Error");
      expect(
        fs.readFileSync(path.join(tmpMemDir, "people", "self.md"), "utf8"),
      ).toBe(selfBefore);

      // Full repository lint passes cleanly
      const lintReport = runMemoryLinter({
        memoryDir: tmpMemDir,
        db,
        now: clock.now(),
      });
      expect(lintReport.passed).toBe(true);
    } finally {
      db.close();
      fs.rmSync(tmpMemDir, { recursive: true, force: true });
    }
  });

  test("frontstage editing people/self.md & people/user.md syncs profile, system_log, and next-turn Part A without fabricating source_event_id", async () => {
    const { tmpMemDir, clock, db } = setupTestEnv();
    try {
      fs.writeFileSync(
        path.join(tmpMemDir, "people", "self.md"),
        [
          "---",
          "id: sym-people-self",
          "type: 符号定义",
          "date: 2026-11-13",
          "status: 有效",
          "category: preference",
          "allow_forget: false",
          "---",
          "",
          "## 断言",
          "- 身份([[people/self]]#姓名, Echore)",
          "- 身份([[people/self]]#定位, 拥有独立日常节律与第一人称主权的陪伴住户)",
          "",
          "## 前台原叙",
          "> 我暂时还用着 Echore 这个代号，还没正式名字。",
          "",
        ].join("\n"),
        "utf8",
      );

      let frontstageTurn = 0;
      const capturedPartA: string[] = [];

      const mockFrontstageProvider: LLMProvider = {
        providerName: "mock-frontstage",
        async generate(params: LLMGenerateParams): Promise<LLMResponse> {
          if (params.tools && params.tools.length > 0) {
            return {
              text: "好呀，那我以后就叫小满啦，听着就很踏实。",
              toolCalls: [],
              stopReason: "end_turn",
            };
          }
          return { text: "OK", toolCalls: [], stopReason: "end_turn" };
        },
        async generateSandwich(req: SandwichRequest): Promise<LLMResponse> {
          frontstageTurn += 1;
          capturedPartA.push(req.staticPrefix.systemPartA);
          if (frontstageTurn === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "call_edit_self",
                  name: "edit",
                  input: {
                    path: "people/self.md",
                    old_string: "- 身份([[people/self]]#姓名, Echore)",
                    new_string: "- 身份([[people/self]]#姓名, 小满)",
                  },
                },
                {
                  id: "call_edit_user",
                  name: "edit",
                  input: {
                    path: "people/user.md",
                    old_string:
                      "- 身份([[people/user]]#关系, 日常相处的陪伴对象)",
                    new_string:
                      "- 称呼([[people/user]]#姓名, 阿林)\n- 代词([[people/user]]#代词, 她)\n- 关系([[people/user]]#关系, 朋友)",
                  },
                },
              ],
              stopReason: "tool_use",
            };
          }
          return {
            text: "阿林今天下班早吗？",
            toolCalls: [],
            stopReason: "end_turn",
          };
        },
      };

      const mockEndocrineProvider: LLMProvider = {
        providerName: "mock-endocrine",
        async generate(): Promise<LLMResponse> {
          return {
            text: JSON.stringify({
              event_summary: "双方约定正式名字为小满",
              confidence: 0.95,
              is_conflict: false,
              is_reconciliation: false,
              is_warm: true,
              is_novel: false,
              matched_rapport_joke: false,
              cortisol_delta: 0,
              oxytocin_delta: 0.05,
              dopamine_delta: 0.04,
            }),
            toolCalls: [],
            stopReason: "end_turn",
          };
        },
        async generateSandwich(): Promise<LLMResponse> {
          throw new Error("not used");
        },
      };

      const router = new OrganModelRouter({
        frontstage: { provider: mockFrontstageProvider, model: "mock-fs" },
        worker: { provider: mockFrontstageProvider, model: "mock-wk" },
        endocrine: { provider: mockEndocrineProvider, model: "mock-en" },
        compiler: { provider: mockFrontstageProvider, model: "mock-cp" },
      });

      const engine = new EchoreEngine({
        clock,
        db,
        memoryDir: tmpMemDir,
        persona: {
          name: "Echore",
          user_name: "用户",
          user_pronoun: "他",
          relationship: "初识",
          archetype: "steady_anchor",
          chronotype: "regular",
        },
        router,
      });

      const turn1 = await engine.onUserMessage(
        "以后就叫你小满吧，我是阿林，我们算朋友啦",
      );
      expect(turn1.reply).toContain("小满");
      expect(engine.profile.name).toBe("小满");
      expect(engine.profile.user_name).toBe("阿林");
      expect(engine.profile.user_pronoun).toBe("她");
      expect(engine.profile.relationship).toBe("朋友");

      const selfDisk = fs.readFileSync(
        path.join(tmpMemDir, "people", "self.md"),
        "utf8",
      );
      expect(selfDisk).toContain("身份([[people/self]]#姓名, 小满)");
      expect(selfDisk).not.toContain("source_event_id:");

      const configLogs = db.listSystemLogs({
        kind: "config_changed",
        limit: 10,
      });
      expect(
        configLogs.some(
          (l) => l.actor === "agent" && l.artifact === "persona:小满",
        ),
      ).toBe(true);

      const nextPartA = buildStaticSystemPartA(engine.profile);
      expect(nextPartA).toContain("我是小满。");
      expect(nextPartA).toContain("我和阿林的关系");
      expect(nextPartA).toContain("她是我的朋友。");

      await engine.onUserMessage("在干嘛呀");
      expect(capturedPartA[1]).toContain("我是小满。");
      expect(capturedPartA[0]).toContain("我是Echore。");

      const journalContent = fs.readFileSync(
        path.join(tmpMemDir, "journal", "2026-11-13.md"),
        "utf8",
      );
      expect(journalContent).toContain("今天和她就“在干嘛呀”聊了几句，我回她：");
    } finally {
      db.close();
      fs.rmSync(tmpMemDir, { recursive: true, force: true });
    }
  });

  test("Genesis HTTP init (co_create -> settled) injects pending naming hint, settles on edit, and persists across engine restart", async () => {
    const { tmpMemDir, clock, db } = setupTestEnv();
    try {
      let chatStep = 0;
      const capturedDynamicBlocks: string[] = [];

      const mockProvider: LLMProvider = {
        providerName: "mock-genesis",
        async generate(params: LLMGenerateParams): Promise<LLMResponse> {
          if (params.tools && params.tools.length > 0) {
            return {
              text: "好，那我以后就叫林栖了。",
              toolCalls: [],
              stopReason: "end_turn",
            };
          }
          if (
            params.messages[0]?.content.includes("[初见情境]")
          ) {
            return {
              text: "刚把东西收拾好，我现在还用着 Echore 这个代号，苏苏，很高兴认识你。",
              toolCalls: [],
              stopReason: "end_turn",
            };
          }
          return {
            text: JSON.stringify({
              event_summary: "初见破冰与定名",
              confidence: 0.9,
              is_conflict: false,
              is_reconciliation: false,
              is_warm: true,
              is_novel: false,
              matched_rapport_joke: false,
              cortisol_delta: 0,
              oxytocin_delta: 0.04,
              dopamine_delta: 0.03,
            }),
            toolCalls: [],
            stopReason: "end_turn",
          };
        },
        async generateSandwich(req: SandwichRequest): Promise<LLMResponse> {
          chatStep += 1;
          capturedDynamicBlocks.push(req.dynamicTail.subconsciousBlock ?? "");
          if (chatStep === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "call_settle_name",
                  name: "edit",
                  input: {
                    path: "people/self.md",
                    old_string: "- 身份([[people/self]]#姓名, Echore)",
                    new_string: "- 身份([[people/self]]#姓名, 林栖)",
                  },
                },
              ],
              stopReason: "tool_use",
            };
          }
          return {
            text: "今天天气不错，要不要聊会儿天？",
            toolCalls: [],
            stopReason: "end_turn",
          };
        },
      };

      const router = new OrganModelRouter({
        frontstage: { provider: mockProvider, model: "mock-fs" },
        worker: { provider: mockProvider, model: "mock-wk" },
        endocrine: { provider: mockProvider, model: "mock-en" },
        compiler: { provider: mockProvider, model: "mock-cp" },
      });

      const engine = new EchoreEngine({
        clock,
        db,
        memoryDir: tmpMemDir,
        persona: {
          name: "Echore",
          archetype: "cat_aloof",
          chronotype: "regular",
        },
        router,
      });

      const app = createEchoreHttpApp({ engine });

      // 1. Before genesis init: status is pending
      const statusBeforeRes = await app.fetch(
        new Request("http://localhost/api/genesis/status"),
      );
      const statusBefore = (await statusBeforeRes.json()) as {
        genesisStatus: string;
        namingMode: string;
        namingState: string;
        relationship: string;
      };
      expect(statusBefore.genesisStatus).toBe("pending");
      expect(statusBefore.namingMode).toBe("co_create");
      expect(statusBefore.namingState).toBe("pending");
      expect(statusBefore.relationship).toBe("初识");

      // 2. Run POST /api/genesis/init in co_create mode
      const initRes = await app.fetch(
        new Request("http://localhost/api/genesis/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_name: "苏苏",
            user_pronoun: "她",
            archetype: "cat_aloof",
            chronotype: "night_owl",
            naming_mode: "co_create",
          }),
        }),
      );
      expect(initRes.status).toBe(200);
      const initBody = (await initRes.json()) as {
        genesisStatus: string;
        namingMode: string;
        namingState: string;
        residentName: string;
        userName: string;
        userPronoun: string;
        relationship: string;
        openingMessage: string;
      };
      expect(initBody.genesisStatus).toBe("completed");
      expect(initBody.namingMode).toBe("co_create");
      expect(initBody.namingState).toBe("pending");
      expect(initBody.residentName).toBe("Echore");
      expect(initBody.userName).toBe("苏苏");
      expect(initBody.userPronoun).toBe("她");
      expect(initBody.relationship).toBe("初识");
      expect(initBody.openingMessage).toContain("苏苏");

      // Duplicate init without allowReinit is rejected
      const dupRes = await app.fetch(
        new Request("http://localhost/api/genesis/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_name: "别人",
            archetype: "dog_sunny",
          }),
        }),
      );
      expect(dupRes.status).toBe(500);

      // 3. Chat turn 1: namingState is pending -> dynamicTail has # 待定名提示 -> edit people/self.md settles name to "林栖"
      await engine.onUserMessage("我帮你起个名字叫林栖怎么样？");
      expect(capturedDynamicBlocks[0]).toContain("# 待定名提示");
      expect(engine.profile.name).toBe("林栖");
      expect(engine.namingState).toBe("settled");

      // 4. Chat turn 2: namingState is now settled -> dynamicTail no longer has # 待定名提示
      await engine.onUserMessage("林栖，你在干嘛？");
      expect(capturedDynamicBlocks[1]).not.toContain("# 待定名提示");

      // 5. Simulate engine restart on the same SQLite DB: recovers settled name "林栖" and user "苏苏"
      const restartedEngine = new EchoreEngine({
        clock,
        db,
        memoryDir: tmpMemDir,
        persona: {
          name: "FallbackIgnored",
          archetype: "dog_sunny",
        },
        router,
      });
      expect(restartedEngine.genesisStatus).toBe("completed");
      expect(restartedEngine.namingState).toBe("settled");
      expect(restartedEngine.profile.name).toBe("林栖");
      expect(restartedEngine.profile.user_name).toBe("苏苏");
      expect(restartedEngine.profile.user_pronoun).toBe("她");
      expect(restartedEngine.profile.relationship).toBe("初识");
      expect(restartedEngine.profile.chronotype).toBe("night_owl");
    } finally {
      db.close();
      fs.rmSync(tmpMemDir, { recursive: true, force: true });
    }
  });

  test("Genesis rolls back cleanly when opening LLM fails, SSE emits speaker/content, reroll preserves namingState, and sleep does not clobber relationship from template", async () => {
    const { tmpMemDir, clock, db } = setupTestEnv();
    try {
      let shouldFailGenesisOpening = true;
      let rerollCapturedDynamic = "";

      const mockProvider: LLMProvider = {
        providerName: "mock-regressions",
        async generate(params: LLMGenerateParams): Promise<LLMResponse> {
          if (params.messages[0]?.content.includes("[初见情境]")) {
            if (shouldFailGenesisOpening) {
              throw new Error("Simulated transient LLM failure");
            }
            return {
              text: "刚搬进来，现在还挂着 Echore 这个代号，多多关照。",
              toolCalls: [],
              stopReason: "end_turn",
            };
          }
          if (params.messages[0]?.content.includes("睡前自省")) {
            return {
              text: "今天平稳度过，记在心里了。",
              toolCalls: [],
              stopReason: "end_turn",
            };
          }
          if (params.messages[0]?.content.includes("[今日双向原话反馈链")) {
            return {
              text: JSON.stringify({ memories: [], rapport_rules: [] }),
              toolCalls: [],
              stopReason: "end_turn",
            };
          }
          return {
            text: JSON.stringify({
              event_summary: "日常寒暄",
              confidence: 0.9,
              is_conflict: false,
              is_reconciliation: false,
              is_warm: true,
              is_novel: false,
              matched_rapport_joke: false,
              cortisol_delta: 0,
              oxytocin_delta: 0.02,
              dopamine_delta: 0.01,
            }),
            toolCalls: [],
            stopReason: "end_turn",
          };
        },
        async generateSandwich(req: SandwichRequest): Promise<LLMResponse> {
          rerollCapturedDynamic = req.dynamicTail.subconsciousBlock ?? "";
          return {
            text: "刚在收拾书架呢。",
            toolCalls: [],
            stopReason: "end_turn",
          };
        },
      };

      const router = new OrganModelRouter({
        frontstage: { provider: mockProvider, model: "mock-fs" },
        worker: { provider: mockProvider, model: "mock-wk" },
        endocrine: { provider: mockProvider, model: "mock-en" },
        compiler: { provider: mockProvider, model: "mock-cp" },
      });

      const engine = new EchoreEngine({
        clock,
        db,
        memoryDir: tmpMemDir,
        persona: {
          name: "Echore",
          relationship: "朋友",
          archetype: "steady_anchor",
          chronotype: "regular",
        },
        router,
      });

      // 1. Sleep on template people/user.md must NOT clobber profile.relationship to "日常相处的陪伴对象"
      await engine.runSleepCycle({
        autoGitCommit: false,
        overrideReflectionText: "今天平稳度过。",
        compilationPlanOverride: { memories: [], rapport_rules: [] },
      });
      expect(engine.profile.relationship).toBe("朋友");

      // 2. Genesis LLM failure must NOT lock genesisStatus as "completed"
      const selfTemplateBefore = fs.readFileSync(
        path.join(tmpMemDir, "people", "self.md"),
        "utf8",
      );
      const app = createEchoreHttpApp({ engine });
      const failedInitRes = await app.fetch(
        new Request("http://localhost/api/genesis/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_name: "阿哲",
            user_pronoun: "他",
            relationship: "室友",
            archetype: "steady_anchor",
            naming_mode: "co_create",
          }),
        }),
      );
      expect(failedInitRes.status).toBe(500);
      expect(engine.genesisStatus).toBe("pending");
      expect(db.getResidentState()?.genesis_status).toBe("pending");
      expect(
        fs.readFileSync(path.join(tmpMemDir, "people", "self.md"), "utf8"),
      ).toBe(selfTemplateBefore);

      // 3. Subscribe to SSE and retry Genesis: succeeds and emits proactive_message with speaker & content
      shouldFailGenesisOpening = false;
      const sseAbort = new AbortController();
      const sseRes = await app.fetch(
        new Request("http://localhost/api/events", { signal: sseAbort.signal }),
      );
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      await reader.read(); // connected

      const retryInitRes = await app.fetch(
        new Request("http://localhost/api/genesis/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_name: "阿哲",
            user_pronoun: "他",
            relationship: "室友",
            archetype: "steady_anchor",
            naming_mode: "co_create",
          }),
        }),
      );
      expect(retryInitRes.status).toBe(200);
      expect(engine.genesisStatus).toBe("completed");
      expect(engine.namingState).toBe("pending");

      let sseText = "";
      for (let i = 0; i < 4; i++) {
        const chunk = await reader.read();
        if (chunk.done) break;
        sseText += decoder.decode(chunk.value, { stream: true });
        if (sseText.includes("event: proactive_message")) break;
      }
      sseAbort.abort();
      expect(sseText).toContain("event: proactive_message");
      expect(sseText).toContain('"speaker":"Echore"');
      expect(sseText).toContain('"content":"刚搬进来');

      // 4. Reroll during co_create pending naming preserves # 待定名提示
      await engine.onUserMessage("在忙什么呀？");
      rerollCapturedDynamic = "";
      await engine.rerollLastAssistantReply();
      expect(rerollCapturedDynamic).toContain("# 待定名提示");
    } finally {
      db.close();
      fs.rmSync(tmpMemDir, { recursive: true, force: true });
    }
  });

  test("onJournalWritten suppresses duplicate mechanical hot journal entry when frontstage writes today's journal", async () => {
    const { tmpMemDir, clock, db } = setupTestEnv();
    try {
      let step = 0;
      const mockProvider: LLMProvider = {
        providerName: "mock-journal-dedup",
        async generate(params: LLMGenerateParams): Promise<LLMResponse> {
          if (params.tools && params.tools.length > 0) {
            return {
              text: "好呀，莫干山徒步那事我记下啦。",
              toolCalls: [],
              stopReason: "end_turn",
            };
          }
          return {
            text: JSON.stringify({
              event_summary: "约定周末去莫干山徒步",
              confidence: 0.9,
              is_conflict: false,
              is_reconciliation: false,
              is_warm: true,
              is_novel: false,
              matched_rapport_joke: false,
              cortisol_delta: 0,
              oxytocin_delta: 0.03,
              dopamine_delta: 0.02,
            }),
            toolCalls: [],
            stopReason: "end_turn",
          };
        },
        async generateSandwich(): Promise<LLMResponse> {
          step += 1;
          if (step === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "call_write_journal",
                  name: "write",
                  input: {
                    path: "journal/2026-11-13.md",
                    content:
                      "# 2026-11-13 随手记\n\n- [14:00 · 随记] 她刚约我下周末一起去莫干山徒步，我记下来了。\n",
                  },
                },
              ],
              stopReason: "tool_use",
            };
          }
          return {
            text: "记好啦。",
            toolCalls: [],
            stopReason: "end_turn",
          };
        },
      };

      const router = new OrganModelRouter({
        frontstage: { provider: mockProvider, model: "mock-fs" },
        worker: { provider: mockProvider, model: "mock-wk" },
        endocrine: { provider: mockProvider, model: "mock-en" },
        compiler: { provider: mockProvider, model: "mock-cp" },
      });

      const engine = new EchoreEngine({
        clock,
        db,
        memoryDir: tmpMemDir,
        persona: {
          name: "小满",
          user_name: "阿林",
          user_pronoun: "她",
          relationship: "朋友",
          archetype: "steady_anchor",
        },
        router,
      });

      const turnOut = await engine.onUserMessage("下周末我们去莫干山徒步吧！");
      expect(turnOut.journalEntry).toContain("她刚约我下周末一起去莫干山徒步");
      const rawJournal = fs.readFileSync(
        path.join(tmpMemDir, "journal", "2026-11-13.md"),
        "utf8",
      );
      expect(rawJournal).not.toContain("今天和她就“下周末我们去莫干山徒步吧！");
    } finally {
      db.close();
      fs.rmSync(tmpMemDir, { recursive: true, force: true });
    }
  });
});

