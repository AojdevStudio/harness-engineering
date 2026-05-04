import { describe, expect, test } from "bun:test";
import { openSymphonyDatabase } from "../src/index.ts";

describe("SymphonyDatabase", () => {
  test("migrates schema and appends/query events", () => {
    const db = openSymphonyDatabase();
    try {
      const run = db.createRun({ issueId: "issue-1", identifier: "ABC-1", workspacePath: "/tmp/ws/ABC-1" });
      const event = db.appendEvent({
        runId: run.runId,
        issueId: "issue-1",
        identifier: "ABC-1",
        type: "run.created",
        message: "Run created",
        payload: { workspace: "/tmp/ws/ABC-1" },
      });

      expect(event.id).toBeGreaterThan(0);
      expect(event.payload).toEqual({ workspace: "/tmp/ws/ABC-1" });

      const events = db.listEvents({ runId: run.runId });
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("run.created");
      expect(events[0]?.payload).toEqual({ workspace: "/tmp/ws/ABC-1" });
    } finally {
      db.close();
    }
  });

  test("updates terminal run status with finished timestamp", () => {
    const db = openSymphonyDatabase();
    try {
      const run = db.createRun({ runId: "run-1", issueId: "issue-1", identifier: "ABC-1" });
      expect(run.status).toBe("created");

      const updated = db.updateRunStatus("run-1", "succeeded");
      expect(updated?.status).toBe("succeeded");
      expect(updated?.finishedAt).toBeString();
      expect(updated?.lastError).toBeNull();
    } finally {
      db.close();
    }
  });

  test("parseJson surfaces __jsonParseError for malformed JSON", () => {
    const db = openSymphonyDatabase();
    try {
      const run = db.createRun({ issueId: "issue-1", identifier: "ABC-1" });
      // Directly corrupt a payload_json by inserting a raw event row.
      db.database.exec(
        `INSERT INTO events(run_id, issue_id, identifier, level, type, message, payload_json, created_at)
         VALUES ('${run.runId}', 'issue-1', 'ABC-1', 'info', 'corrupt.event', 'bad payload', 'NOT_JSON{{{', datetime('now'))`,
      );
      const events = db.listEvents({ runId: run.runId });
      const corrupt = events.find((e) => e.type === "corrupt.event");
      expect(corrupt).toBeDefined();
      expect(typeof corrupt!.payload).toBe("object");
      const p = corrupt!.payload as Record<string, unknown>;
      expect(p.__jsonParseError).toBeString();
      expect(p.raw).toBe("NOT_JSON{{{");
    } finally {
      db.close();
    }
  });

  test("claimAndCreateRun atomically creates claim + run", () => {
    const db = openSymphonyDatabase();
    try {
      const runId = "run-atomic-1";
      const { claimed, run } = db.claimAndCreateRun(
        { issueId: "issue-1", identifier: "ABC-1", state: "Todo", runId },
        { runId, issueId: "issue-1", identifier: "ABC-1", status: "running" },
      );

      expect(claimed).toBe(true);
      expect(run).toBeDefined();
      expect(run!.runId).toBe(runId);
      expect(run!.status).toBe("running");

      // Second call with same issue should not claim.
      const { claimed: secondClaim } = db.claimAndCreateRun(
        { issueId: "issue-1", identifier: "ABC-1", state: "Todo", runId: "run-atomic-2" },
        { runId: "run-atomic-2", issueId: "issue-1", identifier: "ABC-1", status: "running" },
      );
      expect(secondClaim).toBe(false);
      // No orphan run should exist for the second runId.
      expect(db.getRun("run-atomic-2")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("claimAndCreateRun leaves no orphan claim when run creation would fail", () => {
    // Simulate createRun failure by using an invalid runId that triggers a duplicate.
    const db = openSymphonyDatabase();
    try {
      const runId = "run-dup-1";
      // Pre-insert a run with the same runId to force a PK conflict.
      db.createRun({ runId, issueId: "issue-2", identifier: "ABC-2" });

      // Now attempt claimAndCreateRun — the run INSERT will fail (duplicate PK).
      let threw = false;
      try {
        db.claimAndCreateRun(
          { issueId: "issue-3", identifier: "ABC-3", state: "Todo", runId },
          { runId, issueId: "issue-3", identifier: "ABC-3", status: "running" },
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // Transaction rolled back — no claim row for issue-3 should exist.
      const claims = db.database.query("SELECT * FROM claims WHERE issue_id = ?").all("issue-3") as unknown[];
      expect(claims).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("upsertIssueSeen persists and updates issue records", () => {
    const db = openSymphonyDatabase();
    try {
      db.upsertIssueSeen({ issueId: "issue-1", identifier: "ABC-1", title: "Do work", state: "Todo" });
      const rows = db.database.query("SELECT * FROM issues_seen WHERE issue_id = ?").all("issue-1") as Array<{ state: string; title: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("Todo");

      // Upsert again with new state.
      db.upsertIssueSeen({ issueId: "issue-1", identifier: "ABC-1", title: "Do work", state: "In Progress" });
      const updated = db.database.query("SELECT * FROM issues_seen WHERE issue_id = ?").all("issue-1") as Array<{ state: string }>;
      expect(updated).toHaveLength(1);
      expect(updated[0]!.state).toBe("In Progress");
    } finally {
      db.close();
    }
  });

  test("recordRunAttempt inserts into run_attempts", () => {
    const db = openSymphonyDatabase();
    try {
      const run = db.createRun({ runId: "run-1", issueId: "issue-1", identifier: "ABC-1" });
      const attempt = db.recordRunAttempt({ runId: run.runId, attempt: 1, status: "running" });

      expect(attempt.attemptId).toBeString();
      expect(attempt.runId).toBe(run.runId);
      expect(attempt.attempt).toBe(1);
      expect(attempt.status).toBe("running");

      const rows = db.database.query("SELECT * FROM run_attempts WHERE run_id = ?").all(run.runId) as unknown[];
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("recordRunnerSession inserts into runner_sessions", () => {
    const db = openSymphonyDatabase();
    try {
      const run = db.createRun({ runId: "run-1", issueId: "issue-1", identifier: "ABC-1" });
      const session = db.recordRunnerSession({ runId: run.runId, runnerKind: "codex" });

      expect(session.sessionId).toBeString();
      expect(session.runId).toBe(run.runId);
      expect(session.runnerKind).toBe("codex");

      const rows = db.database.query("SELECT * FROM runner_sessions WHERE run_id = ?").all(run.runId) as unknown[];
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("recordControlAction inserts into control_actions", () => {
    const db = openSymphonyDatabase();
    try {
      const actionId = db.recordControlAction({ action: "pause", status: "requested", payload: { source: "api" } });

      expect(actionId).toBeString();
      const rows = db.database.query("SELECT * FROM control_actions WHERE action_id = ?").all(actionId) as Array<{ action: string; status: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("pause");
      expect(rows[0]!.status).toBe("requested");
    } finally {
      db.close();
    }
  });

  test("migration runner applies each version exactly once", () => {
    const db = openSymphonyDatabase();
    try {
      // Calling migrate() a second time should be a no-op (idempotent).
      db.migrate();

      const versions = db.database
        .query("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all() as Array<{ version: number }>;
      // Exactly one migration row (version 1).
      expect(versions).toHaveLength(1);
      expect(versions[0]!.version).toBe(1);
    } finally {
      db.close();
    }
  });
});
