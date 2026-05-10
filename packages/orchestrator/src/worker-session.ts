import type { NormalizedIssue, WorkspaceRef } from "@symphony/core";
import type { SymphonyDatabase } from "@symphony/db";
import type { EvidenceStore } from "@symphony/evidence";
import type { RunnerEvent, RunnerResult } from "@symphony/runner";
import { writeBestEffortIssueState, writeRequiredIssueState } from "./tracker-writes.ts";

export interface WorkerSessionStates {
  readonly inProgress: string;
  readonly humanReview: string;
  readonly rework: string;
}

export interface WorkerSessionTracker {
  updateIssueState?(issueId: string, stateName: string): Promise<void>;
}

export interface WorkerSessionWorkspaceManager {
  remove(workspaceRoot: string, workspacePath: string, options?: { readonly sourceRepoPath?: string; readonly branchName?: string }): Promise<void>;
}

export type WorkerSessionExecutionResult =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: string };

export interface WorkerSession {
  readonly runId: string;
  readonly issue: NormalizedIssue;
  readonly attemptNumber: number;
  readonly branchName: string;
  workspaceReady(workspace: WorkspaceRef): void;
  appendRunnerEvent(event: RunnerEvent): Promise<void>;
  recordRunnerResult(result: RunnerResult): Promise<void>;
}

export interface RunWorkerSessionInput {
  readonly issue: NormalizedIssue;
  readonly attempt: number | null;
  readonly runId: string;
  readonly branchName: string;
  readonly states: WorkerSessionStates;
  readonly db: SymphonyDatabase;
  readonly tracker: WorkerSessionTracker;
  readonly workspaceManager: WorkerSessionWorkspaceManager;
  readonly evidenceStore: EvidenceStore;
  readonly workspaceRoot: string;
  readonly sourceRepoPath?: string;
  readonly runningIssueIds: Set<string>;
  readonly maxRetryBackoffMs: number;
  readonly execute: (session: WorkerSession) => Promise<WorkerSessionExecutionResult>;
}

export async function runWorkerSession(input: RunWorkerSessionInput): Promise<string> {
  const { issue, runId } = input;
  const attemptNumber = (input.attempt ?? 0) + 1;
  const { claimed, run } = input.db.claimAndCreateRun(
    { issueId: issue.id, identifier: issue.identifier, state: issue.state, runId },
    { runId, issueId: issue.id, identifier: issue.identifier, status: "running" },
  );

  if (!claimed) {
    input.db.appendEvent({ issueId: issue.id, identifier: issue.identifier, type: "run.claim_skipped", message: `Issue ${issue.identifier} is already claimed` });
    return runId;
  }

  input.runningIssueIds.add(issue.id);
  const session = new DefaultWorkerSession({ ...input, attemptNumber });
  let failureTerminalizationStarted = false;

  try {
    input.db.recordRunAttempt({ runId: run!.runId, attempt: attemptNumber, status: "running" });
    input.db.appendEvent({ runId: run!.runId, issueId: issue.id, identifier: issue.identifier, type: "run.claimed", message: `Claimed ${issue.identifier}` });
    await writeRequiredIssueState({
      tracker: input.tracker,
      issue,
      stateName: input.states.inProgress,
      runId: run!.runId,
      appendEvent: (event) => {
        input.db.appendEvent(event);
      },
    });

    const result = await input.execute(session);
    if (result.status === "failed") {
      failureTerminalizationStarted = true;
      await session.fail(result.error);
      return runId;
    }

    await session.succeed();
    return runId;
  } catch (error) {
    if (failureTerminalizationStarted) throw error;
    await session.fail(error instanceof Error ? error.message : String(error));
    return runId;
  } finally {
    input.runningIssueIds.delete(issue.id);
    input.db.releaseClaim(issue.id);
  }
}

class DefaultWorkerSession implements WorkerSession {
  readonly runId: string;
  readonly issue: NormalizedIssue;
  readonly attemptNumber: number;
  readonly branchName: string;
  private workspacePath: string | null = null;

  constructor(private readonly input: RunWorkerSessionInput & { readonly attemptNumber: number }) {
    this.runId = input.runId;
    this.issue = input.issue;
    this.attemptNumber = input.attemptNumber;
    this.branchName = input.branchName;
  }

  workspaceReady(workspace: WorkspaceRef): void {
    this.workspacePath = workspace.path;
    this.input.db.updateRunStatus(this.runId, "workspace_ready");
    this.input.db.appendEvent({
      runId: this.runId,
      issueId: this.issue.id,
      identifier: this.issue.identifier,
      type: "workspace.ready",
      message: workspace.path,
      payload: workspace,
    });
  }

  async appendRunnerEvent(event: RunnerEvent): Promise<void> {
    this.input.db.appendEvent({
      runId: this.runId,
      issueId: this.issue.id,
      identifier: this.issue.identifier,
      level: event.type.includes("failed") ? "error" : "info",
      type: event.type,
      message: event.message,
      payload: event.payload ?? { stream: event.stream },
      createdAt: event.timestamp,
    });
  }

  async recordRunnerResult(result: RunnerResult): Promise<void> {
    await this.writeRunnerEvidence(result);
    if (result.tokenUsage) {
      this.input.db.recordTokenUsage({
        runId: this.runId,
        inputTokens: result.tokenUsage.inputTokens,
        outputTokens: result.tokenUsage.outputTokens,
        totalTokens: result.tokenUsage.totalTokens,
      });
    }
  }

  async fail(error: string): Promise<void> {
    await this.safeUpdateIssueState(this.input.states.rework);
    await this.cleanupFailedWorkspace();
    this.input.db.updateRunStatus(this.runId, "failed", error);
    this.input.db.requeueRetry({
      issueId: this.issue.id,
      identifier: this.issue.identifier,
      attempt: this.attemptNumber,
      dueAtMs: Date.now() + retryDelayMs(this.attemptNumber, this.input.maxRetryBackoffMs),
      error,
    });
    this.input.db.appendEvent({ level: "error", runId: this.runId, issueId: this.issue.id, identifier: this.issue.identifier, type: "run.failed", message: error });
  }

  async succeed(): Promise<void> {
    await writeRequiredIssueState({
      tracker: this.input.tracker,
      issue: this.issue,
      stateName: this.input.states.humanReview,
      runId: this.runId,
      appendEvent: (event) => {
        this.input.db.appendEvent(event);
      },
    });
    this.input.db.updateRunStatus(this.runId, "succeeded");
    this.input.db.appendEvent({ runId: this.runId, issueId: this.issue.id, identifier: this.issue.identifier, type: "run.succeeded", message: `Run ${this.runId} succeeded` });
  }

  private async safeUpdateIssueState(stateName: string): Promise<void> {
    await writeBestEffortIssueState({
      tracker: this.input.tracker,
      issue: this.issue,
      stateName,
      appendEvent: (event) => {
        this.input.db.appendEvent(event);
      },
    });
  }

  private async cleanupFailedWorkspace(): Promise<void> {
    if (!this.workspacePath) return;
    try {
      await this.input.workspaceManager.remove(this.input.workspaceRoot, this.workspacePath, {
        ...(this.input.sourceRepoPath ? { sourceRepoPath: this.input.sourceRepoPath, branchName: this.branchName } : {}),
      });
      this.input.db.appendEvent({ level: "warn", type: "workspace.cleaned_after_failure", message: this.workspacePath });
    } catch (error) {
      this.input.db.appendEvent({ level: "error", type: "workspace.cleanup_failed", message: error instanceof Error ? error.message : String(error), payload: { workspacePath: this.workspacePath } });
    }
  }

  private async writeRunnerEvidence(result: RunnerResult): Promise<void> {
    if (result.stdout.trim()) {
      const artifact = await this.input.evidenceStore.writeTextArtifact({
        runId: this.runId,
        issueId: this.issue.id,
        kind: "log",
        label: "Runner stdout",
        filename: "runner-stdout.log",
        content: result.stdout,
      });
      this.input.db.recordEvidence(artifact);
    }
    if (result.stderr.trim()) {
      const artifact = await this.input.evidenceStore.writeTextArtifact({
        runId: this.runId,
        issueId: this.issue.id,
        kind: "log",
        label: "Runner stderr",
        filename: "runner-stderr.log",
        content: result.stderr,
      });
      this.input.db.recordEvidence(artifact);
    }
  }
}

function retryDelayMs(attempt: number, maxRetryBackoffMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), maxRetryBackoffMs);
}
