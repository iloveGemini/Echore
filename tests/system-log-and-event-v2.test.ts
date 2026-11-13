import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { PROMPTS_DIR } from "../src/core/prompts.ts";
import { assertNoInternalLeaks } from "../src/core/schemas.ts";
import {
  extractFeedbackTriplets,
  extractHotEntriesForDate,
} from "../src/frontstage/journal.ts";
import { runMemoryLinter } from "../src/hippocampus/linter.ts";
import { recallMemories } from "../src/hippocampus/recall.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import type { LLMProvider } from "../src/llm/types.ts";
import { EchoreEngine } from "../src/loop/engine.ts";
import { createEchoreHttpApp } from "../src/loop/http-server.ts";
import { EchoreMcpServer } from "../src/loop/mcp-server.ts";

describe("system_log + system_materials & event_log v2 + 04:30/startup backup", () => {
  let tmpDir: string;
  let memoryDir: string;
  let promptsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-syslog-v2-"));
    memoryDir = path.join(tmpDir, "memory");
    promptsDir = path.join(tmpDir, "prompts");
    fs.mkdirSync(path.join(memoryDir, "people"), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, "events"), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, "concerns"), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, "implicit"), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, "journal"), { recursive: true });
    fs.cpSync(PROMPTS_DIR, promptsDir, { recursive: true });

    fs.writeFileSync(
      path.join(memoryDir, "people", "user.md"),
      [
        "---",
        "id: user",
        "type: 符号定义",
        "date: 2026-11-10",
        "status: 有效",
        "category: preference",
        "allow_forget: false",
        "---",
        "## 断言",
        "- 身份([[people/user]]#角色, 主互动伙伴)",
        "",
        "## 前台原叙",
        "> 我和他的日常。",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockProvider(replyFn?: (prompt: string) => string): LLMProvider {
    return {
      providerName: "mock-provider",
      async generate(req) {
        const lastMsg = req.messages[req.messages.length - 1]?.content ?? "";
        const text =
          typeof lastMsg === "string" ? lastMsg : JSON.stringify(lastMsg);
        if (replyFn) {
          return {
            text: replyFn(text),
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        return {
          text: `收到你的话了：${text.slice(0, 24)}`,
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
      async generateSandwich(req) {
        const text = req.dynamicTail.latestUserMessage;
        if (replyFn) {
          return {
            text: replyFn(text),
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        return {
          text: `收到你的话了：${text.slice(0, 24)}`,
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
    };
  }

  test("§6.1–§6.4 & §6.6: prompt_changed 全文按哈希逐字节取回、重复原文去重、触发器防删改、deploy 与 config_epoch 关联、前台零写入口与零泄露查账", async () => {
    const clock = new VirtualClock("2026-11-13T10:00:00.000Z");
    const db = new EchoreDatabase({
      dbPath: path.join(tmpDir, "echore.sqlite"),
      dataDir: tmpDir,
      clock,
    });
    const provider = createMockProvider();
    const router = new OrganModelRouter({ defaultProvider: provider });

    // 1. 首次启动 commit-v1 -> 产生 1 条 deploy 日志
    const engine1 = new EchoreEngine({
      clock,
      db,
      memoryDir,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof" },
      router,
      commitHash: "commit-v1",
    });

    const deployLogs1 = db.listSystemLogs({ kind: "deploy" });
    expect(deployLogs1.length).toBe(1);
    expect(deployLogs1[0]!.link).toBe("commit-v1");

    // 2. 相同 commitHash 再次启动 -> 不重复产生 deploy 日志
    const engineSame = new EchoreEngine({
      clock,
      db,
      memoryDir,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof" },
      router,
      commitHash: "commit-v1",
    });
    expect(db.listSystemLogs({ kind: "deploy" }).length).toBe(1);

    // 3. 新 commitHash 启动 -> 产生第 2 条 deploy 日志，config_epoch 递增
    const engine2 = new EchoreEngine({
      clock,
      db,
      memoryDir,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof" },
      router,
      commitHash: "commit-v2",
    });
    expect(db.listSystemLogs({ kind: "deploy" }).length).toBe(2);
    const epochBeforePromptChange = db.getConfigEpoch();
    expect(epochBeforePromptChange).toBe(2);

    await engine2.onUserMessage("早安，今天天气不错", {
      pulseOverride: { is_warm: true, oxytocin_delta: 0.03 },
    });

    // 4. 修改提示词文件并重载 -> 多一条 prompt_changed，新旧全文均可逐字节取回，改回原版不重复占 system_materials
    const targetPromptPath = path.join(promptsDir, "frontstage-system.md");
    const originalPromptRaw = fs.readFileSync(targetPromptPath, "utf8");
    const modifiedPromptRaw = `${originalPromptRaw}\n\n<!-- 调试补充条款：保持干脆利落 -->\n`;
    fs.writeFileSync(targetPromptPath, modifiedPromptRaw, "utf8");

    const materialsBefore = db.countSystemMaterials();
    const changedLogs = engine2.reloadPrompts();
    expect(changedLogs.length).toBe(1);
    const pLog = changedLogs[0]!;
    expect(pLog.kind).toBe("prompt_changed");
    expect(pLog.artifact).toBe("prompts/frontstage-system.md");
    expect(pLog.old_hash).toBeTruthy();
    expect(pLog.new_hash).toBeTruthy();
    expect(pLog.old_hash).not.toBe(pLog.new_hash);

    const oldMat = db.getSystemMaterial(pLog.old_hash!);
    const newMat = db.getSystemMaterial(pLog.new_hash!);
    expect(oldMat?.content).toBe(originalPromptRaw);
    expect(newMat?.content).toBe(modifiedPromptRaw);
    expect(db.countSystemMaterials()).toBe(materialsBefore + 1);

    // 改回原版全文再次重载 -> system_materials 行数不增加（内容寻址去重）
    fs.writeFileSync(targetPromptPath, originalPromptRaw, "utf8");
    const revertLogs = engine2.reloadPrompts();
    expect(revertLogs.length).toBe(1);
    expect(revertLogs[0]!.new_hash).toBe(pLog.old_hash);
    expect(db.countSystemMaterials()).toBe(materialsBefore + 1);

    // 5. 模型路由切换与人设更新记录 model_changed / config_changed，且消息按 config_epoch 可查
    engine2.updateModelRoute("frontstage", {
      provider,
      model: "claude-fable-5-2",
    });
    engine2.updatePersona({
      name: "Echore",
      archetype: "steady_anchor",
      chronotype: "regular",
    });
    expect(db.listSystemLogs({ kind: "model_changed" }).length).toBe(1);
    expect(db.listSystemLogs({ kind: "config_changed" }).length).toBe(1);

    const epochAfterChanges = db.getConfigEpoch();
    expect(epochAfterChanges).toBeGreaterThan(epochBeforePromptChange);

    await engine2.onUserMessage("换了新模型和人设之后感觉怎么样？", {
      pulseOverride: { is_warm: true, oxytocin_delta: 0.02 },
    });

    const msgsEpochOld = db.getEventLogsByConfigEpoch(epochBeforePromptChange);
    const msgsEpochNew = db.getEventLogsByConfigEpoch(epochAfterChanges);
    expect(msgsEpochOld.length).toBe(2);
    expect(msgsEpochNew.length).toBe(2);

    // 6. UPDATE / DELETE 触发器硬拒绝
    expect(() => {
      db.sqlite.exec("UPDATE system_log SET reason = 'tampered';");
    }).toThrow(/system_log 只追加，不可修改/);
    expect(() => {
      db.sqlite.exec("DELETE FROM system_log;");
    }).toThrow(/system_log 只追加，不可删除/);

    // 7. 住户侧只读查账摘要零泄露 + 前台源码零写入口验证
    const residentSummary = engine2.getSystemLogSummaryForResident();
    expect(residentSummary).toContain("[系统变更备忘]");
    expect(() =>
      assertNoInternalLeaks(residentSummary, "test.residentSummary"),
    ).not.toThrow();

    for (const file of [
      "performer.ts",
      "silent-worker.ts",
      "journal.ts",
      "solitary.ts",
    ]) {
      const srcCode = fs.readFileSync(
        path.join(process.cwd(), "src", "frontstage", file),
        "utf8",
      );
      expect(srcCode).not.toContain("appendSystemLog");
      expect(srcCode).not.toContain("INSERT INTO system_log");
    }

    void engineSame;
    db.close();
  });

  test("§6.5: 睡眠环失败回滚产生 sleep_rollback 日志，单条快照回滚产生 snapshot_rollback 与 spine_changed 日志", async () => {
    const clock = new VirtualClock("2026-11-13T14:00:00.000Z");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const provider = createMockProvider();
    const router = new OrganModelRouter({ defaultProvider: provider });
    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof" },
      router,
    });

    const turn = await engine.onUserMessage("记住我下周三要去体检", {
      pulseOverride: { is_warm: true },
    });

    // 1. 正常睡眠环写入 rapport 规则（产生 spine_changed）与事件记忆（产生 snapshot）
    await engine.runSleepCycle({
      targetDateStr: "2026-11-13",
      overrideReflectionText: "今天记下了他下周三要去体检的事。",
      compilationPlanOverride: {
        memories: [
          {
            rel_path: "events/2026-11-13-checkup.md",
            id: "ev-checkup",
            type: "事件记录",
            date: "2026-11-13",
            status: "有效",
            source_event_id: turn.userEventId,
            category: "schedule",
            allow_forget: true,
            assertions: [`计划([[people/user]]#体检, 下周三去医院体检)`],
          },
        ],
        rapport_rules: [
          {
            section: "语感与边界默契",
            predicate_line: "提醒体检事宜时直接给清单不啰嗦",
            source_event_id: turn.userEventId,
          },
        ],
      },
      autoGitCommit: false,
    });

    const spineLogs = db.listSystemLogs({ kind: "spine_changed" });
    expect(spineLogs.length).toBe(1);
    expect(spineLogs[0]!.new_hash).toBeTruthy();
    expect(db.getSystemMaterial(spineLogs[0]!.new_hash!)?.content).toContain(
      "提醒体检事宜时直接给清单不啰嗦",
    );

    // 2. 单条快照回滚 -> 产生 snapshot_rollback
    const rbRes = engine.rollbackMemorySnapshot("2026-11-13", "ev-checkup");
    expect(rbRes.restored).toBe(true);
    const snapRbLogs = db.listSystemLogs({ kind: "snapshot_rollback" });
    expect(snapRbLogs.length).toBe(1);
    expect(snapRbLogs[0]!.artifact).toBe("memory:ev-checkup");

    // 3. 构造违反 L7（断言有效语义字数过短 < 4）的编译计划触发睡眠环失败回滚 -> 产生 sleep_rollback
    await expect(
      engine.runSleepCycle({
        targetDateStr: "2026-11-14",
        overrideReflectionText: "测试失败回滚。",
        compilationPlanOverride: {
          memories: [
            {
              rel_path: "events/2026-11-14-bad.md",
              id: "ev-bad",
              type: "事件记录",
              date: "2026-11-14",
              status: "有效",
              source_event_id: turn.userEventId,
              category: "chat",
              allow_forget: true,
              assertions: [`记([[people/user]], 好)`],
            },
          ],
          rapport_rules: [],
        },
        autoGitCommit: false,
      }),
    ).rejects.toThrow(/MemoryCILinterFailed/);

    const sleepRbLogs = db.listSystemLogs({ kind: "sleep_rollback" });
    expect(sleepRbLogs.length).toBe(1);
    expect(sleepRbLogs[0]!.link).toBe("2026-11-14");

    db.close();
  });

  test("§9.6.1–§9.6.4: 删除消息（未过夜全撤 + 已过夜 L5 孤儿降级不熔断睡眠环）、Reroll 状态机（被丢弃版本零残留）、编辑无旧文残留、多媒体引用计数删除", async () => {
    const clock = new VirtualClock("2026-11-13T12:00:00.000Z");
    const db = new EchoreDatabase({
      dbPath: path.join(tmpDir, "echore.sqlite"),
      dataDir: tmpDir,
      clock,
    });
    let turnCounter = 0;
    const provider = createMockProvider(() => {
      turnCounter += 1;
      return `住户回复版本#${turnCounter}`;
    });
    const router = new OrganModelRouter({ defaultProvider: provider });
    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof" },
      router,
    });

    // Day 1: 发送带图片的对话并完成夜间睡眠编译
    const imageBytes = new TextEncoder().encode("fake-png-binary-payload-001");
    const day1Turn = await engine.onUserMessage("这是我家橘猫的照片，它叫大福", {
      attachments: [
        {
          type: "image",
          data: imageBytes,
          ext: ".png",
          mime: "image/png",
        },
      ],
      pulseOverride: { is_warm: true, oxytocin_delta: 0.04 },
    });

    // 验证无说明的图片自动生成了描述，且 FTS 可搜到
    const day1UserEv = db.getEventLogById(day1Turn.userEventId)!;
    expect(day1UserEv.attachments?.length).toBe(1);
    expect(day1UserEv.attachments![0]!.caption).toBeTruthy();
    const imgRelPath = day1UserEv.attachments![0]!.path;
    const imgAbsPath = path.join(tmpDir, imgRelPath);
    expect(fs.existsSync(imgAbsPath)).toBe(true);

    // Day 1 夜里编译进记忆
    clock.advanceHours(11);
    await engine.runSleepCycle({
      targetDateStr: "2026-11-13",
      overrideReflectionText: "今天看到了他家叫大福的橘猫。",
      compilationPlanOverride: {
        memories: [
          {
            rel_path: "events/2026-11-13-cat-dafu.md",
            id: "ev-cat-dafu",
            type: "事件记录",
            date: "2026-11-13",
            status: "有效",
            source_event_id: day1Turn.userEventId,
            category: "life_event",
            allow_forget: false,
            assertions: [`宠物([[people/user]]#猫咪, 橘猫大福)`],
          },
        ],
        rapport_rules: [],
      },
      autoGitCommit: false,
    });

    // Day 2: 发送同一张图片（测试引用计数），随后测试 Reroll 与版本切换
    clock.setNow("2026-11-14T10:00:00.000Z");
    const day2Turn1 = await engine.onUserMessage("再发一次大福的同一张图，它今天去打疫苗了", {
      attachments: [
        {
          type: "image",
          data: imageBytes,
          ext: ".png",
          mime: "image/png",
          caption: "大福打疫苗前的照片",
        },
      ],
      pulseOverride: {
        is_conflict: false,
        new_concern: {
          id: "con-vaccine",
          tier: "minor_worry",
          summary: "惦记大福打疫苗后的反应",
        },
      },
    });
    expect(
      db.getAttachmentCountByHash(day1UserEv.attachments![0]!.hash),
    ).toBe(2);

    // Reroll 最后一条回复 2 次（共 3 个版本：v1, v2, v3）
    const reroll2 = await engine.rerollLastAssistantReply({
      overrideReplyText: "Reroll候选第二版：记得观察大福有没有发烧",
    });
    const reroll3 = await engine.rerollLastAssistantReply({
      overrideReplyText: "Reroll候选第三版：打完疫苗别马上洗澡",
    });
    expect(reroll2.version).toBe(2);
    expect(reroll3.version).toBe(3);
    expect(reroll3.versions.length).toBe(3);

    // 切换回第 2 版 -> 当前 active 为 v2，v1/v3 为 candidate，且当日热记事只含 v2 不含 v3
    const switchedV2 = engine.switchMessageVersion(reroll3.groupId, 2);
    expect(switchedV2.status).toBe("active");
    expect(switchedV2.content).toContain("Reroll候选第二版");
    expect(db.searchEventLogsFts("洗澡").length).toBe(0);
    expect(db.searchEventLogsFts("发烧").length).toBe(1);
    const hotAfterSwitch = extractHotEntriesForDate(memoryDir, "2026-11-14");
    expect(hotAfterSwitch.join("\n")).toContain("Reroll候选第二版");
    expect(hotAfterSwitch.join("\n")).not.toContain("Reroll候选第三版");

    // 用户发送下一条新消息 -> v1/v3 候选版本被物理删除，只留 v2
    const day2Turn2 = await engine.onUserMessage("好的，我在医院观察半小时", {
      pulseOverride: { is_warm: true },
    });
    const remainingGroupVersions = db.getEventVersionsByGroupId(
      reroll3.groupId,
    );
    expect(remainingGroupVersions.length).toBe(1);
    expect(remainingGroupVersions[0]!.version).toBe(2);

    // 删除未过夜的 day2Turn2 -> 热记事与 FTS 同步截断
    const delTurn2 = engine.deleteMessagesFrom(day2Turn2.userEventId);
    expect(delTurn2.deletedCount).toBe(2);
    expect(
      extractHotEntriesForDate(memoryDir, "2026-11-14").join("\n"),
    ).not.toContain("观察半小时");

    // 删除未过夜的 day2Turn1 -> 撤回 con-vaccine 牵挂，且由于 Day 1 仍引用同一张图，磁盘图片文件保留不删！
    const delTurn1 = engine.deleteMessagesFrom(day2Turn1.userEventId);
    expect(delTurn1.withdrawnConcernIds).toContain("con-vaccine");
    expect(fs.existsSync(imgAbsPath)).toBe(true);
    expect(
      db.getAttachmentCountByHash(day1UserEv.attachments![0]!.hash),
    ).toBe(1);

    // 现在连已过夜的 Day 1 消息也删掉 -> 引用计数归零，磁盘图片文件物理删除；
    // system_log 记录 message_deleted（不含被删正文）；
    // Linter L5 将 ev-cat-dafu 降级为 warning (orphaned_by_deletion)，当晚睡眠环正常通过不回滚！
    const delDay1 = engine.deleteMessagesFrom(day1Turn.userEventId);
    expect(delDay1.hasSettledHistoryDeleted).toBe(true);
    expect(fs.existsSync(imgAbsPath)).toBe(false);

    const delLogs = db.listSystemLogs({ kind: "message_deleted" });
    expect(delLogs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(delLogs)).not.toContain("大福");

    const lintAfterDel = runMemoryLinter({
      memoryDir,
      db,
      now: clock.now(),
    });
    expect(lintAfterDel.passed).toBe(true);
    expect(
      lintAfterDel.issues.some(
        (i) =>
          i.rule === "L5" &&
          i.severity === "warning" &&
          i.message.includes("orphaned_by_deletion"),
      ),
    ).toBe(true);

    // 测试编辑：插入一条尚无回复的用户消息并编辑 -> 旧文不出现在任何表中
    const lonelyUserEv = db.appendEventLog({
      role: "user",
      speaker: "user",
      content: "包含敏感口误的原始草稿998877",
      producer: "user",
      source: "chat",
    });
    const editedEv = engine.editLastUserMessage(
      lonelyUserEv.id,
      "修改后的干净消息内容",
    );
    expect(editedEv.content).toBe("修改后的干净消息内容");
    expect(db.searchEventLogsFts("998877").length).toBe(0);
    expect(JSON.stringify(db.listSystemLogs())).not.toContain("998877");

    db.close();
  });

  test("§9.6.5–§9.6.7: producer/source 精确回填（含 proactive/mcp_digest/solitary/import/group）、召回与三元组过滤、/api/events 展示与 04:30 + 启动补备整库恢复", async () => {
    const clock = new VirtualClock("2026-11-13T18:00:00.000Z");
    const dbPath = path.join(tmpDir, "resident.sqlite");
    const db = new EchoreDatabase({
      dbPath,
      dataDir: tmpDir,
      clock,
    });
    const provider = createMockProvider();
    const router = new OrganModelRouter({ defaultProvider: provider });
    const engine = new EchoreEngine({
      clock,
      db,
      memoryDir,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof" },
      router,
      enableScheduledBackup: true,
    });
    const mcp = new EchoreMcpServer(engine);

    // 1. 模拟旧版未填 producer/source 的历史数据并验证 backfillEventLogV2Columns 100% 精确回填
    db.sqlite
      .query(
        `INSERT INTO event_log (id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source)
         VALUES
           ('log-20261113-010000-001', '2026-11-13T15:00:00.000Z', 'assistant', 'Echore', '旧版心跳主动破冰问候', '{"proactive":true,"trigger":"missing_user"}', '', 1, 'active', '', ''),
           ('log-20261113-010000-002', '2026-11-13T15:05:00.000Z', 'user', 'user', '系统借user槽位注入的隐藏提示', '{}', '', 1, 'active', 'system', 'system'),
           ('log-20261113-010000-003', '2026-11-13T15:10:00.000Z', 'user', 'Roxy', '群里Roxy聊到了周末聚餐', '{"room_id":"living-room"}', '', 1, 'active', 'peer', 'group'),
           ('log-20261113-010000-004', '2026-11-13T15:15:00.000Z', 'user', 'user', '以前在Roy那边聊过的滑雪板型号', '{"source":"import"}', '', 1, 'active', '', '')`,
      )
      .run();

    await mcp.digestTurn({
      userMessage: "外部客户端聊到的Rust编译器问题",
      assistantReply: "外部助手回复的生命周期解答",
    });

    db.backfillEventLogV2Columns();
    for (const id of [
      "log-20261113-010000-001",
      "log-20261113-010000-002",
      "log-20261113-010000-003",
      "log-20261113-010000-004",
    ]) {
      db.syncEventFtsForId(id);
    }

    const proactiveRow = db.getEventLogById("log-20261113-010000-001")!;
    expect(proactiveRow.producer).toBe("resident");
    expect(proactiveRow.source).toBe("heartbeat");

    const importRow = db.getEventLogById("log-20261113-010000-004")!;
    expect(importRow.producer).toBe("user");
    expect(importRow.source).toBe("import");

    const recentAll = db.getRecentEventLogs(20);
    const digestAssistant = recentAll.find((e) =>
      e.content.includes("外部助手回复的生命周期解答"),
    )!;
    expect(digestAssistant.producer).toBe("external");
    expect(digestAssistant.source).toBe("mcp_digest");

    // 2. 验证召回绝不把 system 渲染出来、external 不渲染为“我当时说”、peer 渲染为“Roxy当时说”、import 标出“（搬家前）”
    expect(db.searchEventLogsFts("隐藏提示").length).toBe(0);

    const recallExternal = recallMemories({
      memoryDir,
      db,
      query: "生命周期解答",
      now: clock.now(),
      activeConcerns: [],
    });
    expect(recallExternal.formattedBlock).toContain("（外部对话记录）");
    expect(recallExternal.formattedBlock).not.toContain(
      "我当时说：“外部助手回复",
    );

    const recallPeer = recallMemories({
      memoryDir,
      db,
      query: "周末聚餐",
      now: clock.now(),
      activeConcerns: [],
    });
    expect(recallPeer.formattedBlock).toContain("Roxy当时说");

    const recallImport = recallMemories({
      memoryDir,
      db,
      query: "滑雪板型号",
      now: clock.now(),
      activeConcerns: [],
    });
    expect(recallImport.formattedBlock).toContain("（搬家前）他说");

    // 3. 验证 extractFeedbackTriplets 只配对 genuine 的 user -> resident，忽略 system 与 external
    await engine.onUserMessage("晚上想吃火锅", {
      pulseOverride: { is_warm: true },
    });
    const triplets = extractFeedbackTriplets(db.getRecentEventLogs(20));
    for (const t of triplets) {
      if (t.prev) expect(t.prev.producer).toBe("user");
      for (const a of t.acts) {
        expect(a.producer).toBe("resident");
      }
    }

    // 4. 验证 /api/events?format=json 返回 producer 与 source
    const app = createEchoreHttpApp({ engine });
    const eventsResp = await app.fetch(
      new Request("http://localhost/api/events?format=json"),
    );
    expect(eventsResp.status).toBe(200);
    const eventsJson = (await eventsResp.json()) as {
      events: Array<{ producer: string; source: string }>;
    };
    expect(eventsJson.events.length).toBeGreaterThan(0);
    expect(eventsJson.events.every((e) => Boolean(e.producer && e.source))).toBe(
      true,
    );

    // 5. 验证凌晨 04:30 定时备份与次日关机错过后的启动补备（startup_catchup），且备份 SQLite 库可完整打开恢复
    // 将时间拨至次日本地凌晨 04:30
    const nextMorning0430 = new Date(clock.now());
    nextMorning0430.setDate(nextMorning0430.getDate() + 1);
    nextMorning0430.setHours(4, 30, 0, 0);
    clock.setNow(nextMorning0430);

    // 先跑一次心跳触发入睡编译，再跑一次 04:30 心跳触发 scheduled_0430 备份
    await engine.onHeartbeat();
    const hb0430 = await engine.onHeartbeat();
    const backupLogs1 = db.listSystemLogs({ kind: "backup_completed" });
    expect(backupLogs1.length).toBe(1);
    expect(backupLogs1[0]!.reason).toContain("scheduled_0430");
    void hb0430;

    // 验证备份目录中的 echore.sqlite 可以独立打开并读出全部对话
    const backupSqlitePath = path.join(
      backupLogs1[0]!.link!,
      "echore.sqlite",
    );
    expect(fs.existsSync(backupSqlitePath)).toBe(true);
    const restoredSqlite = new Database(backupSqlitePath, { readonly: true });
    const restoredCount = restoredSqlite
      .query("SELECT COUNT(*) AS cnt FROM event_log WHERE status = 'active'")
      .get() as { cnt: number };
    expect(restoredCount.cnt).toBeGreaterThanOrEqual(5);
    restoredSqlite.close();

    // 模拟次日夜晚关机错过了凌晨 04:30，白天 10:00 启动服务 -> ensureStartupBackup 立即补跑 startup_catchup
    const dayAfter1000 = new Date(nextMorning0430);
    dayAfter1000.setDate(dayAfter1000.getDate() + 1);
    dayAfter1000.setHours(10, 0, 0, 0);
    clock.setNow(dayAfter1000);

    const catchup = engine.ensureStartupBackup();
    expect(catchup.backedUp).toBe(true);
    expect(catchup.result?.trigger).toBe("startup_catchup");

    // 紧接着再次调用 ensureStartupBackup -> 当日已备，不再重复备份
    const secondCheck = engine.ensureStartupBackup();
    expect(secondCheck.backedUp).toBe(false);

    db.close();
  });

  test("review fixes: 跨重启离线改提示词、睡眠回滚保备份游标且不记未生效 spine_changed、reroll 护栏、跨午夜删除、FTS 过滤与最新 system_log 排序", async () => {
    // 1. 跨重启离线修改提示词（此前无 prompt_changed 记录）仍能检测并记录 prompt_changed
    const dbFile = path.join(tmpDir, "restart-prompts.sqlite");
    const clock1 = new VirtualClock("2026-11-13T10:00:00.000Z");
    const db1 = new EchoreDatabase({ dbPath: dbFile, dataDir: tmpDir, clock: clock1 });
    const provider = createMockProvider();
    const router = new OrganModelRouter({ defaultProvider: provider });
    new EchoreEngine({
      clock: clock1,
      db: db1,
      memoryDir,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof" },
      router,
      commitHash: "c1",
    });
    expect(db1.listSystemLogs({ kind: "prompt_changed" }).length).toBe(0);
    db1.close();

    // 离线改写提示词后再重启
    const pPath = path.join(promptsDir, "frontstage-system.md");
    fs.writeFileSync(pPath, `${fs.readFileSync(pPath, "utf8")}\n<!-- offline edit -->\n`, "utf8");
    const clock2 = new VirtualClock("2026-11-13T11:00:00.000Z");
    const db2 = new EchoreDatabase({ dbPath: dbFile, dataDir: tmpDir, clock: clock2 });
    const engine2 = new EchoreEngine({
      clock: clock2,
      db: db2,
      memoryDir,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof" },
      router,
      commitHash: "c1",
    });
    const offlineChanges = db2.listSystemLogs({ kind: "prompt_changed" });
    expect(offlineChanges.length).toBe(1);
    expect(offlineChanges[0]!.artifact).toBe("prompts/frontstage-system.md");

    // 2. 睡眠失败回滚：保留 last_backup_at/last_backup_date，且 L1-L7 失败不留下未生效的 spine_changed
    const turn = await engine2.onUserMessage("准备睡眠测试", {
      pulseOverride: { is_warm: true },
    });
    engine2.runSystemBackup({ trigger: "manual" });
    const beforeRollbackReflex = db2.getReflexState();
    expect(beforeRollbackReflex.last_backup_date).toBeTruthy();

    await expect(
      engine2.runSleepCycle({
        targetDateStr: "2026-11-13",
        overrideReflectionText: "失败的睡眠测试。",
        compilationPlanOverride: {
          memories: [
            {
              rel_path: "events/2026-11-13-bad.md",
              id: "ev-bad-l7",
              type: "事件记录",
              date: "2026-11-13",
              status: "有效",
              source_event_id: turn.userEventId,
              category: "chat",
              allow_forget: true,
              assertions: [`记([[people/user]], 好)`],
            },
          ],
          rapport_rules: [
            {
              section: "语感与边界默契",
              predicate_line: "这条规则随回滚不应该落入账本",
              source_event_id: turn.userEventId,
            },
          ],
        },
        autoGitCommit: false,
      }),
    ).rejects.toThrow(/MemoryCILinterFailed/);

    const afterRollbackReflex = db2.getReflexState();
    expect(afterRollbackReflex.last_backup_date).toBe(beforeRollbackReflex.last_backup_date);
    expect(afterRollbackReflex.last_backup_at).toBe(beforeRollbackReflex.last_backup_at);
    expect(db2.listSystemLogs({ kind: "spine_changed" }).length).toBe(0);

    // 3. isEventIdDeletedInSystemLog 精确查 deleted_ids，不误伤范围外伪造 ID
    const evA = db2.appendEventLog({
      id: "log-20261113-1000-001",
      role: "user",
      speaker: "user",
      content: "第一条",
    });
    db2.appendEventLog({
      id: "log-20261113-2000-001",
      role: "assistant",
      speaker: "Echore",
      content: "第二条",
    });
    db2.deleteEventsFromId(evA.id);
    expect(db2.isEventIdDeletedInSystemLog("log-20261113-1000-001")).toBe(true);
    expect(db2.isEventIdDeletedInSystemLog("log-20261113-1500-999")).toBe(false);

    // 4. Reroll 禁止覆写 external (mcp_digest) 回复
    const mcp = new EchoreMcpServer(engine2);
    await mcp.digestTurn({
      userMessage: "外部消息",
      assistantReply: "外部助手回复",
    });
    await expect(
      engine2.rerollLastAssistantReply({ overrideReplyText: "不应覆盖外部回复" }),
    ).rejects.toThrow(/只能对最后一条住户回复执行 Reroll/);

    // 5. searchEventLogsFts SQL 层按 producer 过滤不受其他高频消息 LIMIT 遮蔽
    for (let i = 0; i < 25; i++) {
      db2.appendEventLog({
        id: `log-20261113-1800-${String(i).padStart(3, "0")}`,
        role: "user",
        speaker: "user",
        content: `高频词测试苹果第${i}条`,
        producer: "user",
        source: "chat",
      });
    }
    db2.appendEventLog({
      id: "log-20261113-1801-001",
      role: "user",
      speaker: "Roxy",
      content: "高频词测试苹果来自同伴",
      producer: "peer",
      source: "group",
    });
    const peerHits = db2.searchEventLogsFts("高频词测试苹果", 5, {
      producers: ["peer"],
    });
    expect(peerHits.length).toBe(1);
    expect(peerHits[0]!.producer).toBe("peer");

    // 6. listSystemLogs({ limit }) 返回最新记录而非最旧记录
    for (let i = 0; i < 6; i++) {
      db2.appendSystemLog({
        actor: "maker",
        kind: "config_changed",
        artifact: `cfg:${i}`,
        reason: `config_${i}`,
      });
    }
    const latestTwo = db2.listSystemLogs({ limit: 2 });
    expect(latestTwo.length).toBe(2);
    expect(latestTwo[1]!.artifact).toBe("cfg:5");

    // 7. 跨午夜未睡消息删除同步清理前一日 circadian journal，且按新版 ID 删除不遗漏旧版本
    const lateClock = new VirtualClock("2026-11-14T16:30:00.000Z"); // 在 UTC 为 16:30，按本地设成凌晨 00:30
    const localLate = new Date(2026, 10, 14, 0, 30, 0, 0);
    lateClock.setNow(localLate);
    const db3 = new EchoreDatabase({ dbPath: ":memory:", clock: lateClock });
    const mem3 = path.join(tmpDir, "mem3");
    fs.cpSync(memoryDir, mem3, { recursive: true });
    const eng3 = new EchoreEngine({
      clock: lateClock,
      db: db3,
      memoryDir: mem3,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof", chronotype: "regular" },
      router,
    });
    const midnightTurn = await eng3.onUserMessage("半夜十二点半来聊两句", {
      pulseOverride: { is_warm: true },
    });
    const rerolled = await eng3.rerollLastAssistantReply({
      overrideReplyText: "半夜新版回复",
    });
    expect(extractHotEntriesForDate(mem3, "2026-11-13").join("\n")).toContain("半夜新版回复");

    // 醒来至次日 10:00 后删除（2026-11-13 尚未睡眠封底），删除新版 assistant ID 应连带清理同组旧版与 2026-11-13 热记事
    lateClock.setNow(new Date(2026, 10, 14, 10, 0, 0, 0));
    eng3.deleteMessagesFrom(rerolled.event.id);
    expect(db3.getEventVersionsByGroupId(rerolled.groupId).length).toBe(0);
    expect(extractHotEntriesForDate(mem3, "2026-11-13").join("\n")).not.toContain("半夜新版回复");

    // 删除从最早消息开始时应同步清空 last_sleep_settled_at
    eng3.deleteMessagesFrom(midnightTurn.userEventId);
    expect(db3.getRecentEventLogs(10).length).toBe(0);

    // 8. 04:30 心跳在 solitary 分支触发备份时应返回 backupResult 与刷新后的 reflexState
    const db4 = new EchoreDatabase({
      dbPath: path.join(tmpDir, "solitary-backup.sqlite"),
      dataDir: tmpDir,
      clock: lateClock,
    });
    const mem4 = path.join(tmpDir, "mem4");
    fs.cpSync(memoryDir, mem4, { recursive: true });
    const clock4 = new VirtualClock(new Date(2026, 10, 15, 4, 30, 0, 0));
    const eng4 = new EchoreEngine({
      clock: clock4,
      db: new EchoreDatabase({
        dbPath: path.join(tmpDir, "solitary-backup-2.sqlite"),
        dataDir: tmpDir,
        clock: clock4,
      }),
      memoryDir: mem4,
      promptsDir,
      persona: { name: "Echore", archetype: "cat_aloof", chronotype: "early_bird" },
      router,
      enableScheduledBackup: true,
    });
    // 让 2026-11-14 提前封底、低多巴胺且睡眠锁解除窗口? 改在 04:30 让 early_bird 仍处于睡眠锁前先验证直接返回字段：
    // 先把多巴胺调低至无聊区并确保 resolveTargetDateForSleepCycle 返回 null（无昨日遗留即满足）
    const h4 = eng4.db.getHormoneState();
    eng4.db.saveHormoneState({ ...h4, dopamine: 0.2, melatonin: 0.2 });
    const hbSolitary = await eng4.onHeartbeat({
      overrideSolitaryNoteText: "凌晨四点半自己翻了会儿书。",
    });
    if (hbSolitary.branch === "solitary" || hbSolitary.branch === "idle") {
      expect(hbSolitary.backupResult).toBeDefined();
      expect(hbSolitary.reflexState.last_backup_date).toBe("2026-11-15");
    }

    eng4.db.close();
    db4.close();
    db3.close();
    db2.close();
  });
});
