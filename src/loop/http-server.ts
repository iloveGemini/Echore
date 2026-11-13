import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { formatLocalTimeHm, VirtualClock } from "../core/clock.ts";
import { EchoreDatabase } from "../core/db.ts";
import {
  assertNoInternalLeaks,
  type ChronotypeId,
  GenesisInitRequestSchema,
  type GenesisStatus,
  type NamingMode,
  type NamingState,
  PersonaConfigSchema,
  SolitaryActionKindSchema,
  type SubconsciousHandover,
  WeatherSnapshotSchema,
} from "../core/schemas.ts";
import { ARCHETYPE_PRESETS } from "../endocrine/archetypes.ts";
import { buildSubconsciousHandover } from "../endocrine/handover.ts";
import { stepHormones } from "../endocrine/hormones.ts";
import {
  extractColdReflectionForDate,
  extractHotEntriesForDate,
} from "../frontstage/journal.ts";
import { loadOrInitSolitaryProjects } from "../frontstage/solitary.ts";
import { syncMemoryMetaFromFiles } from "../hippocampus/decay.ts";
import { runMemoryLinter } from "../hippocampus/linter.ts";
import {
  createOrganRouterFromEnv,
  OrganModelRouter,
} from "../llm/router.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { DesktopWindowSample } from "../perception/desktop-probe.ts";
import { evaluateReflexGuard } from "../reflex/guard.ts";
import { EchoreEngine } from "./engine.ts";
import { TimeTravelSimulator } from "./simulator.ts";

export interface CompanionMessageItem {
  role: "user" | "assistant";
  speaker: string;
  content: string;
  timestamp: string;
  producer?: string;
  source?: string;
  proactive?: boolean;
}

export interface CompanionStateResponse {
  genesisStatus: GenesisStatus;
  namingMode: NamingMode;
  namingState: NamingState;
  personaName: string;
  userName: string;
  userPronoun: string;
  relationship: string;
  chronotype: ChronotypeId;
  currentDate: string;
  currentTime: string;
  handover: SubconsciousHandover;
  messages: CompanionMessageItem[];
}

export interface CompanionChatResponse {
  reply: string;
  handover: SubconsciousHandover;
  journalEntry: string;
  currentDate: string;
  currentTime: string;
  consumedPrepConcernIds: string[];
}

export type SseEventType =
  | "connected"
  | "chat_turn"
  | "proactive_message"
  | "heartbeat"
  | "fast_forward"
  | "sleep_cycle"
  | "persona_updated";

export interface SseEventPayload {
  type: SseEventType;
  timestamp: string;
  data: unknown;
}

const DesktopWindowSampleSchema = z.object({
  appName: z.string(),
  windowTitle: z.string(),
  timestamp: z.string(),
  durationMinutes: z.number().optional(),
  musicTrack: z.string().optional(),
  sharedScreenFocus: z.string().optional(),
});

const ChatRequestBodySchema = z.object({
  message: z.string().min(1),
  weather: WeatherSnapshotSchema.optional(),
  desktopSamples: z.array(DesktopWindowSampleSchema).optional(),
  isHolidayOrAnniversary: z.string().optional(),
  userActiveLateNight: z.boolean().optional(),
});

const HeartbeatRequestBodySchema = z
  .object({
    weather: WeatherSnapshotSchema.optional(),
    desktopSamples: z.array(DesktopWindowSampleSchema).optional(),
    isHolidayOrAnniversary: z.string().optional(),
    userActiveLateNight: z.boolean().optional(),
    solitaryActionKind: SolitaryActionKindSchema.optional(),
    overrideProactiveText: z.string().optional(),
    overrideSolitaryNoteText: z.string().optional(),
  })
  .optional();

const FastForwardRequestBodySchema = z.object({
  duration: z.union([z.string().min(1), z.number().positive()]),
  stepMinutes: z.number().positive().optional(),
  disableGitCommit: z.boolean().optional(),
});

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function assertCompanionSafePayload(payload: unknown, label: string): void {
  const serialized = JSON.stringify(payload);
  assertNoInternalLeaks(serialized, label);
}

export interface EchoreHttpApp {
  readonly engine: EchoreEngine;
  readonly simulator: TimeTravelSimulator;
  fetch: (req: Request) => Promise<Response>;
  broadcastEvent: (type: SseEventType, data: unknown) => void;
  getSubscriberCount: () => number;
}

/**
 * §6.5 & m3-contracts §4：主场模式极薄 HTTP + SSE 服务层
 * 严格隔离「陪伴主视图（Companion Surface · 零浮点数/零 log-*）」与「造物主观测台（Observatory Surface）」
 */
export function createEchoreHttpApp(options: {
  engine: EchoreEngine;
  simulator?: TimeTravelSimulator;
  staticDir?: string;
}): EchoreHttpApp {
  const { engine } = options;
  const simulator = options.simulator ?? new TimeTravelSimulator(engine);
  const staticDir = options.staticDir ?? path.resolve(process.cwd(), "web");
  const sseSubscribers = new Set<(chunk: string) => void>();

  const broadcastEvent = (type: SseEventType, data: unknown): void => {
    if (type === "chat_turn" || type === "proactive_message") {
      assertCompanionSafePayload(data, `sse.${type}`);
    }
    const envelope: SseEventPayload = {
      type,
      timestamp: engine.clock.nowIso(),
      data,
    };
    const frame = `event: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const send of sseSubscribers) {
      try {
        send(frame);
      } catch {
        sseSubscribers.delete(send);
      }
    }
  };

  const buildCompanionState = (): CompanionStateResponse => {
    const now = engine.clock.now();
    const activeConcerns = engine.db.listActiveConcerns();
    const steppedHormones = stepHormones({
      state: engine.db.getHormoneState(),
      profile: engine.profile,
      now,
      activeConcerns,
    });
    engine.db.saveHormoneState(steppedHormones);

    const handover = buildSubconsciousHandover({
      hormoneState: steppedHormones,
      profile: engine.profile,
      activeConcerns,
      db: engine.db,
      now,
    });

    const recentLogs = engine.db
      .getRecentEventLogs(40)
      .filter((r) => r.role === "user" || r.role === "assistant");

    const messages: CompanionMessageItem[] = recentLogs.map((r) => ({
      role: r.role as "user" | "assistant",
      speaker: r.speaker,
      content: r.content.replace(/\blog-\d{4,}[-\w]*\b/gi, "").trim(),
      timestamp: r.timestamp,
      producer: r.producer,
      source: r.source,
      ...(r.metadata?.proactive ? { proactive: true } : {}),
    }));

    const state: CompanionStateResponse = {
      genesisStatus: engine.genesisStatus,
      namingMode: engine.namingMode,
      namingState: engine.namingState,
      personaName: engine.profile.name,
      userName: engine.profile.user_name ?? "用户",
      userPronoun: engine.profile.user_pronoun ?? "他",
      relationship: engine.profile.relationship ?? "初识",
      chronotype: engine.profile.chronotype,
      currentDate: engine.clock.todayStr(),
      currentTime: formatLocalTimeHm(now),
      handover,
      messages,
    };

    assertCompanionSafePayload(state, "http.companion.state");
    return state;
  };

  const buildObservatoryState = () => {
    const now = engine.clock.now();
    const todayStr = engine.clock.todayStr();
    const activeConcerns = engine.db.listActiveConcerns();
    const allConcerns = engine.db.listAllConcerns();
    const hormoneState = stepHormones({
      state: engine.db.getHormoneState(),
      profile: engine.profile,
      now,
      activeConcerns,
    });
    engine.db.saveHormoneState(hormoneState);

    const reflexState = engine.db.getReflexState();
    const reflexEvaluation = evaluateReflexGuard({
      reflexState,
      melatonin: hormoneState.melatonin,
      now,
      chronotype: engine.profile.chronotype,
    });

    syncMemoryMetaFromFiles({
      memoryDir: engine.memoryDir,
      db: engine.db,
      now,
    });
    const memoryMeta = engine.db.listAllMemoryMeta();
    const solitaryProjects = loadOrInitSolitaryProjects(engine.memoryDir);
    const todayHotEntries = extractHotEntriesForDate(
      engine.memoryDir,
      todayStr,
    );
    const todayColdReflection = extractColdReflectionForDate(
      engine.memoryDir,
      todayStr,
    );
    const lintReport = runMemoryLinter({
      memoryDir: engine.memoryDir,
      db: engine.db,
      now,
    });
    const memorySnapshots = engine.db.listMemorySnapshots();
    const systemLogs = engine.db.listSystemLogs({ limit: 50 });
    const configEpoch = engine.db.getConfigEpoch();
    const recentEvents = engine.db.getRecentEventLogs(40);

    return {
      clock: {
        nowIso: engine.clock.nowIso(),
        todayStr,
        localTimeHm: formatLocalTimeHm(now),
      },
      profile: engine.profile,
      hormoneState,
      reflexState,
      reflexEvaluation,
      activeConcerns,
      allConcerns,
      memoryMeta,
      solitaryProjects,
      todayHotEntries,
      todayColdReflection,
      lintReport,
      memorySnapshots,
      systemLogs,
      configEpoch,
      recentEvents,
    };
  };

  const fetch = async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const pathname = url.pathname;

    try {
      // 1. SSE 实时事件流 或 JSON 事件列表: GET /api/events
      if (req.method === "GET" && pathname === "/api/events") {
        const accept = req.headers.get("accept") ?? "";
        if (
          url.searchParams.get("format") === "json" ||
          (accept.includes("application/json") &&
            !accept.includes("text/event-stream"))
        ) {
          const limit = Number(url.searchParams.get("limit") || 40);
          return jsonResponse({
            configEpoch: engine.db.getConfigEpoch(),
            events: engine.db.getRecentEventLogs(limit),
          });
        }
        const encoder = new TextEncoder();
        let subscriberFn: ((chunk: string) => void) | null = null;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            subscriberFn = (chunk: string) => {
              controller.enqueue(encoder.encode(chunk));
            };
            sseSubscribers.add(subscriberFn);

            const initEnvelope: SseEventPayload = {
              type: "connected",
              timestamp: engine.clock.nowIso(),
              data: {
                personaName: engine.profile.name,
                currentDate: engine.clock.todayStr(),
                currentTime: formatLocalTimeHm(engine.clock.now()),
              },
            };
            controller.enqueue(
              encoder.encode(
                `event: connected\ndata: ${JSON.stringify(initEnvelope)}\n\n`,
              ),
            );
          },
          cancel() {
            if (subscriberFn) {
              sseSubscribers.delete(subscriberFn);
            }
          },
        });

        req.signal?.addEventListener("abort", () => {
          if (subscriberFn) {
            sseSubscribers.delete(subscriberFn);
          }
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            ...CORS_HEADERS,
          },
        });
      }

      // 2. 陪伴主视图状态: GET /api/companion/state
      if (req.method === "GET" && pathname === "/api/companion/state") {
        return jsonResponse(buildCompanionState());
      }

      // 2.5 门口 Genesis 状态与出生初始化: GET /api/genesis/status & POST /api/genesis/init
      if (req.method === "GET" && pathname === "/api/genesis/status") {
        const statusPayload = engine.getGenesisStatus();
        assertCompanionSafePayload(statusPayload, "http.genesis.status");
        return jsonResponse(statusPayload);
      }

      if (req.method === "POST" && pathname === "/api/genesis/init") {
        const rawBody = await req.json();
        const GenesisHttpBodySchema = GenesisInitRequestSchema.extend({
          weather: WeatherSnapshotSchema.optional(),
        });
        const parsed = GenesisHttpBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid genesis init body: ${parsed.error.message}` },
            400,
          );
        }
        const { weather, ...genesisInput } = parsed.data;
        const initRes = await engine.initializeGenesis(genesisInput, {
          weather,
        });
        const responsePayload = {
          genesisStatus: initRes.genesisStatus,
          namingMode: initRes.namingMode,
          namingState: initRes.namingState,
          residentName: initRes.profile.name,
          userName: initRes.profile.user_name ?? "用户",
          userPronoun: initRes.profile.user_pronoun ?? "他",
          relationship: initRes.profile.relationship ?? "初识",
          openingMessage: initRes.openingMessage,
          handover: initRes.handover,
        };
        assertCompanionSafePayload(responsePayload, "http.genesis.init");
        broadcastEvent("persona_updated", {
          name: initRes.profile.name,
          user_name: initRes.profile.user_name,
          user_pronoun: initRes.profile.user_pronoun,
          relationship: initRes.profile.relationship,
          dominant_archetype: initRes.profile.dominant_archetype,
          chronotype: initRes.profile.chronotype,
        });
        broadcastEvent("proactive_message", {
          speaker: initRes.profile.name,
          content: initRes.openingMessage,
          trigger: "genesis_opening",
          handover: initRes.handover,
          currentDate: engine.clock.todayStr(),
          currentTime: formatLocalTimeHm(engine.clock.now()),
        });
        return jsonResponse(responsePayload);
      }

      // 3. 实时对话 (环 1): POST /api/chat
      if (req.method === "POST" && pathname === "/api/chat") {
        const rawBody = await req.json();
        const parsed = ChatRequestBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid request body: ${parsed.error.message}` },
            400,
          );
        }

        const prevIdentityKey = `${engine.profile.name}|${engine.profile.user_name ?? ""}|${engine.profile.user_pronoun ?? ""}|${engine.profile.relationship ?? ""}`;
        const turnOut = await engine.onUserMessage(parsed.data.message, {
          weather: parsed.data.weather,
          desktopSamples: parsed.data.desktopSamples as
            | DesktopWindowSample[]
            | undefined,
          isHolidayOrAnniversary: parsed.data.isHolidayOrAnniversary,
          userActiveLateNight: parsed.data.userActiveLateNight,
        });
        const nextIdentityKey = `${engine.profile.name}|${engine.profile.user_name ?? ""}|${engine.profile.user_pronoun ?? ""}|${engine.profile.relationship ?? ""}`;
        if (nextIdentityKey !== prevIdentityKey) {
          broadcastEvent("persona_updated", {
            name: engine.profile.name,
            user_name: engine.profile.user_name,
            user_pronoun: engine.profile.user_pronoun,
            relationship: engine.profile.relationship,
            dominant_archetype: engine.profile.dominant_archetype,
            chronotype: engine.profile.chronotype,
          });
        }

        const now = engine.clock.now();
        const companionResp: CompanionChatResponse = {
          reply: turnOut.reply,
          handover: turnOut.handover,
          journalEntry: turnOut.journalEntry,
          currentDate: engine.clock.todayStr(),
          currentTime: formatLocalTimeHm(now),
          consumedPrepConcernIds: turnOut.consumedPrepConcernIds ?? [],
        };

        assertCompanionSafePayload(companionResp, "http.companion.chat");
        broadcastEvent("chat_turn", {
          userMessage: parsed.data.message,
          reply: companionResp.reply,
          handover: companionResp.handover,
          currentDate: companionResp.currentDate,
          currentTime: companionResp.currentTime,
        });

        return jsonResponse(companionResp);
      }

      // 4. 造物主观测台状态: GET /api/observatory/state
      if (req.method === "GET" && pathname === "/api/observatory/state") {
        return jsonResponse(buildObservatoryState());
      }

      // 5. 单步自主心跳 (环 2): POST /api/heartbeat
      if (req.method === "POST" && pathname === "/api/heartbeat") {
        let rawBody: unknown = undefined;
        const text = await req.text();
        if (text.trim()) {
          rawBody = JSON.parse(text);
        }
        const parsed = HeartbeatRequestBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid request body: ${parsed.error.message}` },
            400,
          );
        }

        const hbOut = await engine.onHeartbeat(parsed.data ?? {});

        if (hbOut.branch === "proactive" && hbOut.proactiveMessage) {
          broadcastEvent("proactive_message", {
            speaker: engine.profile.name,
            content: hbOut.proactiveMessage,
            trigger: hbOut.proactiveTrigger,
            currentDate: engine.clock.todayStr(),
            currentTime: formatLocalTimeHm(engine.clock.now()),
          });
        }
        broadcastEvent("heartbeat", {
          branch: hbOut.branch,
          hormoneState: hbOut.hormoneState,
          proactiveTrigger: hbOut.proactiveTrigger,
          solitaryActionKind: hbOut.solitaryResult?.actionKind,
        });

        return jsonResponse(hbOut);
      }

      // 6. 时间快进仿真: POST /api/fast-forward
      if (req.method === "POST" && pathname === "/api/fast-forward") {
        const rawBody = await req.json();
        const parsed = FastForwardRequestBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid request body: ${parsed.error.message}` },
            400,
          );
        }

        const report = await simulator.fastForward(parsed.data.duration, {
          stepMinutes: parsed.data.stepMinutes,
          disableGitCommit: parsed.data.disableGitCommit ?? true,
        });

        broadcastEvent("fast_forward", {
          durationSpec: report.durationSpec,
          elapsedHours: report.elapsedHours,
          daysCrossed: report.daysCrossed,
          branchCounts: report.branchCounts,
          finalHormoneState: report.finalHormoneState,
        });

        return jsonResponse(report);
      }

      // 7. 手动触发睡眠代谢 (环 3): POST /api/sleep
      if (req.method === "POST" && pathname === "/api/sleep") {
        const sleepOut = await engine.runSleepCycle({ autoGitCommit: false });
        broadcastEvent("sleep_cycle", {
          dateStr: sleepOut.dateStr,
          coldReflection: sleepOut.coldReflection,
          archivedIds: sleepOut.decayReport.archivedIds,
          lintPassed: sleepOut.lintReport.passed,
        });
        return jsonResponse(sleepOut);
      }

      // 8. 观测台：获取 5 套内置人设原型与当前人设详情: GET /api/observatory/archetypes
      if (req.method === "GET" && pathname === "/api/observatory/archetypes") {
        return jsonResponse({
          current: {
            name: engine.profile.name,
            dominant_archetype: engine.profile.dominant_archetype,
            chronotype: engine.profile.chronotype,
            baseline: engine.profile.baseline,
            resting_floor: engine.profile.resting_floor,
            sensitivity: engine.profile.sensitivity,
            half_life_hours: engine.profile.half_life_hours,
            fast_relief_ratio: engine.profile.fast_relief_ratio,
            mood_action_slots: engine.profile.mood_action_slots,
          },
          presets: ARCHETYPE_PRESETS,
        });
      }

      // 9. 观测台：切换/覆写性格原型: POST /api/observatory/persona
      if (req.method === "POST" && pathname === "/api/observatory/persona") {
        const rawBody = await req.json();
        const UpdatePersonaBodySchema = z.object({
          persona: PersonaConfigSchema,
          resetHormonesToBaseline: z.boolean().optional(),
        });
        const parsed = UpdatePersonaBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid persona update body: ${parsed.error.message}` },
            400,
          );
        }
        const newProfile = engine.updatePersona(parsed.data.persona, {
          resetHormonesToBaseline: parsed.data.resetHormonesToBaseline,
        });
        broadcastEvent("persona_updated", {
          name: newProfile.name,
          dominant_archetype: newProfile.dominant_archetype,
          chronotype: newProfile.chronotype,
        });
        return jsonResponse({
          success: true,
          profile: newProfile,
        });
      }

      // 9.5 观测台：SAVEPOINT 零副作用假设推演 (Wave 7.1): POST /api/observatory/what-if
      if (req.method === "POST" && pathname === "/api/observatory/what-if") {
        const rawBody = await req.json();
        const WhatIfBodySchema = z.object({
          userMessage: z.string().optional(),
          fastForwardMinutes: z.number().min(-1440).max(10080).optional(),
        });
        const parsed = WhatIfBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid what-if body: ${parsed.error.message}` },
            400,
          );
        }
        const preparedScenario = await engine.prepareWhatIfScenario(
          parsed.data,
        );
        const probeResult = engine.probeWhatIf(preparedScenario);
        return jsonResponse(probeResult);
      }

      // 9.6 观测台：单文件夜间快照回滚 (Wave 7.2): POST /api/observatory/rollback-snapshot
      if (
        req.method === "POST" &&
        pathname === "/api/observatory/rollback-snapshot"
      ) {
        const rawBody = await req.json();
        const RollbackBodySchema = z.object({
          sleepDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          memoryId: z.string().min(1),
        });
        const parsed = RollbackBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid rollback body: ${parsed.error.message}` },
            400,
          );
        }
        const result = engine.rollbackMemorySnapshot(
          parsed.data.sleepDate,
          parsed.data.memoryId,
        );
        return jsonResponse(result);
      }

      // 9.7 观测台：系统元事件日志与原文存档: GET /api/observatory/system-log
      if (req.method === "GET" && pathname === "/api/observatory/system-log") {
        const materialHash = url.searchParams.get("materialHash")?.trim();
        if (materialHash) {
          return jsonResponse({
            material: engine.db.getSystemMaterial(materialHash),
          });
        }
        const limit = Number(url.searchParams.get("limit") || 100);
        return jsonResponse({
          configEpoch: engine.db.getConfigEpoch(),
          logs: engine.db.listSystemLogs({ limit }),
          residentSummary: engine.getSystemLogSummaryForResident(5),
        });
      }

      // 9.8 消息操作：删除本条及之后所有消息: POST /api/chat/delete
      if (req.method === "POST" && pathname === "/api/chat/delete") {
        const rawBody = await req.json();
        const DeleteBodySchema = z.object({
          eventId: z.string().min(1),
          reason: z.string().optional(),
          purgeCompiledMemories: z.boolean().optional(),
        });
        const parsed = DeleteBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid delete body: ${parsed.error.message}` },
            400,
          );
        }
        const result = engine.deleteMessagesFrom(parsed.data.eventId, {
          reason: parsed.data.reason,
          purgeCompiledMemories: parsed.data.purgeCompiledMemories,
        });
        return jsonResponse(result);
      }

      // 9.9 消息操作：Reroll 最后一条住户回复: POST /api/chat/reroll
      if (req.method === "POST" && pathname === "/api/chat/reroll") {
        let rawBody: unknown = {};
        const text = await req.text();
        if (text.trim()) {
          rawBody = JSON.parse(text);
        }
        const RerollBodySchema = z
          .object({
            overrideReplyText: z.string().optional(),
          })
          .optional();
        const parsed = RerollBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid reroll body: ${parsed.error.message}` },
            400,
          );
        }
        const result = await engine.rerollLastAssistantReply(parsed.data ?? {});
        return jsonResponse(result);
      }

      // 9.10 消息操作：切换同组 Reroll 版本: POST /api/chat/version
      if (req.method === "POST" && pathname === "/api/chat/version") {
        const rawBody = await req.json();
        const VersionBodySchema = z.object({
          groupId: z.string().min(1),
          version: z.number().int().min(1),
        });
        const parsed = VersionBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid version body: ${parsed.error.message}` },
            400,
          );
        }
        const switched = engine.switchMessageVersion(
          parsed.data.groupId,
          parsed.data.version,
        );
        return jsonResponse({ event: switched });
      }

      // 9.11 消息操作：编辑最近一条未回复的用户消息: POST /api/chat/edit
      if (req.method === "POST" && pathname === "/api/chat/edit") {
        const rawBody = await req.json();
        const EditBodySchema = z.object({
          eventId: z.string().min(1),
          content: z.string().min(1),
          reason: z.string().optional(),
        });
        const parsed = EditBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return jsonResponse(
            { error: `Invalid edit body: ${parsed.error.message}` },
            400,
          );
        }
        const updated = engine.editLastUserMessage(
          parsed.data.eventId,
          parsed.data.content,
          { reason: parsed.data.reason },
        );
        return jsonResponse({ event: updated });
      }

      // 9.12 观测台：手动触发整库与记忆备份: POST /api/observatory/backup
      if (req.method === "POST" && pathname === "/api/observatory/backup") {
        const result = engine.runSystemBackup({ trigger: "manual" });
        return jsonResponse(result);
      }

      // 10. 极轻静态文件托管（开发者联调与性格测试台）
      if (req.method === "GET" && !pathname.startsWith("/api/")) {
        const MIME_TYPES: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".png": "image/png",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".txt": "text/plain; charset=utf-8",
        };
        const relPath =
          pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
        const safePath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, "");
        const filePath = path.join(staticDir, safePath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || "application/octet-stream";
          const fileBytes = fs.readFileSync(filePath);
          return new Response(fileBytes, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              ...CORS_HEADERS,
            },
          });
        }
      }

      return jsonResponse({ error: `Not Found: ${req.method} ${pathname}` }, 404);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  };

  return {
    engine,
    simulator,
    fetch,
    broadcastEvent,
    getSubscriberCount: () => sseSubscribers.size,
  };
}

export function startEchoreHttpServer(options: {
  engine: EchoreEngine;
  simulator?: TimeTravelSimulator;
  port?: number;
  hostname?: string;
  staticDir?: string;
  skipStartupBackupCheck?: boolean;
}) {
  if (!options.skipStartupBackupCheck) {
    options.engine.ensureStartupBackup();
  }
  const app = createEchoreHttpApp({
    engine: options.engine,
    simulator: options.simulator,
    staticDir: options.staticDir,
  });
  const server = Bun.serve({
    port: options.port ?? Number(process.env.PORT || 3377),
    hostname: options.hostname ?? "127.0.0.1",
    fetch: app.fetch,
  });
  return { app, server };
}

if (import.meta.main) {
  const baseDir =
    process.env.ECHORE_DATA_DIR?.replace(/^~\//, `${os.homedir()}/`) ??
    path.join(os.homedir(), ".echore", "test");
  const memoryDir = path.join(baseDir, "memory");
  fs.mkdirSync(path.join(memoryDir, "people"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "events"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "concerns"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "implicit"), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, "journal"), { recursive: true });

  const userDoc = path.join(memoryDir, "people", "user.md");
  if (!fs.existsSync(userDoc)) {
    fs.writeFileSync(
      userDoc,
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
  }

  const fallbackProvider: LLMProvider = {
    providerName: "http-local-fallback",
    async generate() {
      return {
        text: "我趁着闲暇整理了一段随手笔记，顺便翻了翻书。",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
    async generateSandwich(req) {
      return {
        text: `听到了，你说“${req.dynamicTail.latestUserMessage.slice(0, 30)}”，我正想着这事呢。`,
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
  };

  const clock = new VirtualClock();
  const db = new EchoreDatabase({
    dbPath: path.join(baseDir, "echore.sqlite"),
    clock,
  });
  const { router, modeDescription } =
    createOrganRouterFromEnv(fallbackProvider);
  const savedResident = db.getResidentState();
  const engine = new EchoreEngine({
    clock,
    db,
    memoryDir,
    persona: savedResident?.persona_config ?? {
      name: "Echore",
      user_name: "用户",
      user_pronoun: "他",
      relationship: "初识",
      archetype: "cat_aloof",
      chronotype: "regular",
    },
    router,
  });

  const { server } = startEchoreHttpServer({ engine });
  console.log(
    `[Echore HTTP/SSE Server] Listening on http://${server.hostname}:${server.port}`,
  );
  console.log(`[Echore LLM Router] ${modeDescription}`);
  console.log(`[Echore Data Dir]   ${baseDir}`);
}
