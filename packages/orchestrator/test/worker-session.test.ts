import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedIssue, WorkspaceRef } from "@symphony/core";
import { openSymphonyDatabase } from "@symphony/db";
import { EvidenceStore } from "@symphony/evidence";
import type { RunnerResult } from "@symphony/runner";
import { runWorkerSession, type WorkerSessionWorkspaceManager } from "../src/worker-session.ts";

const issue: NormalizedIssue = {
  id: "issue-1",
  identifier: "ABC-1",
  title: "Do work",
  description: null,
  priority: null,
  state: "Todo",
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
};

const states = {
  inProgress: "In Progress",
  humanReview: "Human Review",
  rework: "Rework",
};

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    startedAt: "2026-05-09T00:00:00.000Z",
    finishedAt: "2026-05-09T00:00:01.000Z",
    ...overrides,
  };
}

describe("runWorkerSession", () => {
  test("owns claim, attempt, workspace-ready, runner evidence, and success transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-worker-session-success-"));
    const db = openSymphonyDatabase();
    const trackerWrites: string[] = [];
    const runningIssueIds = new Set<string>();

    try {
      const result = await runWorkerSession({
        issue,
        attempt: null,
        runId: "run-success",
        branchName: "symphony/ABC-1",
        states,
        db,
        tracker: {
          updateIssueState: async (_issueId, stateName) => {
            trackerWrites.push(stateName);
          },
        },
        workspaceManager: noOpWorkspaceManager(),
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceRoot: join(root, "workspaces"),
        runningIssueIds,
        maxRetryBackoffMs: 1,
        execute: async (session) => {
          expect(session.attemptNumber).toBe(1);
          expect(runningIssueIds.has(issue.id)).toBe(true);
          session.workspaceReady(workspaceRef(join(root, "workspaces", "ABC-1")));
          await session.appendRunnerEvent({ type: "runner.started", message: "started", timestamp: "2026-05-09T00:00:00.000Z" });
          await session.recordRunnerResult(runnerResult({
            stdout: "runner output",
            tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }));
          return { status: "succeeded" };
        },
      });

      expect(result).toBe("run-success");
      expect(runningIssueIds.has(issue.id)).toBe(false);
      expect(trackerWrites).toEqual(["In Progress", "Human Review"]);
      expect(db.getRun("run-success")?.status).toBe("succeeded");
      expect(db.listEvidence("run-success").map((artifact) => artifact.label)).toEqual(["Runner stdout"]);
      expect(db.listEvents({ runId: "run-success" }).map((event) => event.type)).toEqual([
        "run.claimed",
        "workspace.ready",
        "runner.started",
        "run.succeeded",
      ]);
      expect(db.tryClaim({ issueId: issue.id, identifier: issue.identifier, state: issue.state })).toBe(true);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("centralizes failed-session cleanup, retry requeue, evidence, and claim release", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-worker-session-failed-"));
    const db = openSymphonyDatabase();
    const trackerWrites: string[] = [];
    const removals: Array<{ readonly workspaceRoot: string; readonly workspacePath: string; readonly sourceRepoPath?: string; readonly branchName?: string }> = [];
    const runningIssueIds = new Set<string>();

    try {
      const workspaceRoot = join(root, "workspaces");
      const workspacePath = join(workspaceRoot, "ABC-1");
      const result = await runWorkerSession({
        issue,
        attempt: 2,
        runId: "run-failed",
        branchName: "symphony/ABC-1",
        states,
        db,
        tracker: {
          updateIssueState: async (_issueId, stateName) => {
            trackerWrites.push(stateName);
          },
        },
        workspaceManager: {
          remove: async (rootPath, path, options) => {
            removals.push({ workspaceRoot: rootPath, workspacePath: path, ...options });
          },
        },
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceRoot,
        sourceRepoPath: "/repo/source",
        runningIssueIds,
        maxRetryBackoffMs: 1,
        execute: async (session) => {
          expect(session.attemptNumber).toBe(3);
          session.workspaceReady(workspaceRef(workspacePath));
          await session.recordRunnerResult(runnerResult({ ok: false, exitCode: 1, stderr: "runner failed", error: "runner exited 1" }));
          return { status: "failed", error: "runner exited 1" };
        },
      });

      expect(result).toBe("run-failed");
      expect(runningIssueIds.has(issue.id)).toBe(false);
      expect(trackerWrites).toEqual(["In Progress", "Rework"]);
      expect(db.getRun("run-failed")).toMatchObject({ status: "failed", lastError: "runner exited 1" });
      expect(db.listEvidence("run-failed").map((artifact) => artifact.label)).toEqual(["Runner stderr"]);
      expect(removals).toEqual([{ workspaceRoot, workspacePath, sourceRepoPath: "/repo/source", branchName: "symphony/ABC-1" }]);
      expect(db.listDueRetries(Number.MAX_SAFE_INTEGER)).toEqual([
        expect.objectContaining({ issueId: issue.id, identifier: issue.identifier, attempt: 3, error: "runner exited 1" }),
      ]);
      expect(db.listEvents({ runId: "run-failed" }).map((event) => event.type)).toContain("run.failed");
      expect(db.tryClaim({ issueId: issue.id, identifier: issue.identifier, state: issue.state })).toBe(true);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips execution when the issue is already claimed", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-worker-session-claimed-"));
    const db = openSymphonyDatabase();
    const runningIssueIds = new Set<string>();
    let executed = false;

    try {
      db.claimAndCreateRun(
        { issueId: issue.id, identifier: issue.identifier, state: issue.state, runId: "existing-run" },
        { runId: "existing-run", issueId: issue.id, identifier: issue.identifier, status: "running" },
      );

      const result = await runWorkerSession({
        issue,
        attempt: null,
        runId: "run-skipped",
        branchName: "symphony/ABC-1",
        states,
        db,
        tracker: {},
        workspaceManager: noOpWorkspaceManager(),
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceRoot: join(root, "workspaces"),
        runningIssueIds,
        maxRetryBackoffMs: 1,
        execute: async () => {
          executed = true;
          return { status: "succeeded" };
        },
      });

      expect(result).toBe("run-skipped");
      expect(executed).toBe(false);
      expect(runningIssueIds.size).toBe(0);
      expect(db.getRun("run-skipped")).toBeNull();
      expect(db.listEvents().map((event) => event.type)).toContain("run.claim_skipped");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function workspaceRef(path: string): WorkspaceRef {
  return { path, workspaceKey: "ABC-1", createdNow: true };
}

function noOpWorkspaceManager(): WorkerSessionWorkspaceManager {
  return {
    remove: async () => {},
  };
}
