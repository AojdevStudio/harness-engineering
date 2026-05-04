import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { RunAttemptStatus } from "@symphony/core";
import { schemaStatements } from "./schema.ts";

// Each migration version owns a slice of schemaStatements.
// Version 1 includes all current schema — future versions append new statements.
const migrations: readonly { readonly version: number; readonly statements: readonly string[] }[] = [
  { version: 1, statements: schemaStatements },
];

export type EventLevel = "debug" | "info" | "warn" | "error";

export interface OpenSymphonyDatabaseOptions {
  readonly path?: string;
  readonly readonly?: boolean;
}

export interface AppendEventInput {
  readonly runId?: string | null;
  readonly attemptId?: string | null;
  readonly issueId?: string | null;
  readonly identifier?: string | null;
  readonly level?: EventLevel;
  readonly type: string;
  readonly message: string;
  readonly payload?: unknown;
  readonly createdAt?: string;
}

export interface StoredEvent {
  readonly id: number;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly issueId: string | null;
  readonly identifier: string | null;
  readonly level: EventLevel;
  readonly type: string;
  readonly message: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface CreateRunInput {
  readonly runId?: string;
  readonly issueId: string;
  readonly identifier: string;
  readonly workspacePath?: string | null;
  readonly status?: RunAttemptStatus;
  readonly startedAt?: string;
}

export interface ClaimInput {
  readonly issueId: string;
  readonly identifier: string;
  readonly state: string;
  readonly runId?: string | null;
}

export interface StoredRun {
  readonly runId: string;
  readonly issueId: string;
  readonly identifier: string;
  readonly workspacePath: string | null;
  readonly status: RunAttemptStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly lastError: string | null;
}

export interface EvidenceRecordInput {
  readonly artifactId: string;
  readonly runId: string;
  readonly issueId?: string | null;
  readonly kind: string;
  readonly uri: string;
  readonly label: string;
  readonly metadata?: unknown;
  readonly createdAt?: string;
}

export interface StoredEvidenceRecord extends EvidenceRecordInput {
  readonly issueId: string | null;
  readonly metadata: unknown;
  readonly createdAt: string;
}

export interface StoredRetryEntry {
  readonly issueId: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly dueAtMs: number;
  readonly error: string | null;
}

export interface UpsertIssueSeenInput {
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  readonly state: string;
  readonly payload?: unknown;
}

export interface RecordRunAttemptInput {
  readonly attemptId?: string;
  readonly runId: string;
  readonly attempt: number;
  readonly status: RunAttemptStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string | null;
  readonly error?: string | null;
}

export interface StoredRunAttempt {
  readonly attemptId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly status: RunAttemptStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface RecordRunnerSessionInput {
  readonly sessionId?: string;
  readonly runId: string;
  readonly attemptId?: string | null;
  readonly runnerKind: string;
  readonly threadId?: string | null;
  readonly turnId?: string | null;
  readonly pid?: string | null;
}

export interface StoredRunnerSession {
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly runnerKind: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly pid: string | null;
  readonly startedAt: string;
  readonly lastEventAt: string | null;
}

export interface RecordControlActionInput {
  readonly actionId?: string;
  readonly action: string;
  readonly issueId?: string | null;
  readonly runId?: string | null;
  readonly status: string;
  readonly requestedBy?: string | null;
  readonly payload?: unknown;
}

type EventRow = {
  id: number;
  run_id: string | null;
  attempt_id: string | null;
  issue_id: string | null;
  identifier: string | null;
  level: EventLevel;
  type: string;
  message: string;
  payload_json: string;
  created_at: string;
};

type RunRow = {
  run_id: string;
  issue_id: string;
  identifier: string;
  workspace_path: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  last_error: string | null;
};

type EvidenceRow = {
  artifact_id: string;
  run_id: string;
  issue_id: string | null;
  kind: string;
  uri: string;
  label: string;
  metadata_json: string;
  created_at: string;
};

type RetryRow = {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export interface JsonParseError {
  readonly __jsonParseError: string;
  readonly raw: string;
}

export function isJsonParseError(value: unknown): value is JsonParseError {
  return typeof value === "object" && value !== null && "__jsonParseError" in value;
}

function parseJson(value: string): unknown | JsonParseError {
  try {
    return JSON.parse(value);
  } catch (error) {
    return { __jsonParseError: error instanceof Error ? error.message : String(error), raw: value };
  }
}

function mapEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    issueId: row.issue_id,
    identifier: row.identifier,
    level: row.level,
    type: row.type,
    message: row.message,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function mapRun(row: RunRow): StoredRun {
  return {
    runId: row.run_id,
    issueId: row.issue_id,
    identifier: row.identifier,
    workspacePath: row.workspace_path,
    status: row.status as RunAttemptStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
  };
}

function mapEvidence(row: EvidenceRow): StoredEvidenceRecord {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    issueId: row.issue_id,
    kind: row.kind,
    uri: row.uri,
    label: row.label,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

export class SymphonyDatabase {
  readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  migrate(): void {
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA synchronous = NORMAL");

    // Bootstrap the migrations table itself (not part of versioned migrations).
    this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);

    // Read the max applied version (0 if none applied yet).
    const maxApplied = (this.database
      .query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
      .get() as { v: number } | null)?.v ?? 0;

    // Apply only migrations with version > maxApplied, each in its own transaction.
    for (const migration of migrations) {
      if (migration.version <= maxApplied) continue;
      this.database.transaction(() => {
        for (const statement of migration.statements) {
          // Skip the schema_migrations CREATE — already bootstrapped above.
          if (statement.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) continue;
          this.database.exec(statement);
        }
        this.database
          .query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, nowIso());
      })();
    }
  }

  close(): void {
    this.database.close();
  }

  tryClaim(input: ClaimInput): boolean {
    const result = this.database
      .query(
        `INSERT OR IGNORE INTO claims(issue_id, identifier, state, run_id, claimed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.issueId, input.identifier, input.state, input.runId ?? null, nowIso());
    return result.changes > 0;
  }

  releaseClaim(issueId: string): void {
    this.database.query("DELETE FROM claims WHERE issue_id = ?").run(issueId);
  }

  listDueRetries(nowMs = Date.now()): readonly StoredRetryEntry[] {
    const rows = this.database
      .query("SELECT issue_id, identifier, attempt, due_at_ms, error FROM retry_queue WHERE due_at_ms <= ? ORDER BY due_at_ms ASC")
      .all(nowMs) as RetryRow[];
    return rows.map((row) => ({ issueId: row.issue_id, identifier: row.identifier, attempt: row.attempt, dueAtMs: row.due_at_ms, error: row.error }));
  }

  clearRetry(issueId: string): void {
    this.database.query("DELETE FROM retry_queue WHERE issue_id = ?").run(issueId);
  }

  requeueRetry(input: { readonly issueId: string; readonly identifier: string; readonly attempt: number; readonly dueAtMs: number; readonly error?: string | null }): void {
    this.database
      .query(
        `INSERT INTO retry_queue(issue_id, identifier, attempt, due_at_ms, error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           identifier = excluded.identifier,
           attempt = excluded.attempt,
           due_at_ms = excluded.due_at_ms,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run(input.issueId, input.identifier, input.attempt, input.dueAtMs, input.error ?? null, nowIso());
  }

  createRun(input: CreateRunInput): StoredRun {
    const runId = input.runId ?? randomUUID();
    const startedAt = input.startedAt ?? nowIso();
    const status = input.status ?? "created";

    this.database
      .query(
        `INSERT INTO runs(run_id, issue_id, identifier, workspace_path, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, input.issueId, input.identifier, input.workspacePath ?? null, status, startedAt);

    return {
      runId,
      issueId: input.issueId,
      identifier: input.identifier,
      workspacePath: input.workspacePath ?? null,
      status,
      startedAt,
      finishedAt: null,
      lastError: null,
    };
  }

  updateRunStatus(runId: string, status: RunAttemptStatus, error?: string | null): StoredRun | null {
    const finishedAt = ["succeeded", "failed", "cancelled", "timed_out"].includes(status) ? nowIso() : null;
    this.database
      .query("UPDATE runs SET status = ?, finished_at = COALESCE(?, finished_at), last_error = ? WHERE run_id = ?")
      .run(status, finishedAt, error ?? null, runId);
    return this.getRun(runId);
  }

  getRun(runId: string): StoredRun | null {
    const row = this.database.query("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | null;
    return row ? mapRun(row) : null;
  }

  listRuns(limit = 100): readonly StoredRun[] {
    const rows = this.database.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as RunRow[];
    return rows.map(mapRun);
  }

  appendEvent(input: AppendEventInput): StoredEvent {
    const createdAt = input.createdAt ?? nowIso();
    const level = input.level ?? "info";
    const result = this.database
      .query(
        `INSERT INTO events(run_id, attempt_id, issue_id, identifier, level, type, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId ?? null,
        input.attemptId ?? null,
        input.issueId ?? null,
        input.identifier ?? null,
        level,
        input.type,
        input.message,
        jsonStringify(input.payload),
        createdAt,
      );

    return {
      id: Number(result.lastInsertRowid),
      runId: input.runId ?? null,
      attemptId: input.attemptId ?? null,
      issueId: input.issueId ?? null,
      identifier: input.identifier ?? null,
      level,
      type: input.type,
      message: input.message,
      payload: input.payload ?? {},
      createdAt,
    };
  }

  listEvents(filter: { readonly runId?: string; readonly issueId?: string; readonly limit?: number } = {}): readonly StoredEvent[] {
    const limit = filter.limit ?? 100;
    let rows: EventRow[];

    if (filter.runId) {
      rows = this.database
        .query("SELECT * FROM events WHERE run_id = ? ORDER BY id ASC LIMIT ?")
        .all(filter.runId, limit) as EventRow[];
    } else if (filter.issueId) {
      rows = this.database
        .query("SELECT * FROM events WHERE issue_id = ? ORDER BY id ASC LIMIT ?")
        .all(filter.issueId, limit) as EventRow[];
    } else {
      rows = this.database.query("SELECT * FROM events ORDER BY id ASC LIMIT ?").all(limit) as EventRow[];
    }

    return rows.map(mapEvent);
  }

  recordTokenUsage(input: { readonly runId: string; readonly sessionId?: string | null; readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number; readonly costUsd?: number | null }): void {
    this.database
      .query(
        `INSERT INTO token_usage(run_id, session_id, input_tokens, output_tokens, total_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.runId, input.sessionId ?? null, input.inputTokens, input.outputTokens, input.totalTokens, input.costUsd ?? null, nowIso());
  }

  recordEvidence(input: EvidenceRecordInput): StoredEvidenceRecord {
    const createdAt = input.createdAt ?? nowIso();
    this.database
      .query(
        `INSERT INTO evidence_artifacts(artifact_id, run_id, issue_id, kind, uri, label, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.artifactId,
        input.runId,
        input.issueId ?? null,
        input.kind,
        input.uri,
        input.label,
        jsonStringify(input.metadata),
        createdAt,
      );
    return {
      artifactId: input.artifactId,
      runId: input.runId,
      issueId: input.issueId ?? null,
      kind: input.kind,
      uri: input.uri,
      label: input.label,
      metadata: input.metadata ?? {},
      createdAt,
    };
  }

  listEvidence(runId: string): readonly StoredEvidenceRecord[] {
    const rows = this.database
      .query("SELECT * FROM evidence_artifacts WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as EvidenceRow[];
    return rows.map(mapEvidence);
  }

  getEvidence(artifactId: string): StoredEvidenceRecord | null {
    const row = this.database.query("SELECT * FROM evidence_artifacts WHERE artifact_id = ?").get(artifactId) as EvidenceRow | null;
    return row ? mapEvidence(row) : null;
  }

  claimAndCreateRun(claimInput: ClaimInput, runInput: CreateRunInput): { claimed: boolean; run: StoredRun | undefined } {
    // Wrap tryClaim + createRun in a single transaction so a createRun failure
    // cannot leave an orphan claim row with no matching run.
    // Run is inserted BEFORE the claim because claims.run_id has a FK to runs(run_id).
    let claimed = false;
    let run: StoredRun | undefined;

    this.database.transaction(() => {
      // Check for an existing claim without inserting yet.
      const existing = this.database
        .query("SELECT 1 FROM claims WHERE issue_id = ?")
        .get(claimInput.issueId);
      if (existing !== null) return; // already claimed

      const runId = runInput.runId ?? randomUUID();
      const startedAt = runInput.startedAt ?? nowIso();
      const status = runInput.status ?? "created";

      // Insert run first so claims FK is satisfiable.
      this.database
        .query(
          `INSERT INTO runs(run_id, issue_id, identifier, workspace_path, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, runInput.issueId, runInput.identifier, runInput.workspacePath ?? null, status, startedAt);

      // Insert claim referencing the now-existing run.
      this.database
        .query(
          `INSERT INTO claims(issue_id, identifier, state, run_id, claimed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(claimInput.issueId, claimInput.identifier, claimInput.state, runId, nowIso());

      claimed = true;
      run = {
        runId,
        issueId: runInput.issueId,
        identifier: runInput.identifier,
        workspacePath: runInput.workspacePath ?? null,
        status,
        startedAt,
        finishedAt: null,
        lastError: null,
      };
    })();

    return { claimed, run };
  }

  upsertIssueSeen(input: UpsertIssueSeenInput): void {
    this.database
      .query(
        `INSERT INTO issues_seen(issue_id, identifier, title, state, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           identifier = excluded.identifier,
           title = excluded.title,
           state = excluded.state,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(input.issueId, input.identifier, input.title, input.state, jsonStringify(input.payload), nowIso());
  }

  recordRunAttempt(input: RecordRunAttemptInput): StoredRunAttempt {
    const attemptId = input.attemptId ?? randomUUID();
    const startedAt = input.startedAt ?? nowIso();
    this.database
      .query(
        `INSERT INTO run_attempts(attempt_id, run_id, attempt, status, started_at, finished_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(attemptId, input.runId, input.attempt, input.status, startedAt, input.finishedAt ?? null, input.error ?? null);
    return {
      attemptId,
      runId: input.runId,
      attempt: input.attempt,
      status: input.status,
      startedAt,
      finishedAt: input.finishedAt ?? null,
      error: input.error ?? null,
    };
  }

  recordRunnerSession(input: RecordRunnerSessionInput): StoredRunnerSession {
    const sessionId = input.sessionId ?? randomUUID();
    const startedAt = nowIso();
    this.database
      .query(
        `INSERT INTO runner_sessions(session_id, run_id, attempt_id, runner_kind, thread_id, turn_id, pid, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, input.runId, input.attemptId ?? null, input.runnerKind, input.threadId ?? null, input.turnId ?? null, input.pid ?? null, startedAt);
    return {
      sessionId,
      runId: input.runId,
      attemptId: input.attemptId ?? null,
      runnerKind: input.runnerKind,
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      pid: input.pid ?? null,
      startedAt,
      lastEventAt: null,
    };
  }

  recordControlAction(input: RecordControlActionInput): string {
    const actionId = input.actionId ?? randomUUID();
    this.database
      .query(
        `INSERT INTO control_actions(action_id, action, issue_id, run_id, status, requested_by, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(actionId, input.action, input.issueId ?? null, input.runId ?? null, input.status, input.requestedBy ?? null, jsonStringify(input.payload), nowIso());
    return actionId;
  }

  markInterruptedRuns(reason = "process restarted before completion"): number {
    const interrupted = this.database
      .query("SELECT run_id FROM runs WHERE status IN ('running', 'workspace_ready')")
      .all() as Array<{ run_id: string }>;
    if (interrupted.length === 0) return 0;

    const mark = this.database.transaction(() => {
      let changed = 0;
      for (const row of interrupted) {
        const result = this.database
          .query("UPDATE runs SET status = 'failed', finished_at = ?, last_error = ? WHERE run_id = ?")
          .run(nowIso(), reason, row.run_id);
        this.database.query("DELETE FROM claims WHERE run_id = ?").run(row.run_id);
        changed += result.changes;
      }
      return changed;
    });
    return mark();
  }
}

export function openSymphonyDatabase(options: OpenSymphonyDatabaseOptions = {}): SymphonyDatabase {
  const database = new Database(options.path ?? ":memory:", {
    readonly: options.readonly ?? false,
    create: !(options.readonly ?? false),
  });
  const symphonyDb = new SymphonyDatabase(database);
  if (!(options.readonly ?? false)) {
    symphonyDb.migrate();
  }
  return symphonyDb;
}
