import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { type Clock, formatLocalTimeHm } from "../core/clock.ts";
import type { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type ConcernRecord,
  type EventLogRecord,
  type HormoneState,
  type SolitaryActionKind,
  type SolitaryProject,
  type SolitaryProjectsFile,
  SolitaryProjectsFileSchema,
} from "../core/schemas.ts";
import type { ResolvedEndocrineProfile } from "../endocrine/archetypes.ts";
import type { OrganModelRouter } from "../llm/router.ts";
import { runToolLoop } from "../llm/tool-runner.ts";
import type { ZodTool } from "../llm/types.ts";
import {
  createWorldFeedFetcher,
  type WorldFeedFetcher,
  type WorldFeedItem,
} from "../perception/world-feed.ts";
import { appendHotJournalEntry } from "./journal.ts";

export interface SolitaryTickOptions {
  clock: Clock;
  db: EchoreDatabase;
  memoryDir: string;
  profile: ResolvedEndocrineProfile;
  router: OrganModelRouter;
  actionKind?: SolitaryActionKind;
  feedFetcher?: WorldFeedFetcher;
  tools?: ZodTool[];
  overrideNoteText?: string;
}

export interface SolitaryTickResult {
  actionKind: SolitaryActionKind;
  artifactRelPath: string;
  firstPersonNote: string;
  journalEntry: string;
  eventRecord: EventLogRecord;
  hormoneStateAfter: HormoneState;
  updatedProject?: SolitaryProject;
  preppedConcernId?: string;
  feedItemsRead?: WorldFeedItem[];
}

const DEFAULT_SOLITARY_PROJECTS: SolitaryProjectsFile = {
  projects: [
    {
      id: "proj-city-night-notes",
      title: "《城市夜行与旧器物观察手记》",
      description: "按章节整理散步、阅读与旧物观察的私人连载笔记",
      cursor: 0,
      nodes: [
        {
          id: "ch1",
          title: "第一章：雨天廊檐与旧书店气味",
          status: "in_progress",
        },
        {
          id: "ch2",
          title: "第二章：深夜电台里的冷门器乐清单",
          status: "pending",
        },
        {
          id: "ch3",
          title: "第三章：街角小馆与时令食材备忘",
          status: "pending",
        },
      ],
    },
  ],
};

export function loadOrInitSolitaryProjects(
  memoryDir: string,
): SolitaryProjectsFile {
  const solitaryDir = path.join(memoryDir, "solitary");
  fs.mkdirSync(solitaryDir, { recursive: true });
  const filePath = path.join(solitaryDir, "projects.yaml");

  if (!fs.existsSync(filePath)) {
    const initialYaml = YAML.stringify(DEFAULT_SOLITARY_PROJECTS);
    fs.writeFileSync(filePath, initialYaml, "utf8");
    return structuredClone(DEFAULT_SOLITARY_PROJECTS);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw);
  return SolitaryProjectsFileSchema.parse(parsed);
}

export function saveSolitaryProjects(
  memoryDir: string,
  projectsFile: SolitaryProjectsFile,
): void {
  const validated = SolitaryProjectsFileSchema.parse(projectsFile);
  const solitaryDir = path.join(memoryDir, "solitary");
  fs.mkdirSync(solitaryDir, { recursive: true });
  const filePath = path.join(solitaryDir, "projects.yaml");
  fs.writeFileSync(filePath, YAML.stringify(validated), "utf8");
}

function sanitizeFirstPersonText(raw: string): string {
  const cleaned = raw
    .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  assertNoInternalLeaks(cleaned, "solitary");
  return cleaned;
}

async function generateFirstPersonSolitaryNote(params: {
  router: OrganModelRouter;
  profile: ResolvedEndocrineProfile;
  systemTaskHint: string;
  userPrompt: string;
  fallbackText: string;
  tools?: ZodTool[];
  overrideNoteText?: string;
}): Promise<string> {
  if (params.overrideNoteText?.trim()) {
    return sanitizeFirstPersonText(params.overrideNoteText);
  }

  const route = params.router.getRoute("frontstage");
  const system = [
    `# 住户身份：${params.profile.name}`,
    params.profile.core_persona,
    `独居习性提示：${params.profile.mood_action_slots.when_bored_alone}`,
    "",
    params.systemTaskHint,
    "铁律：",
    "- 必须全程使用第一人称“我”撰写，保留真实脾气与主观感受；",
    "- 严禁暴露任何系统参数、激素数字或 log-* 编号；",
    "- 只输出纯正文笔记（2~4 句话），不要包裹多余代码块。",
  ].join("\n");

  let rawReplyText = "";
  if (params.tools && params.tools.length > 0) {
    const loopRes = await runToolLoop({
      provider: route.provider,
      tools: params.tools,
      maxSteps: 6,
      initialRequest: {
        mode: "standard",
        request: {
          model: route.model,
          maxTokens: 360,
          system,
          messages: [{ role: "user", content: params.userPrompt }],
          tools: params.tools,
        },
      },
    });
    rawReplyText = loopRes.finalResponse.text;
  } else {
    const resp = await route.provider.generate({
      model: route.model,
      maxTokens: 360,
      system,
      messages: [{ role: "user", content: params.userPrompt }],
    });
    rawReplyText = resp.text;
  }

  const text = rawReplyText.trim() || params.fallbackText;
  const normalized =
    text.includes("我") || text.includes("自己") ? text : `我${text}`;
  return sanitizeFirstPersonText(normalized);
}

/**
 * 提取已为某条牵挂准备好的暗中备忘（供环 1 / 环 2 主动关心消费）
 */
export function extractSecretPrepForConcern(
  memoryDir: string,
  concernId: string,
): string | null {
  const prepPath = path.join(memoryDir, "solitary", "prep_for_user.md");
  if (!fs.existsSync(prepPath)) return null;
  const content = fs.readFileSync(prepPath, "utf8");
  const escapedId = concernId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `###\\s*\\[${escapedId}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n###\\s*\\[|$)`,
    "gi",
  );
  const matches = Array.from(content.matchAll(re));
  if (matches.length === 0) return null;
  return matches[matches.length - 1]?.[1]?.trim() || null;
}

/**
 * 根据当前状态择定独居行动类型（若未显式指定）：
 * 优先为用户未准备的活跃日常惦记做 S3 暗中准备，否则在 S1 与 S2 间交替
 */
export function pickSolitaryActionKind(params: {
  db: EchoreDatabase;
  memoryDir: string;
  explicitKind?: SolitaryActionKind;
}): { kind: SolitaryActionKind; targetConcern?: ConcernRecord } {
  const unpreppedMinorWorry = params.db
    .listActiveConcerns()
    .find(
      (c) =>
        c.status === "有效" && c.tier === "minor_worry" && !c.has_prep,
    );

  if (params.explicitKind) {
    return {
      kind: params.explicitKind,
      targetConcern: unpreppedMinorWorry,
    };
  }

  if (unpreppedMinorWorry) {
    return { kind: "secret_prep", targetConcern: unpreppedMinorWorry };
  }

  const projectsFile = loadOrInitSolitaryProjects(params.memoryDir);
  const hasPendingNode = projectsFile.projects.some((p) =>
    p.nodes.some((n) => n.status !== "done"),
  );
  if (hasPendingNode) {
    return { kind: "hobby_project" };
  }

  return { kind: "feed_roaming" };
}

/**
 * §6.2 & §6.3 独居生活引擎：执行一次留物证的独居行动（S1 / S2 / S3），
 * 落盘物证、追加 journal 热记事，并将多巴胺回血至舒适线 B_da
 */
export async function runSolitaryTick(
  options: SolitaryTickOptions,
): Promise<SolitaryTickResult> {
  const {
    clock,
    db,
    memoryDir,
    profile,
    router,
    feedFetcher = createWorldFeedFetcher(),
    tools,
    overrideNoteText,
  } = options;

  const now = clock.now();
  const nowIso = clock.nowIso();
  const dateStr = clock.todayStr();
  const timeStr = formatLocalTimeHm(now);

  const solitaryDir = path.join(memoryDir, "solitary");
  fs.mkdirSync(solitaryDir, { recursive: true });

  const picked = pickSolitaryActionKind({
    db,
    memoryDir,
    explicitKind: options.actionKind,
  });
  const actionKind = picked.kind;

  let artifactRelPath = "";
  let firstPersonNote = "";
  let updatedProject: SolitaryProject | undefined;
  let preppedConcernId: string | undefined;
  let feedItemsRead: WorldFeedItem[] | undefined;

  if (actionKind === "feed_roaming") {
    const items = await feedFetcher({ limit: 2 });
    feedItemsRead = items;
    const primary = items[0] ?? {
      id: "feed-fallback",
      title: "旧城区漫步指南",
      url: "https://example.com/walk",
      source: "随手翻阅",
      contentExcerpt: "午后街角的旧书店与咖啡馆。",
    };

    firstPersonNote = await generateFirstPersonSolitaryNote({
      router,
      profile,
      systemTaskHint:
        "你趁着独处闲暇翻到了感兴趣的一篇文章，请写下几句带自己脾气的阅读批注、槽点或摘抄感想。",
      userPrompt: [
        `文章标题：《${primary.title}》（来源：${primary.source}）`,
        `文章链接：${primary.url}`,
        `正文摘录：${primary.contentExcerpt}`,
      ].join("\n"),
      fallbackText: `我下午闲着翻到了《${primary.title}》，里面写到的细节挺对胃口，随手摘了几句留着回头聊。`,
      tools,
      overrideNoteText,
    });

    artifactRelPath = "solitary/reading_notes.md";
    const fullPath = path.join(memoryDir, artifactRelPath);
    const exists = fs.existsSync(fullPath);
    const header = exists ? "" : "# 独居阅读与冲浪批注\n\n";
    const block = [
      `## ${dateStr} ${timeStr} · [${primary.title}](${primary.url})`,
      `- 来源：${primary.source}`,
      `- 摘录：${primary.contentExcerpt}`,
      `> ${firstPersonNote}`,
      "",
    ].join("\n");
    fs.appendFileSync(fullPath, `${header}${block}\n`, "utf8");
  } else if (actionKind === "hobby_project") {
    const projectsFile = loadOrInitSolitaryProjects(memoryDir);
    if (projectsFile.projects.length === 0) {
      projectsFile.projects.push(
        structuredClone(DEFAULT_SOLITARY_PROJECTS.projects[0]!),
      );
    }
    const project =
      projectsFile.projects.find((p) =>
        p.nodes.some((n) => n.status !== "done"),
      ) ?? projectsFile.projects[0]!;
    let activeNode =
      project.nodes.find((n) => n.status === "in_progress") ??
      project.nodes.find((n) => n.status === "pending");

    if (!activeNode) {
      const nextIdx = project.nodes.length + 1;
      activeNode = {
        id: `ch${nextIdx}`,
        title: `第${nextIdx}章：日常延展手记`,
        status: "in_progress",
      };
      project.nodes.push(activeNode);
    }

    firstPersonNote = await generateFirstPersonSolitaryNote({
      router,
      profile,
      systemTaskHint:
        "你正在推进自己的跨天个人小项目（Persistent Goal Tree），请以第一人称完成当前章节/节点的具体手记内容。",
      userPrompt: [
        `项目名称：${project.title}`,
        `项目简介：${project.description}`,
        `当前推进节点：[${activeNode.id}] ${activeNode.title}`,
      ].join("\n"),
      fallbackText: `我趁着独处把${project.title}推进到了「${activeNode.title}」，整理好了这一节的观察笔记。`,
      tools,
      overrideNoteText,
    });

    const artifactsDir = path.join(solitaryDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    artifactRelPath = `solitary/artifacts/${project.id}-${activeNode.id}.md`;
    const artifactFullPath = path.join(memoryDir, artifactRelPath);

    const artifactContent = [
      `# ${project.title} · ${activeNode.title}`,
      ``,
      `- 完成时间：${dateStr} ${timeStr}`,
      `- 节点编号：\`${activeNode.id}\``,
      ``,
      firstPersonNote,
      ``,
    ].join("\n");
    fs.writeFileSync(artifactFullPath, artifactContent, "utf8");

    activeNode.status = "done";
    activeNode.artifact_path = artifactRelPath;
    activeNode.completed_at = nowIso;
    project.cursor += 1;

    const nextPending = project.nodes.find((n) => n.status === "pending");
    if (nextPending) {
      nextPending.status = "in_progress";
    }

    saveSolitaryProjects(memoryDir, projectsFile);
    updatedProject = structuredClone(project);
  } else {
    // S3: secret_prep（仅针对日常微澜惦记 tier === "minor_worry"，绝不将未解冲突当作贴心备忘目标）
    const targetConcern =
      picked.targetConcern ??
      db
        .listActiveConcerns()
        .find(
          (c) =>
            c.status === "有效" && c.tier === "minor_worry" && !c.has_prep,
        );

    const concernId = targetConcern?.id ?? "general-care";
    const concernSummary =
      targetConcern?.summary ?? "近期提到的日常安排与实用备忘";

    firstPersonNote = await generateFirstPersonSolitaryNote({
      router,
      profile,
      systemTaskHint:
        "你趁用户不在时，围绕心里惦记的他的近况或日程，暗中帮他查了点实用资料/攻略，请以第一人称写一份自然、贴心、带自己口吻的小备忘。",
      userPrompt: `惦记事项：${concernSummary}`,
      fallbackText: `我惦记着「${concernSummary}」，趁空闲顺手帮他翻了翻靠谱的注意事项与备忘清单，等他回来正好递过去。`,
      tools,
      overrideNoteText,
    });

    artifactRelPath = "solitary/prep_for_user.md";
    const prepFullPath = path.join(memoryDir, artifactRelPath);
    const exists = fs.existsSync(prepFullPath);
    const header = exists ? "" : "# 为他暗中准备的备忘清单\n\n";
    const block = [
      `### [${concernId}] 针对「${concernSummary}」的暗中准备 (${dateStr} ${timeStr})`,
      firstPersonNote,
      "",
    ].join("\n");
    fs.appendFileSync(prepFullPath, `${header}${block}\n`, "utf8");

    if (targetConcern) {
      db.markConcernHasPrep(targetConcern.id, true, nowIso);
      preppedConcernId = targetConcern.id;
    }
  }

  // 1. 落盘 SQLite Event Log (role: "solitary")
  const eventRecord = db.appendEventLog({
    timestamp: nowIso,
    role: "solitary",
    speaker: profile.name,
    content: firstPersonNote,
    metadata: {
      action_kind: actionKind,
      artifact_path: artifactRelPath,
      prepped_concern_id: preppedConcernId ?? null,
    },
  });

  // 2. 追加当日 journal/YYYY-MM-DD.md 第一人称独居热记事
  const journalEntry = appendHotJournalEntry({
    memoryDir,
    dateStr,
    timeStr,
    firstPersonText: firstPersonNote,
    tag: "独居",
  });

  // 3. 多巴胺回血至舒适基线 B_da 之上（带 +0.12 满足感缓冲，经数小时自然衰减后再滑入无聊区）
  const currentHormone = db.getHormoneState();
  const targetDopamine = Math.min(1.0, profile.baseline.dopamine + 0.12);
  const replenishedDopamine = Number(
    Math.max(currentHormone.dopamine, targetDopamine).toFixed(4),
  );
  const hormoneStateAfter: HormoneState = {
    ...currentHormone,
    dopamine: replenishedDopamine,
    updated_at: nowIso,
  };
  db.saveHormoneState(hormoneStateAfter);

  return {
    actionKind,
    artifactRelPath,
    firstPersonNote,
    journalEntry,
    eventRecord,
    hormoneStateAfter,
    updatedProject,
    preppedConcernId,
    feedItemsRead,
  };
}
