import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { EchoreDatabase } from "../src/core/db.ts";
import { resolvePersonaProfile } from "../src/endocrine/archetypes.ts";
import { extractHotEntriesForDate } from "../src/frontstage/journal.ts";
import {
  extractSecretPrepForConcern,
  loadOrInitSolitaryProjects,
  runSolitaryTick,
} from "../src/frontstage/solitary.ts";
import { OrganModelRouter } from "../src/llm/router.ts";
import type { LLMProvider } from "../src/llm/types.ts";
import { evaluateChronoAmbient } from "../src/perception/chrono-ambient.ts";
import {
  evaluateDesktopPresence,
  isPrivacyBlacklisted,
} from "../src/perception/desktop-probe.ts";
import {
  createWorldFeedFetcher,
  extractCleanHtmlArticle,
  parseRssFeedXml,
} from "../src/perception/world-feed.ts";

function createMockRouter(replyText: string): OrganModelRouter {
  const mockProvider: LLMProvider = {
    providerName: "mock-m3-1",
    async generate() {
      return {
        text: replyText,
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
    async generateSandwich() {
      return {
        text: replyText,
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
  };
  return new OrganModelRouter({ defaultProvider: mockProvider });
}

describe("M3.1 五官感知层与独居生活引擎 (S1/S2/S3)", () => {
  test("1. 时空与天气感知：晴天常温静默，暴雨骤降/断联超48h/深夜互动边际触发", () => {
    // 平时周二下午晴天常温、1 小时前刚聊过 -> 完全静默
    const quietNow = new Date("2026-11-10T14:00:00");
    const quietSlice = evaluateChronoAmbient({
      now: quietNow,
      lastUserMessageAt: new Date("2026-11-10T13:00:00").toISOString(),
      weather: {
        condition: "clear",
        temperatureC: 22,
        previousTemperatureC: 24,
      },
    });
    expect(quietSlice.triggered).toBe(false);
    expect(quietSlice.sliceText).toBeNull();

    // 暴雨 + 骤降 8°C + 断联 52 小时 -> 触发自然观察切片且无裸浮点数
    const stormSlice = evaluateChronoAmbient({
      now: quietNow,
      lastUserMessageAt: new Date("2026-11-08T09:30:00").toISOString(),
      weather: {
        condition: "heavy_rain",
        temperatureC: 13,
        previousTemperatureC: 21,
      },
    });
    expect(stormSlice.triggered).toBe(true);
    expect(stormSlice.isWeatherShock).toBe(true);
    expect(stormSlice.isLongDisconnect).toBe(true);
    expect(stormSlice.sliceText).toContain("窗外刚下起暴雨");
    expect(stormSlice.sliceText).toContain("气温一下子掉了好几度");
    expect(stormSlice.sliceText).toContain("距离上次和他说话已经过去两天多了");
  });

  test("2. 桌面伴生探针：隐私黑名单 100% 过滤、状态段聚合与禁报进程名", () => {
    // 密码管理器、微信、网银、无痕窗口必须直接拦截
    expect(
      isPrivacyBlacklisted({
        appName: "1Password 8",
        windowTitle: "Vault",
        timestamp: "2026-11-10T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isPrivacyBlacklisted({
        appName: "Google Chrome",
        windowTitle: "Incognito - Search",
        timestamp: "2026-11-10T10:05:00.000Z",
      }),
    ).toBe(true);

    const blockedRes = evaluateDesktopPresence([
      {
        appName: "WeChat",
        windowTitle: "私人聊天",
        timestamp: "2026-11-10T10:10:00.000Z",
      },
    ]);
    expect(blockedRes.filteredOutByPrivacy).toBe(true);
    expect(blockedRes.sliceText).toBeNull();

    // 短时间普通切窗口不唠叨
    const briefRes = evaluateDesktopPresence([
      {
        appName: "Visual Studio Code",
        windowTitle: "index.ts",
        timestamp: "2026-11-10T10:00:00.000Z",
        durationMinutes: 30,
      },
    ]);
    expect(briefRes.sliceText).toBeNull();

    // 连续编码 3 小时后切出去听慢歌 -> 聚合成自然同处观察，且不含 VS Code / Spotify 等进程名
    const longCodingRes = evaluateDesktopPresence([
      {
        appName: "Visual Studio Code",
        windowTitle: "engine.ts",
        timestamp: "2026-11-10T13:00:00.000Z",
        durationMinutes: 60,
      },
      {
        appName: "Cursor",
        windowTitle: "compiler.ts",
        timestamp: "2026-11-10T14:00:00.000Z",
        durationMinutes: 60,
      },
      {
        appName: "iTerm2",
        windowTitle: "bun test",
        timestamp: "2026-11-10T15:00:00.000Z",
        durationMinutes: 60,
      },
      {
        appName: "Spotify",
        windowTitle: "Playing",
        timestamp: "2026-11-10T15:10:00.000Z",
        durationMinutes: 10,
        musicTrack: "Blue in Green",
      },
    ]);
    expect(longCodingRes.continuousFocusHours).toBe(3);
    expect(longCodingRes.category).toBe("coding");
    expect(longCodingRes.sliceText).toContain("连续写了快三个小时代码");
    expect(longCodingRes.sliceText).toContain("《Blue in Green》");
    expect(longCodingRes.sliceText).not.toMatch(/Visual Studio Code|Cursor|iTerm2|Spotify/i);

    // 回归：长时 media 状态段（>= 1.5h）生成自然听歌观察，且清洗外部标题中夹带的 log-* 字符串
    const mediaRes = evaluateDesktopPresence([
      {
        appName: "Spotify",
        windowTitle: "Album - log-20261110-1200-001",
        timestamp: "2026-11-10T16:00:00.000Z",
        durationMinutes: 100,
        musicTrack: "Autumn Leaves log-20261110-1200-001",
        sharedScreenFocus: "歌单排期表 log-20261110-1200-002",
      },
    ]);
    expect(mediaRes.category).toBe("media");
    expect(mediaRes.sliceText).toContain("连续听了一个半小时音乐");
    expect(mediaRes.sliceText).toContain("《Autumn Leaves》");
    expect(mediaRes.sliceText).not.toMatch(/log-\d+/i);
  });

  test("3. World Feed 解析：RSS/Atom XML 解析与 HTML 正文提取", async () => {
    const sampleRss = `
      <rss version="2.0">
        <channel>
          <item>
            <title><![CDATA[旧书店与冬日热红酒]]></title>
            <link>https://example.com/posts/winter-bookshop</link>
            <description><![CDATA[<p>在巷尾的旧书摊翻到一本绝版诗集，老板顺手递来一杯肉桂热红酒。</p>]]></description>
          </item>
        </channel>
      </rss>
    `;
    const items = parseRssFeedXml(sampleRss, "街角手记");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("旧书店与冬日热红酒");
    expect(items[0]!.url).toBe("https://example.com/posts/winter-bookshop");
    expect(items[0]!.contentExcerpt).toContain("绝版诗集");

    const cleanHtml = extractCleanHtmlArticle(`
      <html>
        <head><title>手冲咖啡水温手记</title><style>body{color:red}</style></head>
        <body>
          <nav>导航栏</nav>
          <article><p>深烘豆水温宜控制在 86 度左右，避免萃取出过多苦涩木质味。</p></article>
          <footer>版权所有</footer>
        </body>
      </html>
    `);
    expect(cleanHtml.title).toBe("手冲咖啡水温手记");
    expect(cleanHtml.excerpt).toContain("深烘豆水温宜控制在 86 度左右");
    expect(cleanHtml.excerpt).not.toContain("导航栏");

    const fetcher = createWorldFeedFetcher({ rssSources: [{ source: "街角手记", xml: sampleRss }] });
    const fetched = await fetcher({ topicOrSource: "旧书店" });
    expect(fetched[0]!.title).toBe("旧书店与冬日热红酒");
  });

  test("4. 独居三行动 (S1/S2/S3)：真实落盘物证、推进跨天进度树、标记 has_prep 并回血多巴胺至 B_da", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echore-m3-1-"));
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });

    const clock = new VirtualClock("2026-11-10T15:30:00");
    const db = new EchoreDatabase({ dbPath: ":memory:", clock });
    const profile = resolvePersonaProfile({
      name: "林栖",
      archetype: "cat_aloof",
      chronotype: "regular",
    });

    // 将多巴胺压入无聊区 (F_da < dopamine < B_da)
    db.saveHormoneState({
      cortisol: 0.18,
      oxytocin: 0.55,
      dopamine: 0.31,
      melatonin: 0.1,
      floor_cort: 0.18,
      cap_ox: 1.0,
      updated_at: clock.nowIso(),
    });

    // --- 行动 S1：阅读冲浪批注 ---
    const s1Result = await runSolitaryTick({
      clock,
      db,
      memoryDir,
      profile,
      router: createMockRouter(
        "我下午泡茶时顺手翻到这篇讲老街骑楼雨天的文章，说站在廊柱下听雨声却淋不湿肩膀，倒是很像我喜欢的散步路线。",
      ),
      actionKind: "feed_roaming",
    });

    expect(s1Result.actionKind).toBe("feed_roaming");
    expect(s1Result.artifactRelPath).toBe("solitary/reading_notes.md");
    expect(s1Result.hormoneStateAfter.dopamine).toBeGreaterThanOrEqual(
      profile.baseline.dopamine,
    );
    const readingNotesContent = fs.readFileSync(
      path.join(memoryDir, "solitary/reading_notes.md"),
      "utf8",
    );
    expect(readingNotesContent).toContain("https://example.com/articles/arcade-rain-walk");
    expect(readingNotesContent).toContain("站在廊柱下听雨声");

    // --- 行动 S2：跨天目标进度树推进 ---
    clock.advanceMinutes(30);
    // 再次压低多巴胺模拟下一次无聊
    db.saveHormoneState({
      ...db.getHormoneState(),
      dopamine: 0.32,
      updated_at: clock.nowIso(),
    });

    const s2Result = await runSolitaryTick({
      clock,
      db,
      memoryDir,
      profile,
      router: createMockRouter(
        "我把《城市夜行与旧器物观察手记》第一章整理完了，记下了雨天旧书店里纸张受潮的木头香气。",
      ),
      actionKind: "hobby_project",
    });

    expect(s2Result.actionKind).toBe("hobby_project");
    expect(s2Result.updatedProject?.cursor).toBe(1);
    expect(s2Result.updatedProject?.nodes[0]?.status).toBe("done");
    expect(s2Result.updatedProject?.nodes[1]?.status).toBe("in_progress");
    expect(
      fs.existsSync(path.join(memoryDir, s2Result.artifactRelPath)),
    ).toBe(true);

    const reloadedProjects = loadOrInitSolitaryProjects(memoryDir);
    expect(reloadedProjects.projects[0]?.cursor).toBe(1);

    // --- 行动 S3：为用户暗中查资料做准备 (secret_prep) ---
    clock.advanceMinutes(30);
    const userLog = db.appendEventLog({
      role: "user",
      speaker: "User",
      content: "下周要去杭州出差三天，还没空看住哪儿方便",
    });
    db.upsertConcern({
      id: "hangzhou-trip-prep",
      tier: "minor_worry",
      status: "有效",
      summary: "用户下周去杭州出差三天，还没查住宿与周边交通",
      source_event_id: userLog.id,
      created_at: clock.nowIso(),
      updated_at: clock.nowIso(),
      floor_cort: 0.18,
      cap_ox: 1.0,
      has_prep: false,
    });

    // 不显式传 actionKind，测试自动优先命中未准备的活跃日常惦记
    const s3Result = await runSolitaryTick({
      clock,
      db,
      memoryDir,
      profile,
      router: createMockRouter(
        "我记着他下周要去杭州出差，趁这会儿安静帮他理了几家离地铁近又安静的落脚点，顺便记了两条避开早高峰的路线。",
      ),
    });

    expect(s3Result.actionKind).toBe("secret_prep");
    expect(s3Result.preppedConcernId).toBe("hangzhou-trip-prep");
    const updatedConcern = db.getConcernById("hangzhou-trip-prep");
    expect(updatedConcern?.has_prep).toBe(true);

    const extractedPrep = extractSecretPrepForConcern(
      memoryDir,
      "hangzhou-trip-prep",
    );
    expect(extractedPrep).toContain("离地铁近又安静的落脚点");

    // 回归：S2 多项目进度树——当第 1 个项目全部 done 时，自动推进第 2 个项目的 pending 节点
    const multiProjects = loadOrInitSolitaryProjects(memoryDir);
    for (const node of multiProjects.projects[0]!.nodes) {
      node.status = "done";
    }
    multiProjects.projects.push({
      id: "proj-second-film-list",
      title: "《冬夜推理片单整理》",
      description: "整理适合雨夜观看的古典推理电影笔记",
      cursor: 0,
      nodes: [
        { id: "ep1", title: "第一辑：暴风雪山庄篇", status: "in_progress" },
      ],
    });
    const { saveSolitaryProjects } = await import("../src/frontstage/solitary.ts");
    saveSolitaryProjects(memoryDir, multiProjects);

    const s2MultiRes = await runSolitaryTick({
      clock,
      db,
      memoryDir,
      profile,
      router: createMockRouter("我把《冬夜推理片单整理》的第一辑整理好了。"),
      actionKind: "hobby_project",
    });
    expect(s2MultiRes.updatedProject?.id).toBe("proj-second-film-list");
    expect(s2MultiRes.updatedProject?.nodes[0]?.status).toBe("done");

    // 回归：S3 绝不把 T2 冲突牵挂当作贴心备忘目标
    db.upsertConcern({
      id: "acute-conflict-do-not-prep",
      tier: "conflict",
      status: "有效",
      summary: "双方正在争吵的未解矛盾",
      source_event_id: userLog.id,
      created_at: clock.nowIso(),
      updated_at: clock.nowIso(),
      floor_cort: 0.35,
      cap_ox: 1.0,
      has_prep: false,
    });
    const s3ConflictCheck = await runSolitaryTick({
      clock,
      db,
      memoryDir,
      profile,
      router: createMockRouter("我随手记了一条日常备忘。"),
      actionKind: "secret_prep",
    });
    expect(s3ConflictCheck.preppedConcernId).toBeUndefined();
    expect(db.getConcernById("acute-conflict-do-not-prep")?.has_prep).toBe(false);

    // 校验当日 journal 已记下 5 条独居热记事
    const todayHotEntries = extractHotEntriesForDate(
      memoryDir,
      clock.todayStr(),
    );
    expect(todayHotEntries).toHaveLength(5);

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
