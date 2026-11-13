import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Clock, formatLocalDateStr } from "./clock.ts";
import {
  assertNoInternalLeaks,
  type ChronotypeId,
  type ConcernRecord,
  ConcernRecordSchema,
  type EventAttachmentRecord,
  type EventAttachmentType,
  type EventLogRecord,
  type EventProducer,
  type EventSource,
  type EventVersionStatus,
  type GenesisStatus,
  type HormoneState,
  HormoneStateSchema,
  type MemoryCategory,
  type MemoryStatus,
  type NamingMode,
  type NamingState,
  PersonaConfigSchema,
  type ReflexState,
  ReflexStateSchema,
  type ResidentStateRecord,
  ResidentStateRecordSchema,
  type SystemLogActor,
  type SystemLogKind,
  type SystemLogRecord,
  SystemLogRecordSchema,
  type SystemMaterialRecord,
} from "./schemas.ts";
import { getCircadianDateStr } from "../reflex/guard.ts";

const CROCKFORD_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlidMs = 0;
let lastUlidSeq = 0;

export function generateUlid(nowMs = Date.now()): string {
  const ms = Math.max(0, Math.floor(nowMs));
  if (ms === lastUlidMs) {
    lastUlidSeq += 1;
  } else {
    lastUlidMs = ms;
    lastUlidSeq = 0;
  }

  let timeChars = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    timeChars = CROCKFORD_B32[t % 32]! + timeChars;
    t = Math.floor(t / 32);
  }

  // High 6 chars from monotonic counter, low 10 chars from crypto random
  let seqChars = "";
  let s = lastUlidSeq;
  for (let i = 0; i < 6; i++) {
    seqChars = CROCKFORD_B32[s % 32]! + seqChars;
    s = Math.floor(s / 32);
  }

  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);
  let randChars = "";
  for (let i = 0; i < 10; i++) {
    randChars += CROCKFORD_B32[randBytes[i]! % 32]!;
  }

  return `${timeChars}${seqChars}${randChars}`;
}

export function computeSha256Hex(content: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

export function inferDefaultProducerAndSource(
  role: "user" | "assistant" | "solitary" | "system",
  metadata: Record<string, unknown>,
): { producer: EventProducer; source: EventSource } {
  if (role === "solitary") {
    return { producer: "solitary", source: "solitary" };
  }
  if (metadata.source === "mcp_digest") {
    return {
      producer: role === "user" ? "user" : "external",
      source: "mcp_digest",
    };
  }
  if (metadata.source === "import") {
    return {
      producer: role === "user" ? "user" : "resident",
      source: "import",
    };
  }
  if (metadata.proactive === true) {
    return { producer: "resident", source: "heartbeat" };
  }
  if (role === "user") {
    return { producer: "user", source: "chat" };
  }
  if (role === "assistant") {
    return { producer: "resident", source: "chat" };
  }
  return { producer: "system", source: "system" };
}

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
  embedding_fingerprint?: string;
  audit_fingerprint?: string;
  updated_at: string;
}

export interface MemoryTransitionRecord {
  from_memory_id: string;
  to_memory_id: string;
  weight: number;
  updated_at: string;
}

export interface MemorySnapshotRecord {
  id: number;
  sleep_date: string;
  memory_id: string;
  rel_path: string;
  original_content: string | null;
  is_creation: boolean;
  created_at: string;
}

export interface MemoryEmbeddingRecord {
  memory_id: string;
  model_key: string;
  embedding_fingerprint: string;
  embedding: number[];
  dimensions: number;
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
  readonly dataDir: string;
  private readonly clock: Clock;

  constructor(options: { dbPath?: string; dataDir?: string; clock: Clock }) {
    this.clock = options.clock;
    if (options.dbPath) {
      this.dbPath = options.dbPath;
      this.dataDir =
        this.dbPath === ":memory:"
          ? resolveDataDir(options.dataDir)
          : path.dirname(this.dbPath);
      if (this.dbPath !== ":memory:") {
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      }
    } else {
      const dir = resolveDataDir(options.dataDir);
      fs.mkdirSync(dir, { recursive: true });
      this.dataDir = dir;
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
        metadata_json TEXT NOT NULL DEFAULT '{}',
        group_id TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        producer TEXT NOT NULL DEFAULT 'user',
        source TEXT NOT NULL DEFAULT 'chat'
      );

      CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);

      CREATE VIRTUAL TABLE IF NOT EXISTS event_log_fts USING fts5(
        id UNINDEXED,
        speaker,
        content
      );

      CREATE TABLE IF NOT EXISTS event_attachments (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES event_log(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT,
        size_bytes INTEGER,
        hash TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        duration_ms INTEGER,
        caption TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_event_attachments_event ON event_attachments(event_id);
      CREATE INDEX IF NOT EXISTS idx_event_attachments_hash ON event_attachments(hash);

      CREATE TABLE IF NOT EXISTS system_log (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        recorded INTEGER NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        artifact TEXT NOT NULL,
        old_hash TEXT,
        new_hash TEXT,
        reason TEXT NOT NULL,
        link TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_system_log_at ON system_log(at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_system_log_kind ON system_log(kind, at DESC);
      CREATE INDEX IF NOT EXISTS idx_system_log_artifact ON system_log(artifact, at DESC);

      CREATE TRIGGER IF NOT EXISTS system_log_no_update BEFORE UPDATE ON system_log
      BEGIN SELECT RAISE(ABORT, 'system_log 只追加，不可修改'); END;

      CREATE TRIGGER IF NOT EXISTS system_log_no_delete BEFORE DELETE ON system_log
      BEGIN SELECT RAISE(ABORT, 'system_log 只追加，不可删除'); END;

      CREATE TABLE IF NOT EXISTS system_materials (
        hash TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        last_sleep_event_id TEXT,
        last_backup_at TEXT,
        last_backup_date TEXT
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
        embedding_fingerprint TEXT,
        audit_fingerprint TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_transitions (
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (from_memory_id, to_memory_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_transitions_from
        ON memory_transitions(from_memory_id, weight DESC);

      CREATE TABLE IF NOT EXISTS memory_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sleep_date TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        original_content TEXT,
        is_creation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(sleep_date, memory_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_snapshots_date
        ON memory_snapshots(sleep_date);

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT NOT NULL,
        model_key TEXT NOT NULL,
        embedding_fingerprint TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, model_key)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model
        ON memory_embeddings(model_key, updated_at DESC);

      CREATE TABLE IF NOT EXISTS prompt_baselines (
        artifact TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resident_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        genesis_status TEXT NOT NULL DEFAULT 'pending',
        naming_mode TEXT NOT NULL DEFAULT 'co_create',
        naming_state TEXT NOT NULL DEFAULT 'pending',
        persona_config_json TEXT NOT NULL,
        initialized_at TEXT,
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
    if (!reflexCols.some((c) => c.name === "last_backup_at")) {
      this.sqlite.exec(
        "ALTER TABLE reflex_state ADD COLUMN last_backup_at TEXT;",
      );
    }
    if (!reflexCols.some((c) => c.name === "last_backup_date")) {
      this.sqlite.exec(
        "ALTER TABLE reflex_state ADD COLUMN last_backup_date TEXT;",
      );
    }

    const eventCols = this.sqlite
      .query("PRAGMA table_info(event_log)")
      .all() as Array<{ name: string }>;
    let migratedEventV2 = false;
    if (!eventCols.some((c) => c.name === "group_id")) {
      this.sqlite.exec(
        "ALTER TABLE event_log ADD COLUMN group_id TEXT NOT NULL DEFAULT '';",
      );
      migratedEventV2 = true;
    }
    if (!eventCols.some((c) => c.name === "version")) {
      this.sqlite.exec(
        "ALTER TABLE event_log ADD COLUMN version INTEGER NOT NULL DEFAULT 1;",
      );
      migratedEventV2 = true;
    }
    if (!eventCols.some((c) => c.name === "status")) {
      this.sqlite.exec(
        "ALTER TABLE event_log ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
      );
      migratedEventV2 = true;
    }
    if (!eventCols.some((c) => c.name === "producer")) {
      this.sqlite.exec(
        "ALTER TABLE event_log ADD COLUMN producer TEXT NOT NULL DEFAULT '';",
      );
      migratedEventV2 = true;
    }
    if (!eventCols.some((c) => c.name === "source")) {
      this.sqlite.exec(
        "ALTER TABLE event_log ADD COLUMN source TEXT NOT NULL DEFAULT '';",
      );
      migratedEventV2 = true;
    }
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_event_log_group ON event_log(group_id, version ASC);
      CREATE INDEX IF NOT EXISTS idx_event_log_status_ts ON event_log(status, timestamp ASC);
    `);
    if (migratedEventV2) {
      this.backfillEventLogV2Columns();
    }

    const memoryMetaCols = this.sqlite
      .query("PRAGMA table_info(memory_meta)")
      .all() as Array<{ name: string }>;
    if (!memoryMetaCols.some((c) => c.name === "embedding_fingerprint")) {
      this.sqlite.exec(
        "ALTER TABLE memory_meta ADD COLUMN embedding_fingerprint TEXT;",
      );
    }
    if (!memoryMetaCols.some((c) => c.name === "audit_fingerprint")) {
      this.sqlite.exec(
        "ALTER TABLE memory_meta ADD COLUMN audit_fingerprint TEXT;",
      );
    }
  }

  private static toFtsSegment(text: string): string {
    // Space-segment CJK characters so SQLite FTS5 unicode61 indexes Chinese terms & bigrams accurately
    return text.replace(/([一-龥])/g, " $1 ").replace(/\s+/g, " ").trim();
  }

  private mapRawEventRow(r: {
    id: string;
    timestamp: string;
    role: "user" | "assistant" | "solitary" | "system";
    speaker: string;
    content: string;
    metadata_json: string;
    group_id?: string | null;
    version?: number | null;
    status?: string | null;
    producer?: string | null;
    source?: string | null;
  }): EventLogRecord {
    const metadata = JSON.parse(r.metadata_json || "{}") as Record<
      string,
      unknown
    >;
    const inferred = inferDefaultProducerAndSource(r.role, metadata);
    const producer = (r.producer || inferred.producer) as EventProducer;
    const source = (r.source || inferred.source) as EventSource;
    const status = (r.status || "active") as EventVersionStatus;
    const group_id = r.group_id || r.id;
    const version = r.version ?? 1;
    const attachments = this.getAttachmentsForEvent(r.id);

    return {
      id: r.id,
      timestamp: r.timestamp,
      role: r.role,
      speaker: r.speaker,
      content: r.content,
      group_id,
      version,
      status,
      producer,
      source,
      metadata,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  /**
   * 对旧版或未填满 v2 列的 `event_log` 行执行 100% 精确回填，并同步重建 `event_log_fts`
   */
  backfillEventLogV2Columns(): number {
    const rows = this.sqlite
      .query(
        `SELECT id, role, metadata_json, group_id, version, status, producer, source
         FROM event_log`,
      )
      .all() as Array<{
      id: string;
      role: "user" | "assistant" | "solitary" | "system";
      metadata_json: string;
      group_id: string | null;
      version: number | null;
      status: string | null;
      producer: string | null;
      source: string | null;
    }>;

    let updated = 0;
    const tx = this.sqlite.transaction(() => {
      for (const r of rows) {
        const meta = JSON.parse(r.metadata_json || "{}") as Record<
          string,
          unknown
        >;
        const inferred = inferDefaultProducerAndSource(r.role, meta);
        const nextGroupId = r.group_id?.trim() ? r.group_id : r.id;
        const nextVersion = r.version && r.version >= 1 ? r.version : 1;
        const nextStatus = r.status?.trim() ? r.status : "active";
        const nextProducer = r.producer?.trim()
          ? r.producer
          : inferred.producer;
        const nextSource = r.source?.trim() ? r.source : inferred.source;

        if (
          nextGroupId !== r.group_id ||
          nextVersion !== r.version ||
          nextStatus !== r.status ||
          nextProducer !== r.producer ||
          nextSource !== r.source
        ) {
          this.sqlite
            .query(
              `UPDATE event_log
               SET group_id = ?, version = ?, status = ?, producer = ?, source = ?
               WHERE id = ?`,
            )
            .run(
              nextGroupId,
              nextVersion,
              nextStatus,
              nextProducer,
              nextSource,
              r.id,
            );
          this.syncEventFtsForId(r.id);
          updated += 1;
        } else if (nextStatus !== "active" || nextProducer === "system") {
          this.syncEventFtsForId(r.id);
        }
      }
    });
    tx();
    return updated;
  }

  syncEventFtsForId(eventId: string): void {
    this.sqlite.query(`DELETE FROM event_log_fts WHERE id = ?`).run(eventId);
    const row = this.sqlite
      .query(
        `SELECT id, speaker, content, status, producer
         FROM event_log WHERE id = ?`,
      )
      .get(eventId) as {
      id: string;
      speaker: string;
      content: string;
      status: string;
      producer: string;
    } | null;

    if (!row || row.status !== "active" || row.producer === "system") {
      return;
    }

    const captions = this.sqlite
      .query(
        `SELECT caption FROM event_attachments
         WHERE event_id = ? AND caption IS NOT NULL AND caption != ''`,
      )
      .all(eventId) as Array<{ caption: string }>;

    const combinedText = [
      row.content,
      ...captions.map((c) => c.caption),
    ]
      .filter(Boolean)
      .join(" ");

    this.sqlite
      .query(`INSERT INTO event_log_fts (id, speaker, content) VALUES (?, ?, ?)`)
      .run(
        row.id,
        row.speaker,
        EchoreDatabase.toFtsSegment(combinedText),
      );
  }

  getConfigEpoch(): number {
    const row = this.sqlite
      .query(
        `SELECT COUNT(*) AS cnt FROM system_log
         WHERE kind IN ('prompt_changed', 'model_changed', 'config_changed', 'deploy')`,
      )
      .get() as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  putSystemMaterial(
    content: string,
    createdAtIso?: string,
  ): { hash: string; created: boolean } {
    const hash = computeSha256Hex(content);
    const createdAt = createdAtIso ?? this.clock.nowIso();
    const res = this.sqlite
      .query(
        `INSERT OR IGNORE INTO system_materials (hash, content, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(hash, content, createdAt);
    return { hash, created: res.changes > 0 };
  }

  getSystemMaterial(hash: string): SystemMaterialRecord | null {
    const row = this.sqlite
      .query(
        `SELECT hash, content, created_at FROM system_materials WHERE hash = ?`,
      )
      .get(hash) as SystemMaterialRecord | null;
    return row ?? null;
  }

  countSystemMaterials(): number {
    const row = this.sqlite
      .query(`SELECT COUNT(*) AS cnt FROM system_materials`)
      .get() as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  appendSystemLog(input: {
    id?: string;
    at?: number;
    recorded?: number;
    actor: SystemLogActor;
    kind: SystemLogKind;
    artifact: string;
    oldContent?: string | null;
    newContent?: string | null;
    oldHash?: string | null;
    newHash?: string | null;
    reason: string;
    link?: string | null;
  }): SystemLogRecord {
    const nowMs = this.clock.nowMs();
    const at = input.at ?? nowMs;
    const recorded = input.recorded ?? nowMs;
    const id = input.id ?? generateUlid(recorded);

    let oldHash = input.oldHash ?? null;
    if (input.oldContent !== undefined && input.oldContent !== null) {
      oldHash = this.putSystemMaterial(input.oldContent).hash;
    }

    let newHash = input.newHash ?? null;
    if (input.newContent !== undefined && input.newContent !== null) {
      newHash = this.putSystemMaterial(input.newContent).hash;
    }

    const record: SystemLogRecord = SystemLogRecordSchema.parse({
      id,
      at,
      recorded,
      actor: input.actor,
      kind: input.kind,
      artifact: input.artifact,
      old_hash: oldHash,
      new_hash: newHash,
      reason: input.reason,
      link: input.link ?? null,
    });

    this.sqlite
      .query(
        `INSERT INTO system_log (id, at, recorded, actor, kind, artifact, old_hash, new_hash, reason, link)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.at,
        record.recorded,
        record.actor,
        record.kind,
        record.artifact,
        record.old_hash,
        record.new_hash,
        record.reason,
        record.link,
      );

    return record;
  }

  getPromptBaselineHash(artifact: string): string | null {
    const row = this.sqlite
      .query(`SELECT hash FROM prompt_baselines WHERE artifact = ?`)
      .get(artifact) as { hash: string } | null;
    return row?.hash ?? null;
  }

  setPromptBaselineHash(artifact: string, hash: string): void {
    this.sqlite
      .query(
        `INSERT INTO prompt_baselines (artifact, hash, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(artifact) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at`,
      )
      .run(artifact, hash, this.clock.nowIso());
  }

  listSystemLogs(options?: {
    kind?: SystemLogKind;
    artifact?: string;
    limit?: number;
  }): SystemLogRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options?.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options?.artifact) {
      clauses.push("artifact = ?");
      params.push(options.artifact);
    }
    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const parsedLimit =
      options?.limit !== undefined &&
      Number.isFinite(Number(options.limit)) &&
      Number(options.limit) > 0
        ? Math.floor(Number(options.limit))
        : null;
    const orderSql =
      parsedLimit !== null ? "ORDER BY at DESC, id DESC" : "ORDER BY at ASC, id ASC";
    const limitSql = parsedLimit !== null ? `LIMIT ${parsedLimit}` : "";
    const rows = this.sqlite
      .query(
        `SELECT id, at, recorded, actor, kind, artifact, old_hash, new_hash, reason, link
         FROM system_log
         ${whereSql}
         ${orderSql}
         ${limitSql}`,
      )
      .all(...params) as SystemLogRecord[];
    const ordered = parsedLimit !== null ? rows.reverse() : rows;
    return ordered.map((r) => SystemLogRecordSchema.parse(r));
  }

  getLatestSystemLogForArtifact(
    artifact: string,
    kind?: SystemLogKind,
  ): SystemLogRecord | null {
    const row = (
      kind
        ? this.sqlite
            .query(
              `SELECT id, at, recorded, actor, kind, artifact, old_hash, new_hash, reason, link
               FROM system_log
               WHERE artifact = ? AND kind = ?
               ORDER BY at DESC, id DESC
               LIMIT 1`,
            )
            .get(artifact, kind)
        : this.sqlite
            .query(
              `SELECT id, at, recorded, actor, kind, artifact, old_hash, new_hash, reason, link
               FROM system_log
               WHERE artifact = ?
               ORDER BY at DESC, id DESC
               LIMIT 1`,
            )
            .get(artifact)
    ) as SystemLogRecord | null;
    return row ? SystemLogRecordSchema.parse(row) : null;
  }

  /**
   * 面向住户（前台）的系统变更只读查账摘要：
   * 强制转译为零数字、无 `log-*` 主键、无 SHA-256 哈希、无内部模块名的自然语言说明，并通过 `assertNoInternalLeaks` 校验。
   */
  formatSystemLogForResident(limit = 5): string {
    const rows = this.sqlite
      .query(
        `SELECT kind, artifact, reason
         FROM system_log
         WHERE kind IN ('prompt_changed', 'model_changed', 'config_changed', 'spine_changed', 'deploy')
         ORDER BY at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      kind: SystemLogKind;
      artifact: string;
      reason: string;
    }>;

    if (rows.length === 0) {
      return "近期系统环境平稳，未发生提示词、表达模型或人设配置变更。";
    }

    const lines = rows.map((r) => {
      switch (r.kind) {
        case "prompt_changed":
          return "- 调整了内在表达与思考指引提示词";
        case "model_changed":
          return "- 更换了底层语言表达或认知路由模型";
        case "config_changed":
          return "- 调整了作息节律与情绪敏感度配置";
        case "spine_changed":
          return "- 更新了两人之间的内隐默契与变更自述";
        case "deploy":
          return "- 完成了系统版本更新与重启部署";
        default:
          return "- 进行了例行系统维护";
      }
    });

    const deduped = Array.from(new Set(lines));
    const text = `[系统变更备忘]\n${deduped.join("\n")}`;
    assertNoInternalLeaks(text, "formatSystemLogForResident");
    return text;
  }

  isEventIdDeletedInSystemLog(eventId: string): boolean {
    const rows = this.sqlite
      .query(
        `SELECT artifact, link FROM system_log WHERE kind = 'message_deleted'`,
      )
      .all() as Array<{ artifact: string; link: string | null }>;

    for (const r of rows) {
      if (r.link) {
        try {
          const parsed = JSON.parse(r.link) as {
            deleted_ids?: string[];
            from_id?: string;
            to_id?: string;
          };
          if (Array.isArray(parsed.deleted_ids)) {
            if (parsed.deleted_ids.includes(eventId)) {
              return true;
            }
            continue;
          }
          if (
            parsed.from_id &&
            parsed.to_id &&
            eventId >= parsed.from_id &&
            eventId <= parsed.to_id
          ) {
            return true;
          }
        } catch {
          // ignore non-json link
        }
      }
    }
    return false;
  }

  appendEventLog(input: {
    id?: string;
    timestamp?: string;
    role: "user" | "assistant" | "solitary" | "system";
    speaker: string;
    content: string;
    groupId?: string;
    version?: number;
    status?: EventVersionStatus;
    producer?: EventProducer;
    source?: EventSource;
    metadata?: Record<string, unknown>;
  }): EventLogRecord {
    const id = input.id ?? this.clock.formatLogId();
    const timestamp = input.timestamp ?? this.clock.nowIso();
    const rawMeta = { ...(input.metadata ?? {}) };
    if (rawMeta.config_epoch === undefined) {
      rawMeta.config_epoch = this.getConfigEpoch();
    }
    const inferred = inferDefaultProducerAndSource(input.role, rawMeta);
    const groupId = input.groupId ?? id;
    const version = input.version ?? 1;
    const status: EventVersionStatus = input.status ?? "active";
    const producer: EventProducer = input.producer ?? inferred.producer;
    const source: EventSource = input.source ?? inferred.source;

    this.sqlite
      .query(
        `INSERT OR REPLACE INTO event_log (id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        timestamp,
        input.role,
        input.speaker,
        input.content,
        JSON.stringify(rawMeta),
        groupId,
        version,
        status,
        producer,
        source,
      );

    this.syncEventFtsForId(id);

    return {
      id,
      timestamp,
      role: input.role,
      speaker: input.speaker,
      content: input.content,
      group_id: groupId,
      version,
      status,
      producer,
      source,
      metadata: rawMeta,
    };
  }

  getEventLogById(
    id: string,
    options?: { activeOnly?: boolean },
  ): EventLogRecord | null {
    const row = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
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
          group_id: string;
          version: number;
          status: string;
          producer: string;
          source: string;
        }
      | null;

    if (!row) return null;
    if (options?.activeOnly && row.status !== "active") {
      return null;
    }
    return this.mapRawEventRow(row);
  }

  getRecentEventLogs(limit = 20): EventLogRecord[] {
    const rows = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
         FROM event_log
         WHERE status = 'active'
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
      group_id: string;
      version: number;
      status: string;
      producer: string;
      source: string;
    }>;

    return rows.reverse().map((r) => this.mapRawEventRow(r));
  }

  getEventLogsByConfigEpoch(epoch: number): EventLogRecord[] {
    const rows = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
         FROM event_log
         WHERE status = 'active' AND json_extract(metadata_json, '$.config_epoch') = ?
         ORDER BY timestamp ASC, rowid ASC`,
      )
      .all(epoch) as Array<{
      id: string;
      timestamp: string;
      role: "user" | "assistant" | "solitary" | "system";
      speaker: string;
      content: string;
      metadata_json: string;
      group_id: string;
      version: number;
      status: string;
      producer: string;
      source: string;
    }>;
    return rows.map((r) => this.mapRawEventRow(r));
  }

  getEventLogsByDate(dateStr: string, chronotype?: ChronotypeId): EventLogRecord[] {
    const baseMs = Date.parse(`${dateStr}T00:00:00.000Z`);
    const rows = (
      Number.isFinite(baseMs)
        ? this.sqlite
            .query(
              `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
               FROM event_log
               WHERE status = 'active' AND timestamp >= ? AND timestamp <= ?
               ORDER BY timestamp ASC, rowid ASC`,
            )
            .all(
              new Date(baseMs - 2 * 86_400_000).toISOString(),
              new Date(baseMs + 2 * 86_400_000).toISOString(),
            )
        : this.sqlite
            .query(
              `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
               FROM event_log
               WHERE status = 'active'
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
      group_id: string;
      version: number;
      status: string;
      producer: string;
      source: string;
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
      .map((r) => this.mapRawEventRow(r));
  }

  /**
   * 吸收自 Psyche `coldCursor`：按单调游标获取上次睡眠结转以来的全部未结转 `active` 事件。
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
      group_id: string;
      version: number;
      status: string;
      producer: string;
      source: string;
    };

    if (reflexRow?.last_sleep_event_id) {
      const cursor = this.sqlite
        .query("SELECT rowid FROM event_log WHERE id = ?")
        .get(reflexRow.last_sleep_event_id) as { rowid: number } | null;
      if (cursor) {
        const rows = this.sqlite
          .query(
            `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
             FROM event_log
             WHERE rowid > ? AND status = 'active'
             ORDER BY timestamp ASC, rowid ASC`,
          )
          .all(cursor.rowid) as RawEventRow[];
        return rows.map((r) => this.mapRawEventRow(r));
      }
    }

    if (reflexRow?.last_sleep_settled_at) {
      const rows = this.sqlite
        .query(
          `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
           FROM event_log
           WHERE timestamp > ? AND status = 'active'
           ORDER BY timestamp ASC, rowid ASC`,
        )
        .all(reflexRow.last_sleep_settled_at) as RawEventRow[];
      return rows.map((r) => this.mapRawEventRow(r));
    }

    if (fallbackDateStr) {
      return this.getEventLogsByDate(fallbackDateStr, chronotype);
    }

    const rows = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
         FROM event_log
         WHERE status = 'active'
         ORDER BY timestamp ASC, rowid ASC`,
      )
      .all() as RawEventRow[];
    return rows.map((r) => this.mapRawEventRow(r));
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

  getEventVersionsByGroupId(groupId: string): EventLogRecord[] {
    const rows = this.sqlite
      .query(
        `SELECT id, timestamp, role, speaker, content, metadata_json, group_id, version, status, producer, source
         FROM event_log
         WHERE group_id = ?
         ORDER BY version ASC, rowid ASC`,
      )
      .all(groupId) as Array<{
      id: string;
      timestamp: string;
      role: "user" | "assistant" | "solitary" | "system";
      speaker: string;
      content: string;
      metadata_json: string;
      group_id: string;
      version: number;
      status: string;
      producer: string;
      source: string;
    }>;
    return rows.map((r) => this.mapRawEventRow(r));
  }

  switchActiveEventVersion(
    groupId: string,
    targetVersion: number,
  ): EventLogRecord | null {
    const versions = this.getEventVersionsByGroupId(groupId);
    const target = versions.find((v) => v.version === targetVersion);
    if (!target) return null;

    const tx = this.sqlite.transaction(() => {
      for (const v of versions) {
        const nextStatus: EventVersionStatus =
          v.version === targetVersion ? "active" : "candidate";
        this.sqlite
          .query(`UPDATE event_log SET status = ? WHERE id = ?`)
          .run(nextStatus, v.id);
        this.syncEventFtsForId(v.id);
      }
    });
    tx();

    return this.getEventLogById(target.id);
  }

  purgeCandidateEvents(groupId?: string): number {
    const rows = (
      groupId
        ? this.sqlite
            .query(
              `SELECT id FROM event_log
               WHERE group_id = ? AND status IN ('candidate', 'discarded')`,
            )
            .all(groupId)
        : this.sqlite
            .query(
              `SELECT id FROM event_log
               WHERE status IN ('candidate', 'discarded')`,
            )
            .all()
    ) as Array<{ id: string }>;

    if (rows.length === 0) return 0;

    const tx = this.sqlite.transaction(() => {
      for (const r of rows) {
        this.deleteAttachmentsForEventId(r.id);
        this.sqlite.query(`DELETE FROM event_log_fts WHERE id = ?`).run(r.id);
        this.sqlite.query(`DELETE FROM event_log WHERE id = ?`).run(r.id);
      }
    });
    tx();
    return rows.length;
  }

  deleteEventsFromId(
    targetEventId: string,
    options?: { actor?: SystemLogActor; reason?: string },
  ): {
    deletedIds: string[];
    deletedCount: number;
    crossedSleepCursor: boolean;
    newSleepCursorId: string | null;
    hasSettledHistoryDeleted: boolean;
    affectedDates: string[];
    affectedTimestamps: string[];
  } {
    const directRow = this.sqlite
      .query(
        `SELECT rowid, id, group_id FROM event_log WHERE id = ? OR group_id = ? ORDER BY rowid ASC LIMIT 1`,
      )
      .get(targetEventId, targetEventId) as {
      rowid: number;
      id: string;
      group_id: string;
    } | null;

    if (!directRow) {
      return {
        deletedIds: [],
        deletedCount: 0,
        crossedSleepCursor: false,
        newSleepCursorId: null,
        hasSettledHistoryDeleted: false,
        affectedDates: [],
        affectedTimestamps: [],
      };
    }

    const resolvedGroupId = directRow.group_id || directRow.id;
    const targetRow =
      (this.sqlite
        .query(
          `SELECT rowid, id, group_id FROM event_log WHERE group_id = ? OR id = ? ORDER BY rowid ASC LIMIT 1`,
        )
        .get(resolvedGroupId, directRow.id) as {
        rowid: number;
        id: string;
        group_id: string;
      } | null) ?? directRow;

    const reflexRow = this.sqlite
      .query(`SELECT last_sleep_event_id FROM reflex_state WHERE id = 1`)
      .get() as { last_sleep_event_id: string | null } | null;

    let sleepCursorRowid: number | null = null;
    if (reflexRow?.last_sleep_event_id) {
      const c = this.sqlite
        .query(`SELECT rowid FROM event_log WHERE id = ?`)
        .get(reflexRow.last_sleep_event_id) as { rowid: number } | null;
      sleepCursorRowid = c?.rowid ?? null;
    }

    const toDelete = this.sqlite
      .query(
        `SELECT rowid, id, timestamp FROM event_log
         WHERE rowid >= ?
         ORDER BY rowid ASC`,
      )
      .all(targetRow.rowid) as Array<{
      rowid: number;
      id: string;
      timestamp: string;
    }>;

    const deletedIds = toDelete.map((r) => r.id);
    const affectedTimestamps = toDelete.map((r) => r.timestamp);
    const affectedDates = Array.from(
      new Set(affectedTimestamps.map((ts) => formatLocalDateStr(ts))),
    );
    const hasSettledHistoryDeleted =
      sleepCursorRowid !== null && targetRow.rowid <= sleepCursorRowid;

    let crossedSleepCursor = false;
    let newSleepCursorId: string | null =
      reflexRow?.last_sleep_event_id ?? null;

    const tx = this.sqlite.transaction(() => {
      for (const r of toDelete) {
        this.deleteAttachmentsForEventId(r.id);
        this.sqlite.query(`DELETE FROM event_log_fts WHERE id = ?`).run(r.id);
      }
      this.sqlite
        .query(`DELETE FROM event_log WHERE rowid >= ?`)
        .run(targetRow.rowid);

      if (
        reflexRow?.last_sleep_event_id &&
        deletedIds.includes(reflexRow.last_sleep_event_id)
      ) {
        crossedSleepCursor = true;
        const prevActive = this.sqlite
          .query(
            `SELECT id FROM event_log
             WHERE status = 'active'
             ORDER BY rowid DESC
             LIMIT 1`,
          )
          .get() as { id: string } | null;
        newSleepCursorId = prevActive?.id ?? null;
        if (newSleepCursorId === null) {
          this.sqlite
            .query(
              `UPDATE reflex_state SET last_sleep_event_id = NULL, last_sleep_settled_at = NULL WHERE id = 1`,
            )
            .run();
        } else {
          this.sqlite
            .query(`UPDATE reflex_state SET last_sleep_event_id = ? WHERE id = 1`)
            .run(newSleepCursorId);
        }
      }

      const first = toDelete[0]!;
      const last = toDelete[toDelete.length - 1]!;
      this.appendSystemLog({
        actor: options?.actor ?? "user",
        kind: "message_deleted",
        artifact: `event_log:${first.id}..${last.id}`,
        reason:
          options?.reason ??
          `删除自 ${first.id} 起的 ${toDelete.length} 条消息记录`,
        link: JSON.stringify({
          from_id: first.id,
          to_id: last.id,
          from_ts: first.timestamp,
          to_ts: last.timestamp,
          count: toDelete.length,
          deleted_ids: deletedIds,
          had_settled_history: hasSettledHistoryDeleted,
        }),
      });
    });
    tx();

    return {
      deletedIds,
      deletedCount: deletedIds.length,
      crossedSleepCursor,
      newSleepCursorId,
      hasSettledHistoryDeleted,
      affectedDates,
      affectedTimestamps,
    };
  }

  editLastUnrepliedUserEvent(
    targetEventId: string,
    newContent: string,
    options?: { actor?: SystemLogActor; reason?: string },
  ): EventLogRecord {
    const trimmed = newContent.trim();
    if (!trimmed) {
      throw new Error("编辑后的消息内容不能为空");
    }

    const targetRow = this.sqlite
      .query(
        `SELECT rowid, id, role, producer, status
         FROM event_log WHERE id = ?`,
      )
      .get(targetEventId) as {
      rowid: number;
      id: string;
      role: string;
      producer: string;
      status: string;
    } | null;

    if (!targetRow || targetRow.status !== "active") {
      throw new Error(`目标消息不存在或非当前生效版本: ${targetEventId}`);
    }
    if (targetRow.producer !== "user" && targetRow.role !== "user") {
      throw new Error("只能编辑用户自己发送的消息");
    }

    const subsequentActive = this.sqlite
      .query(
        `SELECT id FROM event_log
         WHERE rowid > ? AND status = 'active'
         LIMIT 1`,
      )
      .get(targetRow.rowid) as { id: string } | null;

    if (subsequentActive) {
      throw new Error(
        "只能直接编辑最近一条且尚无住户回复的用户消息；已有后续消息请走删除并重发",
      );
    }

    const tx = this.sqlite.transaction(() => {
      this.sqlite
        .query(`UPDATE event_log SET content = ? WHERE id = ?`)
        .run(trimmed, targetEventId);
      this.syncEventFtsForId(targetEventId);
      this.appendSystemLog({
        actor: options?.actor ?? "user",
        kind: "message_edited",
        artifact: `event_log:${targetEventId}`,
        oldHash: null,
        newHash: null,
        reason: options?.reason ?? "用户编辑了最近一条未回复消息",
        link: targetEventId,
      });
    });
    tx();

    return this.getEventLogById(targetEventId)!;
  }

  addEventAttachment(input: {
    id?: string;
    eventId: string;
    type: EventAttachmentType;
    data: Uint8Array | string;
    ext?: string;
    mime?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    caption?: string;
  }): EventAttachmentRecord {
    const bytes =
      typeof input.data === "string"
        ? new TextEncoder().encode(input.data)
        : input.data;
    const hash = computeSha256Hex(bytes);
    const cleanExt = input.ext
      ? input.ext.startsWith(".")
        ? input.ext
        : `.${input.ext}`
      : input.type === "image"
        ? ".png"
        : input.type === "video"
          ? ".mp4"
          : input.type === "audio"
            ? ".mp3"
            : ".bin";
    const relPath = path.posix.join(
      "media",
      hash.slice(0, 2),
      `${hash}${cleanExt}`,
    );
    const absPath = path.join(this.dataDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(absPath, bytes);
    }

    const id = input.id ?? `att-${generateUlid(this.clock.nowMs())}`;
    const caption =
      input.caption?.trim() ||
      (input.type === "image" ? `用户分享的图片附件` : null);

    this.sqlite
      .query(
        `INSERT INTO event_attachments (id, event_id, type, path, mime, size_bytes, hash, width, height, duration_ms, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.eventId,
        input.type,
        relPath,
        input.mime ?? null,
        bytes.byteLength,
        hash,
        input.width ?? null,
        input.height ?? null,
        input.durationMs ?? null,
        caption,
      );

    this.syncEventFtsForId(input.eventId);

    return {
      id,
      event_id: input.eventId,
      type: input.type,
      path: relPath,
      mime: input.mime ?? null,
      size_bytes: bytes.byteLength,
      hash,
      width: input.width ?? null,
      height: input.height ?? null,
      duration_ms: input.durationMs ?? null,
      caption,
    };
  }

  getAttachmentsForEvent(eventId: string): EventAttachmentRecord[] {
    const rows = this.sqlite
      .query(
        `SELECT id, event_id, type, path, mime, size_bytes, hash, width, height, duration_ms, caption
         FROM event_attachments
         WHERE event_id = ?
         ORDER BY rowid ASC`,
      )
      .all(eventId) as EventAttachmentRecord[];
    return rows;
  }

  getAttachmentCountByHash(hash: string): number {
    const row = this.sqlite
      .query(`SELECT COUNT(*) AS cnt FROM event_attachments WHERE hash = ?`)
      .get(hash) as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  private deleteAttachmentsForEventId(eventId: string): void {
    const existing = this.getAttachmentsForEvent(eventId);
    if (existing.length === 0) return;

    this.sqlite
      .query(`DELETE FROM event_attachments WHERE event_id = ?`)
      .run(eventId);

    for (const att of existing) {
      const remaining = this.getAttachmentCountByHash(att.hash);
      if (remaining === 0) {
        const absPath = path.join(this.dataDir, att.path);
        fs.rmSync(absPath, { force: true });
      }
    }
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

  searchEventLogsFts(
    queryText: string,
    limit = 10,
    options?: {
      producers?: EventProducer[];
      excludeProducers?: EventProducer[];
    },
  ): EventLogRecord[] {
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

    if (options?.producers && options.producers.length === 0) {
      return [];
    }

    const runMatch = (operator: "AND" | "OR") => {
      const ftsQuery = tokens.map((t) => `"${t}"`).join(` ${operator} `);
      const whereClauses = [`event_log_fts MATCH ?`, `e.status = 'active'`];
      const sqlParams: Array<string | number> = [ftsQuery];

      if (options?.producers && options.producers.length > 0) {
        const placeholders = options.producers.map(() => "?").join(", ");
        whereClauses.push(`e.producer IN (${placeholders})`);
        sqlParams.push(...options.producers);
      } else {
        whereClauses.push(`e.producer != 'system'`);
      }

      if (options?.excludeProducers && options.excludeProducers.length > 0) {
        const placeholders = options.excludeProducers.map(() => "?").join(", ");
        whereClauses.push(`e.producer NOT IN (${placeholders})`);
        sqlParams.push(...options.excludeProducers);
      }

      sqlParams.push(limit);

      return this.sqlite
        .query(
          `SELECT e.id, e.timestamp, e.role, e.speaker, e.content, e.metadata_json, e.group_id, e.version, e.status, e.producer, e.source
           FROM event_log_fts f
           JOIN event_log e ON e.id = f.id
           WHERE ${whereClauses.join(" AND ")}
           ORDER BY bm25(event_log_fts)
           LIMIT ?`,
        )
        .all(...sqlParams) as Array<{
        id: string;
        timestamp: string;
        role: "user" | "assistant" | "solitary" | "system";
        speaker: string;
        content: string;
        metadata_json: string;
        group_id: string;
        version: number;
        status: string;
        producer: string;
        source: string;
      }>;
    };

    let rows = runMatch("AND");
    if (rows.length === 0 && tokens.length > 1) {
      rows = runMatch("OR");
    }

    return rows.map((r) => this.mapRawEventRow(r));
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

  getResidentState(): ResidentStateRecord | null {
    const row = this.sqlite
      .query(
        `SELECT genesis_status, naming_mode, naming_state, persona_config_json, initialized_at, updated_at
         FROM resident_state WHERE id = 1`,
      )
      .get() as {
      genesis_status: GenesisStatus;
      naming_mode: NamingMode;
      naming_state: NamingState;
      persona_config_json: string;
      initialized_at: string | null;
      updated_at: string;
    } | null;

    if (!row) return null;
    const parsedPersona = PersonaConfigSchema.parse(
      JSON.parse(row.persona_config_json),
    );
    return ResidentStateRecordSchema.parse({
      genesis_status: row.genesis_status,
      naming_mode: row.naming_mode,
      naming_state: row.naming_state,
      persona_config: parsedPersona,
      initialized_at: row.initialized_at,
      updated_at: row.updated_at,
    });
  }

  saveResidentState(state: ResidentStateRecord): ResidentStateRecord {
    const validated = ResidentStateRecordSchema.parse(state);
    this.sqlite
      .query(
        `INSERT INTO resident_state (id, genesis_status, naming_mode, naming_state, persona_config_json, initialized_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           genesis_status = excluded.genesis_status,
           naming_mode = excluded.naming_mode,
           naming_state = excluded.naming_state,
           persona_config_json = excluded.persona_config_json,
           initialized_at = excluded.initialized_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        validated.genesis_status,
        validated.naming_mode,
        validated.naming_state,
        JSON.stringify(validated.persona_config),
        validated.initialized_at,
        validated.updated_at,
      );
    return validated;
  }

  getReflexState(): ReflexState {
    const row = this.sqlite
      .query(
        `SELECT consecutive_unanswered_proactive, last_proactive_at, last_user_message_at, proactive_lock, last_sleep_settled_at, last_sleep_event_id, last_backup_at, last_backup_date
         FROM reflex_state WHERE id = 1`,
      )
      .get() as {
      consecutive_unanswered_proactive: number;
      last_proactive_at: string | null;
      last_user_message_at: string | null;
      proactive_lock: number;
      last_sleep_settled_at: string | null;
      last_sleep_event_id: string | null;
      last_backup_at: string | null;
      last_backup_date: string | null;
    };
    return ReflexStateSchema.parse({
      consecutive_unanswered_proactive: row.consecutive_unanswered_proactive,
      last_proactive_at: row.last_proactive_at,
      last_user_message_at: row.last_user_message_at,
      proactive_lock: Boolean(row.proactive_lock),
      last_sleep_settled_at: row.last_sleep_settled_at ?? null,
      last_sleep_event_id: row.last_sleep_event_id ?? null,
      last_backup_at: row.last_backup_at ?? null,
      last_backup_date: row.last_backup_date ?? null,
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
    const lastBackupAt =
      validated.last_backup_at !== undefined
        ? validated.last_backup_at
        : (current.last_backup_at ?? null);
    const lastBackupDate =
      validated.last_backup_date !== undefined
        ? validated.last_backup_date
        : (current.last_backup_date ?? null);
    this.sqlite
      .query(
        `UPDATE reflex_state
         SET consecutive_unanswered_proactive = ?,
             last_proactive_at = ?,
             last_user_message_at = ?,
             proactive_lock = ?,
             last_sleep_settled_at = ?,
             last_sleep_event_id = ?,
             last_backup_at = ?,
             last_backup_date = ?
         WHERE id = 1`,
      )
      .run(
        validated.consecutive_unanswered_proactive,
        validated.last_proactive_at,
        validated.last_user_message_at,
        validated.proactive_lock ? 1 : 0,
        settledAt,
        lastEventId,
        lastBackupAt,
        lastBackupDate,
      );
  }

  recordBackupCompleted(backupAtIso: string, backupDateStr: string): void {
    this.sqlite
      .query(
        `UPDATE reflex_state
         SET last_backup_at = ?, last_backup_date = ?
         WHERE id = 1`,
      )
      .run(backupAtIso, backupDateStr);
  }

  deleteConcernsBySourceEventIds(eventIds: readonly string[]): string[] {
    if (eventIds.length === 0) return [];
    const deletedConcernIds: string[] = [];
    for (const evId of eventIds) {
      const rows = this.sqlite
        .query(`SELECT id FROM concerns WHERE source_event_id = ?`)
        .all(evId) as Array<{ id: string }>;
      for (const r of rows) {
        deletedConcernIds.push(r.id);
      }
      this.sqlite
        .query(`DELETE FROM concerns WHERE source_event_id = ?`)
        .run(evId);
    }
    return deletedConcernIds;
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

  upsertMemoryMeta(
    meta: MemoryMetaRecord,
    options?: { clearEmbedding?: boolean; clearAuditFingerprint?: boolean },
  ): void {
    this.sqlite
      .query(`DELETE FROM memory_meta WHERE path = ? AND id != ?`)
      .run(meta.path, meta.id);
    const embeddingUpdateSql = options?.clearEmbedding
      ? `excluded.embedding_json`
      : `COALESCE(excluded.embedding_json, memory_meta.embedding_json)`;
    const auditFingerprintUpdateSql = options?.clearAuditFingerprint
      ? `excluded.audit_fingerprint`
      : `COALESCE(excluded.audit_fingerprint, memory_meta.audit_fingerprint)`;
    this.sqlite
      .query(
        `INSERT INTO memory_meta (id, path, category, status, allow_forget, strength, access_count, last_accessed, embedding_json, embedding_fingerprint, audit_fingerprint, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           category = excluded.category,
           status = excluded.status,
           allow_forget = excluded.allow_forget,
           strength = excluded.strength,
           access_count = excluded.access_count,
           last_accessed = excluded.last_accessed,
           embedding_json = ${embeddingUpdateSql},
           embedding_fingerprint = COALESCE(excluded.embedding_fingerprint, memory_meta.embedding_fingerprint),
           audit_fingerprint = ${auditFingerprintUpdateSql},
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
        meta.embedding_fingerprint ?? null,
        meta.audit_fingerprint ?? null,
        meta.updated_at,
      );
  }

  setMemoryAuditFingerprint(id: string, auditFingerprint: string | null): void {
    this.sqlite
      .query(`UPDATE memory_meta SET audit_fingerprint = ? WHERE id = ?`)
      .run(auditFingerprint, id);
  }

  deleteMemoryMeta(id: string): void {
    this.sqlite.query(`DELETE FROM memory_meta WHERE id = ?`).run(id);
    this.sqlite
      .query(`DELETE FROM memory_embeddings WHERE memory_id = ?`)
      .run(id);
  }

  upsertMemoryEmbedding(params: {
    memoryId: string;
    modelKey: string;
    embeddingFingerprint: string;
    embedding: number[];
    updatedAtIso?: string;
  }): void {
    const updatedAt = params.updatedAtIso ?? this.clock.nowIso();
    this.sqlite
      .query(
        `INSERT INTO memory_embeddings (memory_id, model_key, embedding_fingerprint, embedding_json, dimensions, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, model_key) DO UPDATE SET
           embedding_fingerprint = excluded.embedding_fingerprint,
           embedding_json = excluded.embedding_json,
           dimensions = excluded.dimensions,
           updated_at = excluded.updated_at`,
      )
      .run(
        params.memoryId,
        params.modelKey,
        params.embeddingFingerprint,
        JSON.stringify(params.embedding),
        params.embedding.length,
        updatedAt,
      );
  }

  getMemoryEmbedding(
    memoryId: string,
    modelKey: string,
    expectedFingerprint?: string,
  ): MemoryEmbeddingRecord | null {
    const row = this.sqlite
      .query(
        `SELECT memory_id, model_key, embedding_fingerprint, embedding_json, dimensions, updated_at
         FROM memory_embeddings
         WHERE memory_id = ? AND model_key = ?`,
      )
      .get(memoryId, modelKey) as {
      memory_id: string;
      model_key: string;
      embedding_fingerprint: string;
      embedding_json: string;
      dimensions: number;
      updated_at: string;
    } | null;
    if (!row) return null;
    if (
      expectedFingerprint !== undefined &&
      row.embedding_fingerprint !== expectedFingerprint
    ) {
      return null;
    }
    return {
      memory_id: row.memory_id,
      model_key: row.model_key,
      embedding_fingerprint: row.embedding_fingerprint,
      embedding: JSON.parse(row.embedding_json) as number[],
      dimensions: row.dimensions,
      updated_at: row.updated_at,
    };
  }

  listMemoryEmbeddingsByModel(
    modelKey: string,
  ): Map<string, MemoryEmbeddingRecord> {
    const rows = this.sqlite
      .query(
        `SELECT memory_id, model_key, embedding_fingerprint, embedding_json, dimensions, updated_at
         FROM memory_embeddings
         WHERE model_key = ?`,
      )
      .all(modelKey) as Array<{
      memory_id: string;
      model_key: string;
      embedding_fingerprint: string;
      embedding_json: string;
      dimensions: number;
      updated_at: string;
    }>;
    const map = new Map<string, MemoryEmbeddingRecord>();
    for (const row of rows) {
      map.set(row.memory_id, {
        memory_id: row.memory_id,
        model_key: row.model_key,
        embedding_fingerprint: row.embedding_fingerprint,
        embedding: JSON.parse(row.embedding_json) as number[],
        dimensions: row.dimensions,
        updated_at: row.updated_at,
      });
    }
    return map;
  }

  deleteStaleMemoryEmbeddings(
    memoryId: string,
    validFingerprint: string,
  ): void {
    this.sqlite
      .query(
        `DELETE FROM memory_embeddings
         WHERE memory_id = ? AND embedding_fingerprint != ?`,
      )
      .run(memoryId, validFingerprint);
  }

  deleteMemoryEmbeddingsForId(memoryId: string): void {
    this.sqlite
      .query(`DELETE FROM memory_embeddings WHERE memory_id = ?`)
      .run(memoryId);
  }

  listEmbeddingModels(): Array<{
    model_key: string;
    count: number;
    last_updated_at: string;
  }> {
    return this.sqlite
      .query(
        `SELECT model_key, COUNT(*) AS count, MAX(updated_at) AS last_updated_at
         FROM memory_embeddings
         GROUP BY model_key
         ORDER BY last_updated_at DESC, model_key ASC`,
      )
      .all() as Array<{
      model_key: string;
      count: number;
      last_updated_at: string;
    }>;
  }

  touchEmbeddingModel(modelKey: string, updatedAtIso?: string): void {
    const ts = updatedAtIso ?? this.clock.nowIso();
    this.sqlite
      .query(`UPDATE memory_embeddings SET updated_at = ? WHERE model_key = ?`)
      .run(ts, modelKey);
  }

  pruneOldEmbeddingModels(
    keepMaxModels = 3,
    preserveModelKey?: string,
  ): number {
    if (keepMaxModels <= 0) return 0;
    const models = this.listEmbeddingModels();
    if (models.length <= keepMaxModels) return 0;

    const kept = new Set<string>();
    if (preserveModelKey && models.some((m) => m.model_key === preserveModelKey)) {
      kept.add(preserveModelKey);
    }
    for (const m of models) {
      if (kept.size >= keepMaxModels) break;
      kept.add(m.model_key);
    }

    const toDelete = models
      .map((m) => m.model_key)
      .filter((k) => !kept.has(k));
    if (toDelete.length === 0) return 0;

    let deletedRows = 0;
    for (const key of toDelete) {
      const res = this.sqlite
        .query(`DELETE FROM memory_embeddings WHERE model_key = ?`)
        .run(key);
      deletedRows += res.changes;
    }
    return deletedRows;
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
          embedding_fingerprint: string | null;
          audit_fingerprint: string | null;
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
      embedding_fingerprint: row.embedding_fingerprint ?? undefined,
      audit_fingerprint: row.audit_fingerprint ?? undefined,
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
      embedding_fingerprint: string | null;
      audit_fingerprint: string | null;
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
      embedding_fingerprint: row.embedding_fingerprint ?? undefined,
      audit_fingerprint: row.audit_fingerprint ?? undefined,
      updated_at: row.updated_at,
    }));
  }

  decayAndPruneTransitionsFrom(
    fromMemoryId: string,
    decayFactor: number,
    pruneThreshold: number,
  ): void {
    this.sqlite
      .query(
        `UPDATE memory_transitions
         SET weight = weight * ?
         WHERE from_memory_id = ?`,
      )
      .run(decayFactor, fromMemoryId);
    this.sqlite
      .query(
        `DELETE FROM memory_transitions
         WHERE from_memory_id = ? AND weight < ?`,
      )
      .run(fromMemoryId, pruneThreshold);
  }

  incrementMemoryTransition(
    fromMemoryId: string,
    toMemoryId: string,
    delta: number,
    updatedAtIso: string,
  ): void {
    if (fromMemoryId === toMemoryId || delta <= 0) return;
    this.sqlite
      .query(
        `INSERT INTO memory_transitions (from_memory_id, to_memory_id, weight, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(from_memory_id, to_memory_id) DO UPDATE SET
           weight = memory_transitions.weight + excluded.weight,
           updated_at = excluded.updated_at`,
      )
      .run(fromMemoryId, toMemoryId, delta, updatedAtIso);
  }

  getTopMemoryTransitions(
    fromMemoryId: string,
    options?: { minWeight?: number; limit?: number },
  ): MemoryTransitionRecord[] {
    const minWeight = options?.minWeight ?? 0.2;
    const limit = options?.limit ?? 3;
    return this.sqlite
      .query(
        `SELECT from_memory_id, to_memory_id, weight, updated_at
         FROM memory_transitions
         WHERE from_memory_id = ? AND weight >= ?
         ORDER BY weight DESC, to_memory_id ASC
         LIMIT ?`,
      )
      .all(fromMemoryId, minWeight, limit) as MemoryTransitionRecord[];
  }

  listTransitionsFrom(fromMemoryId: string): MemoryTransitionRecord[] {
    return this.sqlite
      .query(
        `SELECT from_memory_id, to_memory_id, weight, updated_at
         FROM memory_transitions
         WHERE from_memory_id = ?
         ORDER BY weight DESC, to_memory_id ASC`,
      )
      .all(fromMemoryId) as MemoryTransitionRecord[];
  }

  captureMemorySnapshotOnWrite(params: {
    sleepDate: string;
    memoryId: string;
    relPath: string;
    currentDiskContent: string | null;
    createdAtIso?: string;
  }): boolean {
    const isCreation = params.currentDiskContent === null ? 1 : 0;
    const createdAt = params.createdAtIso ?? this.clock.nowIso();
    const res = this.sqlite
      .query(
        `INSERT OR IGNORE INTO memory_snapshots (sleep_date, memory_id, rel_path, original_content, is_creation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sleepDate,
        params.memoryId,
        params.relPath,
        params.currentDiskContent,
        isCreation,
        createdAt,
      );
    return res.changes > 0;
  }

  getMemorySnapshot(
    sleepDate: string,
    memoryId: string,
  ): MemorySnapshotRecord | null {
    const row = this.sqlite
      .query(
        `SELECT id, sleep_date, memory_id, rel_path, original_content, is_creation, created_at
         FROM memory_snapshots
         WHERE sleep_date = ? AND memory_id = ?`,
      )
      .get(sleepDate, memoryId) as
      | {
          id: number;
          sleep_date: string;
          memory_id: string;
          rel_path: string;
          original_content: string | null;
          is_creation: number;
          created_at: string;
        }
      | null;
    if (!row) return null;
    return {
      ...row,
      is_creation: Boolean(row.is_creation),
    };
  }

  listMemorySnapshots(sleepDate?: string): MemorySnapshotRecord[] {
    const rows = (
      sleepDate
        ? this.sqlite
            .query(
              `SELECT id, sleep_date, memory_id, rel_path, original_content, is_creation, created_at
               FROM memory_snapshots
               WHERE sleep_date = ?
               ORDER BY id ASC`,
            )
            .all(sleepDate)
        : this.sqlite
            .query(
              `SELECT id, sleep_date, memory_id, rel_path, original_content, is_creation, created_at
               FROM memory_snapshots
               ORDER BY sleep_date DESC, id ASC`,
            )
            .all()
    ) as Array<{
      id: number;
      sleep_date: string;
      memory_id: string;
      rel_path: string;
      original_content: string | null;
      is_creation: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      ...row,
      is_creation: Boolean(row.is_creation),
    }));
  }

  deleteMemorySnapshot(sleepDate: string, memoryId: string): void {
    this.sqlite
      .query(
        `DELETE FROM memory_snapshots WHERE sleep_date = ? AND memory_id = ?`,
      )
      .run(sleepDate, memoryId);
  }

  pruneOldMemorySnapshots(keepDays = 7): number {
    if (keepDays <= 0) {
      const res = this.sqlite.query(`DELETE FROM memory_snapshots`).run();
      return res.changes;
    }
    const res = this.sqlite
      .query(
        `DELETE FROM memory_snapshots
         WHERE sleep_date NOT IN (
           SELECT DISTINCT sleep_date
           FROM memory_snapshots
           ORDER BY sleep_date DESC
           LIMIT ?
         )`,
      )
      .run(keepDays);
    return res.changes;
  }

  close(): void {
    this.sqlite.close();
  }
}
