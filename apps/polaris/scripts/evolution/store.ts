import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  EvolutionExecutionEvent,
  EvolutionMemoryChange,
  EvolutionMemoryEntry,
  EvolutionMemoryQuery,
} from "./types.js";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs();
  return sqlJsPromise;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rowToRecord<T>(columns: string[], values: unknown[]): T {
  const out: Record<string, unknown> = {};
  for (let index = 0; index < columns.length; index += 1) {
    out[columns[index]] = values[index];
  }
  return out as T;
}

type SqlScalar = string | number | null;

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return typeof parsed === "object" && parsed ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class EvolutionStore {
  private constructor(
    private readonly dbPath: string,
    private readonly db: Database,
  ) {}

  static async open(dbPath: string): Promise<EvolutionStore> {
    const sqlite = await loadSqlJs();
    ensureParentDir(dbPath);
    const db = fs.existsSync(dbPath)
      ? new sqlite.Database(fs.readFileSync(dbPath))
      : new sqlite.Database();
    const store = new EvolutionStore(dbPath, db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS execution_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        manager_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_profile_id TEXT,
        target TEXT NOT NULL,
        section_name TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_memory_changes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_profile_id TEXT,
        target TEXT NOT NULL,
        operation TEXT NOT NULL,
        section_name TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        candidate_json TEXT,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_session_id TEXT,
        source_run_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_execution_events_workspace_session
        ON execution_events(workspace_id, session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace_target
        ON memory_entries(workspace_id, target, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_user_target
        ON memory_entries(user_profile_id, target, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_pending_memory_changes_workspace_status
        ON pending_memory_changes(workspace_id, status, updated_at);
    `);
    this.flush();
  }

  flush(): void {
    ensureParentDir(this.dbPath);
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  close(): void {
    this.flush();
    this.db.close();
  }

  recordEvent(event: EvolutionExecutionEvent): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO execution_events (
        id, workspace_id, manager_id, session_id, turn_id, kind, timestamp, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      event.id,
      event.workspaceId,
      event.managerId,
      event.sessionId,
      event.turnId ?? null,
      event.kind,
      event.timestamp,
      JSON.stringify(event.payload),
    ]);
    stmt.free();
    this.flush();
  }

  listEventsForSession(workspaceId: string, sessionId: string): EvolutionExecutionEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, workspace_id, manager_id, session_id, turn_id, kind, timestamp, payload_json
      FROM execution_events
      WHERE workspace_id = ? AND session_id = ?
      ORDER BY timestamp ASC
    `);
    stmt.bind([workspaceId, sessionId]);
    const rows: EvolutionExecutionEvent[] = [];
    while (stmt.step()) {
      const row = rowToRecord<Record<string, unknown>>(stmt.getColumnNames(), stmt.get());
      rows.push({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        managerId: String(row.manager_id),
        sessionId: String(row.session_id),
        turnId: row.turn_id ? String(row.turn_id) : undefined,
        kind: String(row.kind) as EvolutionExecutionEvent["kind"],
        timestamp: String(row.timestamp),
        payload: parseJsonObject(row.payload_json),
      });
    }
    stmt.free();
    return rows;
  }

  listEventsForWorkspace(workspaceId: string): EvolutionExecutionEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, workspace_id, manager_id, session_id, turn_id, kind, timestamp, payload_json
      FROM execution_events
      WHERE workspace_id = ?
      ORDER BY timestamp ASC
    `);
    stmt.bind([workspaceId]);
    const rows: EvolutionExecutionEvent[] = [];
    while (stmt.step()) {
      const row = rowToRecord<Record<string, unknown>>(stmt.getColumnNames(), stmt.get());
      rows.push({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        managerId: String(row.manager_id),
        sessionId: String(row.session_id),
        turnId: row.turn_id ? String(row.turn_id) : undefined,
        kind: String(row.kind) as EvolutionExecutionEvent["kind"],
        timestamp: String(row.timestamp),
        payload: parseJsonObject(row.payload_json),
      });
    }
    stmt.free();
    return rows;
  }

  upsertMemoryEntry(entry: EvolutionMemoryEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_entries (
        id, workspace_id, user_profile_id, target, section_name, entry_key, title, body,
        confidence, status, source_session_id, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      entry.id,
      entry.workspaceId,
      entry.userProfileId ?? null,
      entry.target,
      entry.section,
      entry.key,
      entry.title,
      entry.body,
      entry.confidence,
      entry.status,
      entry.sourceSessionId ?? null,
      entry.createdAt,
      entry.updatedAt,
      JSON.stringify(entry.metadata),
    ]);
    stmt.free();
    this.flush();
  }

  queryMemoryEntries(query: EvolutionMemoryQuery): EvolutionMemoryEntry[] {
    const clauses = ["status = 'active'", "workspace_id = ?"];
    const params: SqlScalar[] = [query.workspaceId];
    if (query.userProfileId) {
      clauses.push("(target = 'workspace-memory' OR user_profile_id = ?)");
      params.push(query.userProfileId);
    }
    if (query.target) {
      clauses.push("target = ?");
      params.push(query.target);
    }
    if (query.section) {
      clauses.push("section_name = ?");
      params.push(query.section);
    }
    if (query.text?.trim()) {
      clauses.push("(title LIKE ? OR body LIKE ? OR entry_key LIKE ?)");
      const pattern = `%${query.text.trim()}%`;
      params.push(pattern, pattern, pattern);
    }
    params.push(query.limit ?? 20);
    const stmt = this.db.prepare(`
      SELECT id, workspace_id, user_profile_id, target, section_name, entry_key, title, body,
             confidence, status, source_session_id, created_at, updated_at, metadata_json
      FROM memory_entries
      WHERE ${clauses.join(" AND ")}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `);
    stmt.bind(params);
    const rows: EvolutionMemoryEntry[] = [];
    while (stmt.step()) {
      const row = rowToRecord<Record<string, unknown>>(stmt.getColumnNames(), stmt.get());
      rows.push({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        userProfileId: row.user_profile_id ? String(row.user_profile_id) : undefined,
        target: String(row.target) as EvolutionMemoryEntry["target"],
        section: String(row.section_name),
        key: String(row.entry_key),
        title: String(row.title),
        body: String(row.body),
        confidence: Number(row.confidence),
        status: String(row.status) as EvolutionMemoryEntry["status"],
        sourceSessionId: row.source_session_id ? String(row.source_session_id) : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        metadata: parseJsonObject(row.metadata_json),
      });
    }
    stmt.free();
    return rows;
  }

  findActiveMemoryEntry(workspaceId: string, target: EvolutionMemoryEntry["target"], key: string): EvolutionMemoryEntry | null {
    const rows = this.queryMemoryEntries({ workspaceId, target, limit: 100 }).filter((entry) => entry.key === key);
    return rows[0] ?? null;
  }

  archiveMemoryEntries(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const stmt = this.db.prepare(`
      UPDATE memory_entries
      SET status = 'archived'
      WHERE id IN (${ids.map(() => "?").join(", ")})
    `);
    stmt.run(ids);
    stmt.free();
    this.flush();
  }

  savePendingMemoryChange(change: EvolutionMemoryChange): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pending_memory_changes (
        id, workspace_id, user_profile_id, target, operation, section_name, entry_key,
        candidate_json, reason, confidence, source_session_id, source_run_ids_json,
        created_at, updated_at, status, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      change.id,
      change.workspaceId,
      change.userProfileId ?? null,
      change.target,
      change.operation,
      change.section,
      change.key,
      change.candidate ? JSON.stringify(change.candidate) : null,
      change.reason,
      change.confidence,
      change.sourceSessionId ?? null,
      JSON.stringify(change.sourceRunIds ?? []),
      change.createdAt,
      change.updatedAt,
      change.status,
      JSON.stringify(change.metadata),
    ]);
    stmt.free();
    this.flush();
  }

  listPendingMemoryChanges(workspaceId: string, status?: EvolutionMemoryChange["status"]): EvolutionMemoryChange[] {
    const clauses = ["workspace_id = ?"];
    const params: SqlScalar[] = [workspaceId];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    const stmt = this.db.prepare(`
      SELECT id, workspace_id, user_profile_id, target, operation, section_name, entry_key,
             candidate_json, reason, confidence, source_session_id, source_run_ids_json,
             created_at, updated_at, status, metadata_json
      FROM pending_memory_changes
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
    `);
    stmt.bind(params);
    const rows: EvolutionMemoryChange[] = [];
    while (stmt.step()) {
      const row = rowToRecord<Record<string, unknown>>(stmt.getColumnNames(), stmt.get());
      rows.push({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        userProfileId: row.user_profile_id ? String(row.user_profile_id) : undefined,
        target: String(row.target) as EvolutionMemoryChange["target"],
        operation: String(row.operation) as EvolutionMemoryChange["operation"],
        section: String(row.section_name),
        key: String(row.entry_key),
        candidate: row.candidate_json ? JSON.parse(String(row.candidate_json)) as EvolutionMemoryChange["candidate"] : undefined,
        reason: String(row.reason),
        confidence: Number(row.confidence),
        sourceSessionId: row.source_session_id ? String(row.source_session_id) : undefined,
        sourceRunIds: JSON.parse(String(row.source_run_ids_json ?? "[]")) as string[],
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        status: String(row.status) as EvolutionMemoryChange["status"],
        metadata: parseJsonObject(row.metadata_json),
      });
    }
    stmt.free();
    return rows;
  }

  updatePendingMemoryChangeStatus(id: string, status: EvolutionMemoryChange["status"]): void {
    const stmt = this.db.prepare(`
      UPDATE pending_memory_changes
      SET status = ?
      WHERE id = ?
    `);
    stmt.run([status, id]);
    stmt.free();
    this.flush();
  }

  summarize(workspaceId: string, userProfileId?: string): {
    artifactCount: number;
    activeWorkspaceArtifacts: number;
    activeUserArtifacts: number;
    latestTitles: string[];
    latestArtifacts: Array<{
      title: string;
      kind: string;
      status: string;
      whyExists?: string;
      whyRetrieved?: string[];
      curatorAction?: string;
      curatorReason?: string;
      suppressedBecause?: string;
    }>;
    pendingMemoryChanges: number;
  } {
    const workspaceEntries = this.queryMemoryEntries({ workspaceId, target: "workspace-memory", limit: 1000 });
    const userEntries = userProfileId
      ? this.queryMemoryEntries({ workspaceId, userProfileId, target: "user-memory", limit: 1000 })
      : [];
    const all = [...workspaceEntries, ...userEntries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      artifactCount: all.length,
      activeWorkspaceArtifacts: workspaceEntries.length,
      activeUserArtifacts: userEntries.length,
      latestTitles: all.slice(0, 5).map((entry) => entry.title),
      latestArtifacts: all.slice(0, 5).map((entry) => {
        const metadata = entry.metadata as Record<string, unknown>;
        const explainability = (metadata.explainability ?? {}) as Record<string, unknown>;
        const retrieval = (metadata.retrieval ?? {}) as Record<string, unknown>;
        const curator = (metadata.curator ?? {}) as Record<string, unknown>;
        return {
          title: entry.title,
          kind: entry.target,
          status: entry.status,
          whyExists: typeof explainability.existsBecause === "string"
            ? explainability.existsBecause
            : undefined,
          whyRetrieved: Array.isArray(retrieval.reasons)
            ? retrieval.reasons as string[]
            : undefined,
          curatorAction: typeof curator.action === "string"
            ? curator.action
            : undefined,
          curatorReason: typeof curator.reason === "string"
            ? curator.reason
            : undefined,
          suppressedBecause: typeof explainability.suppressedBecause === "string"
            ? explainability.suppressedBecause
            : undefined,
        };
      }),
      pendingMemoryChanges: this.listPendingMemoryChanges(workspaceId, "pending").length,
    };
  }
}
