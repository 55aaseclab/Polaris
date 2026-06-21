import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  EvolutionArtifact,
  EvolutionExecutionEvent,
  EvolutionRetrievalQuery,
} from "./types.js";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs();
  return sqlJsPromise;
}

function nowIso(): string {
  return new Date().toISOString();
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

export class EvolutionStore {
  private constructor(
    private readonly dbPath: string,
    private readonly sqlite: SqlJsStatic,
    private readonly db: Database,
  ) {}

  static async open(dbPath: string): Promise<EvolutionStore> {
    const sqlite = await loadSqlJs();
    ensureParentDir(dbPath);
    const db = fs.existsSync(dbPath)
      ? new sqlite.Database(fs.readFileSync(dbPath))
      : new sqlite.Database();
    const store = new EvolutionStore(dbPath, sqlite, db);
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

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_profile_id TEXT,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_execution_events_workspace_session
        ON execution_events(workspace_id, session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_scope_kind
        ON artifacts(workspace_id, scope, kind, status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_user_scope_kind
        ON artifacts(user_profile_id, scope, kind, status);
    `);
    this.flush();
  }

  flush(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
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
        payload: JSON.parse(String(row.payload_json)),
      });
    }
    stmt.free();
    return rows;
  }

  upsertArtifact(artifact: EvolutionArtifact): void {
    const timestamp = artifact.updatedAt || nowIso();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (
        id, workspace_id, user_profile_id, kind, scope, title, content, confidence,
        status, source_session_id, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      artifact.id,
      artifact.workspaceId,
      artifact.userProfileId ?? null,
      artifact.kind,
      artifact.scope,
      artifact.title,
      artifact.content,
      artifact.confidence,
      artifact.status,
      artifact.sourceSessionId ?? null,
      artifact.createdAt,
      timestamp,
      JSON.stringify(artifact.metadata),
    ]);
    stmt.free();
    this.flush();
  }

  queryArtifacts(query: EvolutionRetrievalQuery): EvolutionArtifact[] {
    const limit = query.limit ?? 10;
    const kinds = query.kinds ?? [];
    const clauses = ["status = 'active'", "workspace_id = ?"];
    const params: SqlScalar[] = [query.workspaceId];
    if (query.userProfileId) {
      clauses.push("(scope = 'workspace' OR user_profile_id = ?)");
      params.push(query.userProfileId);
    }
    if (kinds.length > 0) {
      clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }
    if (query.text?.trim()) {
      clauses.push("(title LIKE ? OR content LIKE ?)");
      const pattern = `%${query.text.trim()}%`;
      params.push(pattern, pattern);
    }
    params.push(limit);
    const stmt = this.db.prepare(`
      SELECT id, workspace_id, user_profile_id, kind, scope, title, content, confidence,
             status, source_session_id, created_at, updated_at, metadata_json
      FROM artifacts
      WHERE ${clauses.join(" AND ")}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `);
    stmt.bind(params);
    const rows: EvolutionArtifact[] = [];
    while (stmt.step()) {
      const row = rowToRecord<Record<string, unknown>>(stmt.getColumnNames(), stmt.get());
      rows.push({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        userProfileId: row.user_profile_id ? String(row.user_profile_id) : undefined,
        kind: String(row.kind) as EvolutionArtifact["kind"],
        scope: String(row.scope) as EvolutionArtifact["scope"],
        title: String(row.title),
        content: String(row.content),
        confidence: Number(row.confidence),
        status: String(row.status) as EvolutionArtifact["status"],
        sourceSessionId: row.source_session_id ? String(row.source_session_id) : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        metadata: JSON.parse(String(row.metadata_json)),
      });
    }
    stmt.free();
    return rows;
  }

  archiveArtifacts(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`
      UPDATE artifacts
      SET status = 'archived', updated_at = ?
      WHERE id IN (${ids.map(() => "?").join(", ")})
    `);
    stmt.run([nowIso(), ...ids]);
    stmt.free();
    this.flush();
  }
}
