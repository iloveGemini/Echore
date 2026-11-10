import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Clock } from "./clock.ts";
import {
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
        proactive_lock INTEGER NOT NULL DEFAULT 0
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

  getEventLogsByDate(dateStr: string): EventLogRecord[] {
    const rows = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json
         FROM event_log
         WHERE timestamp LIKE ?
         ORDER BY timestamp ASC, rowid ASC`,
      )
      .all(`${dateStr}%`) as Array<{
      id: string;
      timestamp: string;
      role: "user" | "assistant" | "solitary" | "system";
      speaker: string;
      content: string;
      metadata_json: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      role: r.role,
      speaker: r.speaker,
      content: r.content,
      metadata: JSON.parse(r.metadata_json || "{}"),
    }));
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
        `SELECT consecutive_unanswered_proactive, last_proactive_at, last_user_message_at, proactive_lock
         FROM reflex_state WHERE id = 1`,
      )
      .get() as {
      consecutive_unanswered_proactive: number;
      last_proactive_at: string | null;
      last_user_message_at: string | null;
      proactive_lock: number;
    };
    return ReflexStateSchema.parse({
      consecutive_unanswered_proactive: row.consecutive_unanswered_proactive,
      last_proactive_at: row.last_proactive_at,
      last_user_message_at: row.last_user_message_at,
      proactive_lock: Boolean(row.proactive_lock),
    });
  }

  saveReflexState(state: ReflexState): void {
    const validated = ReflexStateSchema.parse(state);
    this.sqlite
      .query(
        `UPDATE reflex_state
         SET consecutive_unanswered_proactive = ?,
             last_proactive_at = ?,
             last_user_message_at = ?,
             proactive_lock = ?
         WHERE id = 1`,
      )
      .run(
        validated.consecutive_unanswered_proactive,
        validated.last_proactive_at,
        validated.last_user_message_at,
        validated.proactive_lock ? 1 : 0,
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
