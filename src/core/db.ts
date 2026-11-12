import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Clock, formatLocalDateStr } from "./clock.ts";
import {
  type ChronotypeId,
  type ConcernRecord,
  ConcernRecordSchema,
  type EventLogRecord,
  type HormoneState,
  HormoneStateSchema,
  type MemoryCategory,
  type MemoryStatus,
  type ReflexState,
  ReflexStateSchema,
} from "./schemas.ts";
import { getCircadianDateStr } from "../reflex/guard.ts";

export interface MemoryMetaRecord {
  id: string;
  path: string;
  category: MemoryCategory;
  status: MemoryStatus;
  allow_forget: boolean;
  strength: number;
  access_count: number;
  last_accessed: string;
  embedding?: number[];
  updated_at: string;
}

export function resolveDataDir(explicitDir?: string): string {
  if (explicitDir) return explicitDir;
  if (process.env.ECHORE_DATA_DIR) {
    if (process.env.ECHORE_DATA_DIR.startsWith("~/")) {
      return path.join(os.homedir(), process.env.ECHORE_DATA_DIR.slice(2));
    }
    return process.env.ECHORE_DATA_DIR;
  }
  return path.join(os.homedir(), ".echore", "test");
}

export class EchoreDatabase {
  readonly sqlite: Database;
  readonly dbPath: string;
  private readonly clock: Clock;

  constructor(options: { dbPath?: string; dataDir?: string; clock: Clock }) {
    this.clock = options.clock;
    if (options.dbPath) {
      this.dbPath = options.dbPath;
      if (this.dbPath !== ":memory:") {
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      }
    } else {
      const dir = resolveDataDir(options.dataDir);
      fs.mkdirSync(dir, { recursive: true });
      this.dbPath = path.join(dir, "echore.sqlite");
    }
    this.sqlite = new Database(this.dbPath, { create: true });
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS event_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        role TEXT NOT NULL,
        speaker TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);

      CREATE VIRTUAL TABLE IF NOT EXISTS event_log_fts USING fts5(
        id UNINDEXED,
        speaker,
        content
      );

      CREATE TABLE IF NOT EXISTS hormone_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cortisol REAL NOT NULL,
        oxytocin REAL NOT NULL,
        dopamine REAL NOT NULL,
        melatonin REAL NOT NULL,
        floor_cort REAL NOT NULL DEFAULT 0.12,
        cap_ox REAL NOT NULL DEFAULT 1.0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reflex_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        consecutive_unanswered_proactive INTEGER NOT NULL DEFAULT 0,
        last_proactive_at TEXT,
        last_user_message_at TEXT,
        proactive_lock INTEGER NOT NULL DEFAULT 0,
        last_sleep_settled_at TEXT,
        last_sleep_event_id TEXT
      );

      CREATE TABLE IF NOT EXISTS concerns (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        floor_cort REAL NOT NULL DEFAULT 0,
        cap_ox REAL NOT NULL DEFAULT 1,
        has_prep INTEGER NOT NULL DEFAULT 0,
        settled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_meta (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        allow_forget INTEGER NOT NULL DEFAULT 1,
        strength REAL NOT NULL DEFAULT 0.75,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT NOT NULL,
        embedding_json TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    const reflexRow = this.sqlite
      .query("SELECT id FROM reflex_state WHERE id = 1")
      .get();
    if (!reflexRow) {
      this.sqlite
        .query(
          `INSERT INTO reflex_state (id, consecutive_unanswered_proactive, last_proactive_at, last_user_message_at, proactive_lock)
           VALUES (1, 0, NULL, NULL, 0)`,
        )
        .run();
    }

    const hormoneRow = this.sqlite
      .query("SELECT id FROM hormone_state WHERE id = 1")
      .get();
    if (!hormoneRow) {
      this.sqlite
        .query(
          `INSERT INTO hormone_state (id, cortisol, oxytocin, dopamine, melatonin, floor_cort, cap_ox, updated_at)
           VALUES (1, 0.15, 0.60, 0.50, 0.10, 0.15, 1.0, ?)`,
        )
        .run(this.clock.nowIso());
    }

    const concernCols = this.sqlite
      .query("PRAGMA table_info(concerns)")
      .all() as Array<{ name: string }>;
    if (!concernCols.some((c) => c.name === "settled_at")) {
      this.sqlite.exec("ALTER TABLE concerns ADD COLUMN settled_at TEXT;");
    }

    const reflexCols = this.sqlite
      .query("PRAGMA table_info(reflex_state)")
      .all() as Array<{ name: string }>;
    if (!reflexCols.some((c) => c.name === "last_sleep_settled_at")) {
      this.sqlite.exec(
        "ALTER TABLE reflex_state ADD COLUMN last_sleep_settled_at TEXT;",
      );
    }
    if (!reflexCols.some((c) => c.name === "last_sleep_event_id")) {
      this.sqlite.exec(
        "ALTER TABLE reflex_state ADD COLUMN last_sleep_event_id TEXT;",
      );
    }
  }

  private static toFtsSegment(text: string): string {
    // Space-segment CJK characters so SQLite FTS5 unicode61 indexes Chinese terms & bigrams accurately
    return text.replace(/([一-龥])/g, " $1 ").replace(/\s+/g, " ").trim();
  }

  appendEventLog(input: {
    id?: string;
    timestamp?: string;
    role: "user" | "assistant" | "solitary" | "system";
    speaker: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): EventLogRecord {
    const id = input.id ?? this.clock.formatLogId();
    const timestamp = input.timestamp ?? this.clock.nowIso();
    const metadata = input.metadata ?? {};

    this.sqlite
      .query(
        `INSERT OR REPLACE INTO event_log (id, timestamp, role, speaker, content, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, timestamp, input.role, input.speaker, input.content, JSON.stringify(metadata));

    this.sqlite
      .query(`DELETE FROM event_log_fts WHERE id = ?`)
      .run(id);
    this.sqlite
      .query(`INSERT INTO event_log_fts (id, speaker, content) VALUES (?, ?, ?)`)
      .run(id, input.speaker, EchoreDatabase.toFtsSegment(input.content));

    return {
      id,
      timestamp,
      role: input.role,
      speaker: input.speaker,
      content: input.content,
      metadata,
    };
  }

  getEventLogById(id: string): EventLogRecord | null {
    const row = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json
         FROM event_log WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          timestamp: string;
          role: "user" | "assistant" | "solitary" | "system";
          speaker: string;
          content: string;
          metadata_json: string;
        }
      | null;

    if (!row) return null;
    return {
      id: row.id,
      timestamp: row.timestamp,
      role: row.role,
      speaker: row.speaker,
      content: row.content,
      metadata: JSON.parse(row.metadata_json || "{}"),
    };
  }

  getRecentEventLogs(limit = 20): EventLogRecord[] {
    const rows = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json
         FROM event_log
         ORDER BY timestamp DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      timestamp: string;
      role: "user" | "assistant" | "solitary" | "system";
      speaker: string;
      content: string;
      metadata_json: string;
    }>;

    return rows.reverse().map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      role: r.role,
      speaker: r.speaker,
      content: r.content,
      metadata: JSON.parse(r.metadata_json || "{}"),
    }));
  }

  getEventLogsByDate(dateStr: string, chronotype?: ChronotypeId): EventLogRecord[] {
    const baseMs = Date.parse(`${dateStr}T00:00:00.000Z`);
    const rows = (
      Number.isFinite(baseMs)
        ? this.sqlite
            .query(
              `SELECT id, timestamp, role, speaker, content, metadata_json
               FROM event_log
               WHERE timestamp >= ? AND timestamp <= ?
               ORDER BY timestamp ASC, rowid ASC`,
            )
            .all(
              new Date(baseMs - 2 * 86_400_000).toISOString(),
              new Date(baseMs + 2 * 86_400_000).toISOString(),
            )
        : this.sqlite
            .query(
              `SELECT id, timestamp, role, speaker, content, metadata_json
               FROM event_log
               ORDER BY timestamp ASC, rowid ASC`,
            )
            .all()
    ) as Array<{
      id: string;
      timestamp: string;
      role: "user" | "assistant" | "solitary" | "system";
      speaker: string;
      content: string;
      metadata_json: string;
    }>;

    return rows
      .filter((r) => {
        if (chronotype) {
          return (
            formatLocalDateStr(r.timestamp) === dateStr ||
            getCircadianDateStr(new Date(r.timestamp), chronotype) === dateStr
          );
        }
        return formatLocalDateStr(r.timestamp) === dateStr;
      })
      .map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        role: r.role,
        speaker: r.speaker,
        content: r.content,
        metadata: JSON.parse(r.metadata_json || "{}"),
      }));
  }

  /**
   * 吸收自 Psyche `coldCursor`：按单调游标获取上次睡眠结转以来的全部未结转事件。
   * - 若已记录 `last_sleep_event_id`，直接按 SQLite `rowid > cursor_rowid` 增量捞取（零漏编、零重编）；
   * - 若上次结转时无事件但记录了 `last_sleep_settled_at`，按 `timestamp > last_sleep_settled_at` 捞取；
   * - 若尚无任何睡眠游标（首次入睡或独立单测），按 `fallbackDateStr` 与作息捞取当日及跨午夜未结转事件。
   */
  getUnsettledEventLogs(
    fallbackDateStr?: string,
    chronotype?: ChronotypeId,
  ): EventLogRecord[] {
    const reflexRow = this.sqlite
      .query(
        `SELECT last_sleep_settled_at, last_sleep_event_id
         FROM reflex_state WHERE id = 1`,
      )
      .get() as {
      last_sleep_settled_at: string | null;
      last_sleep_event_id: string | null;
    } | null;

    type RawEventRow = {
      id: string;
      timestamp: string;
      role: "user" | "assistant" | "solitary" | "system";
      speaker: string;
      content: string;
      metadata_json: string;
    };
    const mapRow = (r: RawEventRow): EventLogRecord => ({
      id: r.id,
      timestamp: r.timestamp,
      role: r.role,
      speaker: r.speaker,
      content: r.content,
      metadata: JSON.parse(r.metadata_json || "{}"),
    });

    if (reflexRow?.last_sleep_event_id) {
      const cursor = this.sqlite
        .query("SELECT rowid FROM event_log WHERE id = ?")
        .get(reflexRow.last_sleep_event_id) as { rowid: number } | null;
      if (cursor) {
        const rows = this.sqlite
          .query(
            `SELECT id, timestamp, role, speaker, content, metadata_json
             FROM event_log
             WHERE rowid > ?
             ORDER BY timestamp ASC, rowid ASC`,
          )
          .all(cursor.rowid) as RawEventRow[];
        return rows.map(mapRow);
      }
    }

    if (reflexRow?.last_sleep_settled_at) {
      const rows = this.sqlite
        .query(
          `SELECT id, timestamp, role, speaker, content, metadata_json
           FROM event_log
           WHERE timestamp > ?
           ORDER BY timestamp ASC, rowid ASC`,
        )
        .all(reflexRow.last_sleep_settled_at) as RawEventRow[];
      return rows.map(mapRow);
    }

    if (fallbackDateStr) {
      return this.getEventLogsByDate(fallbackDateStr, chronotype);
    }

    const rows = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json
         FROM event_log
         ORDER BY timestamp ASC, rowid ASC`,
      )
      .all() as RawEventRow[];
    return rows.map(mapRow);
  }

  advanceSleepCursor(
    settledAtIso: string,
    lastEventId?: string | null,
  ): void {
    this.sqlite
      .query(
        `UPDATE reflex_state
         SET last_sleep_settled_at = ?,
             last_sleep_event_id = COALESCE(?, last_sleep_event_id)
         WHERE id = 1`,
      )
      .run(settledAtIso, lastEventId ?? null);
  }

  private static readonly CJK_STOP_PARTICLES = new Set([
    "的",
    "了",
    "吗",
    "呢",
    "吧",
    "啊",
    "呀",
    "哦",
    "嘛",
    "呗",
  ]);

  searchEventLogsFts(queryText: string, limit = 10): EventLogRecord[] {
    const segmented = EchoreDatabase.toFtsSegment(queryText);
    const rawTokens = segmented
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const cleaned = rawTokens.filter(
      (t) => !EchoreDatabase.CJK_STOP_PARTICLES.has(t),
    );
    const tokens = cleaned.length > 0 ? cleaned : rawTokens;
    if (tokens.length === 0) return [];

    const runMatch = (operator: "AND" | "OR") => {
      const ftsQuery = tokens.map((t) => `"${t}"`).join(` ${operator} `);
      return this.sqlite
        .query(
          `SELECT e.id, e.timestamp, e.role, e.speaker, e.content, e.metadata_json
           FROM event_log_fts f
           JOIN event_log e ON e.id = f.id
           WHERE event_log_fts MATCH ?
           ORDER BY bm25(event_log_fts)
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{
        id: string;
        timestamp: string;
        role: "user" | "assistant" | "solitary" | "system";
        speaker: string;
        content: string;
        metadata_json: string;
      }>;
    };

    let rows = runMatch("AND");
    if (rows.length === 0 && tokens.length > 1) {
      rows = runMatch("OR");
    }

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      role: r.role,
      speaker: r.speaker,
      content: r.content,
      metadata: JSON.parse(r.metadata_json || "{}"),
    }));
  }

  getHormoneState(): HormoneState {
    const row = this.sqlite
      .query(
        `SELECT cortisol, oxytocin, dopamine, melatonin, floor_cort, cap_ox, updated_at
         FROM hormone_state WHERE id = 1`,
      )
      .get() as HormoneState;
    return HormoneStateSchema.parse(row);
  }

  saveHormoneState(state: HormoneState): void {
    const validated = HormoneStateSchema.parse(state);
    this.sqlite
      .query(
        `UPDATE hormone_state
         SET cortisol = ?, oxytocin = ?, dopamine = ?, melatonin = ?, floor_cort = ?, cap_ox = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(
        validated.cortisol,
        validated.oxytocin,
        validated.dopamine,
        validated.melatonin,
        validated.floor_cort,
        validated.cap_ox,
        validated.updated_at,
      );
  }

  getReflexState(): ReflexState {
    const row = this.sqlite
      .query(
        `SELECT consecutive_unanswered_proactive, last_proactive_at, last_user_message_at, proactive_lock, last_sleep_settled_at, last_sleep_event_id
         FROM reflex_state WHERE id = 1`,
      )
      .get() as {
      consecutive_unanswered_proactive: number;
      last_proactive_at: string | null;
      last_user_message_at: string | null;
      proactive_lock: number;
      last_sleep_settled_at: string | null;
      last_sleep_event_id: string | null;
    };
    return ReflexStateSchema.parse({
      consecutive_unanswered_proactive: row.consecutive_unanswered_proactive,
      last_proactive_at: row.last_proactive_at,
      last_user_message_at: row.last_user_message_at,
      proactive_lock: Boolean(row.proactive_lock),
      last_sleep_settled_at: row.last_sleep_settled_at ?? null,
      last_sleep_event_id: row.last_sleep_event_id ?? null,
    });
  }

  saveReflexState(state: ReflexState): void {
    const validated = ReflexStateSchema.parse(state);
    const current = this.getReflexState();
    const settledAt =
      validated.last_sleep_settled_at !== undefined
        ? validated.last_sleep_settled_at
        : (current.last_sleep_settled_at ?? null);
    const lastEventId =
      validated.last_sleep_event_id !== undefined
        ? validated.last_sleep_event_id
        : (current.last_sleep_event_id ?? null);
    this.sqlite
      .query(
        `UPDATE reflex_state
         SET consecutive_unanswered_proactive = ?,
             last_proactive_at = ?,
             last_user_message_at = ?,
             proactive_lock = ?,
             last_sleep_settled_at = ?,
             last_sleep_event_id = ?
         WHERE id = 1`,
      )
      .run(
        validated.consecutive_unanswered_proactive,
        validated.last_proactive_at,
        validated.last_user_message_at,
        validated.proactive_lock ? 1 : 0,
        settledAt,
        lastEventId,
      );
  }

  upsertConcern(concern: ConcernRecord): void {
    const c = ConcernRecordSchema.parse(concern);
    this.sqlite
      .query(
        `INSERT INTO concerns (id, tier, status, summary, source_event_id, created_at, updated_at, floor_cort, cap_ox, has_prep, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           tier = excluded.tier,
           status = excluded.status,
           summary = excluded.summary,
           source_event_id = excluded.source_event_id,
           updated_at = excluded.updated_at,
           floor_cort = excluded.floor_cort,
           cap_ox = excluded.cap_ox,
           has_prep = excluded.has_prep,
           settled_at = CASE WHEN excluded.status = '已落定' THEN concerns.settled_at ELSE NULL END`,
      )
      .run(
        c.id,
        c.tier,
        c.status,
        c.summary,
        c.source_event_id,
        c.created_at,
        c.updated_at,
        c.floor_cort,
        c.cap_ox,
        c.has_prep ? 1 : 0,
      );
  }

  listUnsettledResolvedConcerns(): ConcernRecord[] {
    const rows = this.sqlite
      .query(
        `SELECT * FROM concerns
         WHERE status = '已落定' AND settled_at IS NULL
         ORDER BY updated_at DESC`,
      )
      .all() as Array<Omit<ConcernRecord, "has_prep"> & { has_prep: number }>;

    return rows.map((r) =>
      ConcernRecordSchema.parse({
        ...r,
        has_prep: Boolean(r.has_prep),
      }),
    );
  }

  markConcernNightlySettled(id: string, settledAtIso: string): void {
    this.sqlite
      .query(`UPDATE concerns SET settled_at = ? WHERE id = ?`)
      .run(settledAtIso, id);
  }

  getConcernById(id: string): ConcernRecord | null {
    const row = this.sqlite
      .query(`SELECT * FROM concerns WHERE id = ?`)
      .get(id) as
      | (Omit<ConcernRecord, "has_prep"> & { has_prep: number })
      | null;
    if (!row) return null;
    return ConcernRecordSchema.parse({
      ...row,
      has_prep: Boolean(row.has_prep),
    });
  }

  listActiveConcerns(): ConcernRecord[] {
    const rows = this.sqlite
      .query(
        `SELECT * FROM concerns
         WHERE status IN ('有效', '僵持待解')
         ORDER BY updated_at DESC`,
      )
      .all() as Array<Omit<ConcernRecord, "has_prep"> & { has_prep: number }>;

    return rows.map((r) =>
      ConcernRecordSchema.parse({
        ...r,
        has_prep: Boolean(r.has_prep),
      }),
    );
  }

  markConcernHasPrep(
    id: string,
    hasPrep: boolean,
    updatedAtIso?: string,
  ): void {
    const ts = updatedAtIso ?? this.clock.nowIso();
    this.sqlite
      .query(`UPDATE concerns SET has_prep = ?, updated_at = ? WHERE id = ?`)
      .run(hasPrep ? 1 : 0, ts, id);
  }

  listAllConcerns(): ConcernRecord[] {
    const rows = this.sqlite
      .query(`SELECT * FROM concerns ORDER BY updated_at DESC`)
      .all() as Array<Omit<ConcernRecord, "has_prep"> & { has_prep: number }>;

    return rows.map((r) =>
      ConcernRecordSchema.parse({
        ...r,
        has_prep: Boolean(r.has_prep),
      }),
    );
  }

  upsertMemoryMeta(meta: MemoryMetaRecord): void {
    this.sqlite
      .query(`DELETE FROM memory_meta WHERE path = ? AND id != ?`)
      .run(meta.path, meta.id);
    this.sqlite
      .query(
        `INSERT INTO memory_meta (id, path, category, status, allow_forget, strength, access_count, last_accessed, embedding_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           category = excluded.category,
           status = excluded.status,
           allow_forget = excluded.allow_forget,
           strength = excluded.strength,
           access_count = excluded.access_count,
           last_accessed = excluded.last_accessed,
           embedding_json = COALESCE(excluded.embedding_json, memory_meta.embedding_json),
           updated_at = excluded.updated_at`,
      )
      .run(
        meta.id,
        meta.path,
        meta.category,
        meta.status,
        meta.allow_forget ? 1 : 0,
        meta.strength,
        meta.access_count,
        meta.last_accessed,
        meta.embedding ? JSON.stringify(meta.embedding) : null,
        meta.updated_at,
      );
  }

  getMemoryMeta(id: string): MemoryMetaRecord | null {
    const row = this.sqlite
      .query(`SELECT * FROM memory_meta WHERE id = ?`)
      .get(id) as
      | {
          id: string;
          path: string;
          category: MemoryCategory;
          status: MemoryStatus;
          allow_forget: number;
          strength: number;
          access_count: number;
          last_accessed: string;
          embedding_json: string | null;
          updated_at: string;
        }
      | null;
    if (!row) return null;
    return {
      id: row.id,
      path: row.path,
      category: row.category,
      status: row.status,
      allow_forget: Boolean(row.allow_forget),
      strength: row.strength,
      access_count: row.access_count,
      last_accessed: row.last_accessed,
      embedding: row.embedding_json ? JSON.parse(row.embedding_json) : undefined,
      updated_at: row.updated_at,
    };
  }

  listAllMemoryMeta(): MemoryMetaRecord[] {
    const rows = this.sqlite
      .query(`SELECT * FROM memory_meta`)
      .all() as Array<{
      id: string;
      path: string;
      category: MemoryCategory;
      status: MemoryStatus;
      allow_forget: number;
      strength: number;
      access_count: number;
      last_accessed: string;
      embedding_json: string | null;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      category: row.category,
      status: row.status,
      allow_forget: Boolean(row.allow_forget),
      strength: row.strength,
      access_count: row.access_count,
      last_accessed: row.last_accessed,
      embedding: row.embedding_json ? JSON.parse(row.embedding_json) : undefined,
      updated_at: row.updated_at,
    }));
  }

  close(): void {
    this.sqlite.close();
  }
}
