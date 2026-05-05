import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { Dirent } from "node:fs";
import type { NormalizedIssue } from "@symphony/core";
import { isActiveState, isTerminalState } from "@symphony/core";
import type { SymphonyDatabase } from "@symphony/db";
import type { EvidenceStore } from "@symphony/evidence";
import type { AgentRunner, RunnerResult } from "@symphony/runner";
import { renderWorkflowPrompt, validateDispatchConfig, type ResolvedWorkflowConfig, type WorkflowDefinition } from "@symphony/workflow";
import { workspacePathFor, type GitWorkspaceManager, type WorkspaceMode } from "@symphony/workspace-git";

export interface TrackerAdapter {
  fetchCandidateIssues(): Promise<readonly NormalizedIssue[]>;
  fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly NormalizedIssue[]>;
  fetchIssueStatesByIds(issueIds: readonly string[]): Promise<readonly NormalizedIssue[]>;
  updateIssueState?(issueId: string, stateName: string): Promise<void>;
  createOrUpdateWorkpad?(issueId: string, body: string): Promise<void>;
}

export type PullRequestReviewSeverity = "P0" | "P1" | "P2" | "P3";
export type PullRequestCheckStatus = "passing" | "failing" | "pending" | "unknown";

export interface PullRequestReviewFinding {
  readonly severity: PullRequestReviewSeverity;
  readonly message: string;
  readonly source?: string;
  readonly url?: string;
}

export interface PullRequestInspection {
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED" | string;
  readonly reviewDecision?: string | null;
  readonly checksStatus: PullRequestCheckStatus;
  readonly mergeable: boolean;
  readonly isDraft?: boolean;
  readonly findings: readonly PullRequestReviewFinding[];
}

export interface PullRequestManager {
  ensureBranch?(input: { readonly workspacePath: string; readonly branchName: string }): Promise<void>;
  pushBranch?(input: { readonly workspacePath: string; readonly branchName: string }): Promise<void>;
  ensurePullRequest?(input: { readonly workspacePath: string; readonly branchName: string; readonly title: string; readonly body: string }): Promise<string | null>;
  inspectPullRequest?(input: { readonly workspacePath: string; readonly branchName: string }): Promise<PullRequestInspection | null>;
  mergePullRequest?(input: { readonly workspacePath: string; readonly branchName: string }): Promise<string | null>;
}

export interface OrchestratorOptions {
  readonly workflow: WorkflowDefinition;
  readonly config: ResolvedWorkflowConfig;
  readonly tracker: TrackerAdapter;
  readonly workspaceManager: GitWorkspaceManager;
  readonly runner: AgentRunner;
  readonly db: SymphonyDatabase;
  readonly evidenceStore: EvidenceStore;
  readonly prManager?: PullRequestManager;
  readonly sourceRepoPath?: string;
  readonly repoUrl?: string;
  readonly workspaceMode?: WorkspaceMode;
  readonly baseRef?: string;
}

export interface DispatchResult {
  readonly dispatched: number;
  readonly runIds: readonly string[];
}

export interface TickOptions {
  readonly waitForCompletion?: boolean;
}

interface DispatchContext {
  readonly pullRequest?: PullRequestInspection;
  readonly reviewFindings?: readonly PullRequestReviewFinding[];
}

export class SymphonyOrchestrator {
  private readonly options: OrchestratorOptions;
  private readonly runningIssueIds = new Set<string>();
  private paused = false;

  constructor(options: OrchestratorOptions) {
    this.options = options;
    const errors = validateDispatchConfig(options.config);
    if (errors.length > 0) {
      throw new Error(`Invalid dispatch configuration:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    }
  }

  pause(): void {
    this.paused = true;
    this.options.db.appendEvent({ level: "warn", type: "orchestrator.paused", message: "Orchestrator paused" });
  }

  resume(): void {
    this.paused = false;
    this.options.db.appendEvent({ type: "orchestrator.resumed", message: "Orchestrator resumed" });
  }

  recoverInterruptedRuns(): number {
    return this.options.db.markInterruptedRuns();
  }

  async tick(options: TickOptions = {}): Promise<DispatchResult> {
    if (this.paused) {
      this.options.db.appendEvent({ type: "orchestrator.tick_skipped", message: "Tick skipped because orchestrator is paused" });
      return { dispatched: 0, runIds: [] };
    }

    const reviewResult = await this.reconcilePullRequests(options);
    if (reviewResult.dispatched > 0) return reviewResult;

    const issues = await this.options.tracker.fetchCandidateIssues();

    // Persist first-seen record for every candidate issue (observability).
    for (const issue of issues) {
      this.options.db.upsertIssueSeen({ issueId: issue.id, identifier: issue.identifier, title: issue.title, state: issue.state });
    }

    const dueRetryEntries = new Map(this.options.db.listDueRetries().map((entry) => [entry.issueId, entry]));
    const max = this.options.config.agent.maxConcurrentAgents;
    // Count already-in-flight runs against the cap so repeated ticks don't overflow.
    const available = max - this.runningIssueIds.size;
    if (available <= 0) return { dispatched: 0, runIds: [] };
    const selected: NormalizedIssue[] = [];

    for (const issue of sortIssues(issues)) {
      if (selected.length >= available) break;
      if (this.runningIssueIds.has(issue.id)) continue;
      if (this.isReviewLifecycleState(issue.state)) continue;
      if (!isActiveState(issue.state, this.options.config.tracker.activeStates)) continue;
      if (isTerminalState(issue.state, this.options.config.tracker.terminalStates)) continue;
      if (hasNonTerminalBlocker(issue, this.options.config.tracker.terminalStates)) continue;
      selected.push(issue);
      if (dueRetryEntries.has(issue.id)) this.options.db.clearRetry(issue.id);
    }

    const dispatches = selected.map((issue) => {
      const runId = newRunId();
      return { runId, promise: this.dispatchIssue(issue, dueRetryEntries.get(issue.id)?.attempt ?? null, runId) };
    });
    if (options.waitForCompletion) {
      const runIds = await Promise.all(dispatches.map((dispatch) => dispatch.promise));
      return { dispatched: runIds.length, runIds };
    }

    for (const dispatch of dispatches) {
      dispatch.promise.catch((error) => {
        this.options.db.appendEvent({ level: "error", type: "run.unhandled_failure", message: error instanceof Error ? error.message : String(error) });
      });
    }
    return { dispatched: dispatches.length, runIds: dispatches.map((dispatch) => dispatch.runId) };
  }

  private async reconcilePullRequests(options: TickOptions = {}): Promise<DispatchResult> {
    if (!this.options.prManager?.inspectPullRequest) return { dispatched: 0, runIds: [] };

    const states = this.options.config.states;
    const reviewStates = uniqueStrings([states.humanReview, states.merging]);
    const issues = await this.options.tracker.fetchIssuesByStates(reviewStates);

    for (const issue of issues) {
      this.options.db.upsertIssueSeen({ issueId: issue.id, identifier: issue.identifier, title: issue.title, state: issue.state });
    }

    const max = this.options.config.agent.maxConcurrentAgents;
    const available = max - this.runningIssueIds.size;
    if (available <= 0) return { dispatched: 0, runIds: [] };

    const dispatches: Array<{ readonly runId: string; readonly promise: Promise<string> }> = [];

    for (const issue of sortIssues(issues)) {
      if (dispatches.length >= available) break;
      if (this.runningIssueIds.has(issue.id)) continue;
      if (isTerminalState(issue.state, this.options.config.tracker.terminalStates)) continue;
      if (!this.isReviewLifecycleState(issue.state)) continue;

      const branchName = issue.branchName ?? `symphony/${issue.identifier}`;
      const workspacePath = workspacePathFor(this.options.config.workspace.root, issue.identifier).path;
      let inspection: PullRequestInspection | null;

      try {
        inspection = await this.options.prManager.inspectPullRequest({ workspacePath, branchName });
      } catch (error) {
        this.options.db.appendEvent({
          level: "error",
          issueId: issue.id,
          identifier: issue.identifier,
          type: "pr.inspect_failed",
          message: error instanceof Error ? error.message : String(error),
          payload: { branchName },
        });
        continue;
      }

      if (!inspection) {
        this.options.db.appendEvent({ issueId: issue.id, identifier: issue.identifier, type: "pr.not_found", message: `No PR found for ${branchName}`, payload: { branchName } });
        continue;
      }

      this.options.db.appendEvent({
        issueId: issue.id,
        identifier: issue.identifier,
        type: "pr.inspected",
        message: inspection.url,
        payload: summarizePrInspection(inspection),
      });

      if (inspection.state === "MERGED") {
        await this.safeUpdateIssueState(issue, states.done);
        this.options.db.appendEvent({ issueId: issue.id, identifier: issue.identifier, type: "pr.already_merged", message: inspection.url });
        continue;
      }

      const findings = blockingFindings(inspection);
      if (findings.length > 0) {
        await this.safeUpdateIssueState(issue, states.rework);
        const runId = newRunId();
        dispatches.push({
          runId,
          promise: this.dispatchIssue(issue, null, runId, { pullRequest: inspection, reviewFindings: findings }),
        });
        continue;
      }

      if (this.shouldMerge(issue, inspection)) {
        await this.mergePullRequest(issue, branchName, workspacePath, inspection);
        continue;
      }

      this.options.db.appendEvent({
        issueId: issue.id,
        identifier: issue.identifier,
        type: "pr.waiting",
        message: prWaitingReason(issue, inspection, states.merging),
        payload: summarizePrInspection(inspection),
      });
    }

    if (options.waitForCompletion) {
      const runIds = await Promise.all(dispatches.map((dispatch) => dispatch.promise));
      return { dispatched: runIds.length, runIds };
    }

    for (const dispatch of dispatches) {
      dispatch.promise.catch((error) => {
        this.options.db.appendEvent({ level: "error", type: "run.unhandled_failure", message: error instanceof Error ? error.message : String(error) });
      });
    }
    return { dispatched: dispatches.length, runIds: dispatches.map((dispatch) => dispatch.runId) };
  }

  async dispatchIssue(issue: NormalizedIssue, attempt: number | null = null, runId = newRunId(), context: DispatchContext = {}): Promise<string> {
    // claimAndCreateRun is a single SQLite transaction — prevents orphan claim rows
    // if createRun fails (e.g., FK violation or disk full).
    const { claimed, run: createdRun } = this.options.db.claimAndCreateRun(
      { issueId: issue.id, identifier: issue.identifier, state: issue.state, runId },
      { runId, issueId: issue.id, identifier: issue.identifier, status: "running" },
    );

    if (!claimed) {
      this.options.db.appendEvent({ issueId: issue.id, identifier: issue.identifier, type: "run.claim_skipped", message: `Issue ${issue.identifier} is already claimed` });
      return runId;
    }

    this.runningIssueIds.add(issue.id);
    const run = createdRun!;
    // Record the attempt for observability (run_attempts table).
    this.options.db.recordRunAttempt({ runId: run.runId, attempt: (attempt ?? 0) + 1, status: "running" });
    const branchName = issue.branchName ?? `symphony/${issue.identifier}`;
    const states = this.options.config.states;
    let workspacePath: string | null = null;

    try {
      this.options.db.appendEvent({ runId: run.runId, issueId: issue.id, identifier: issue.identifier, type: "run.claimed", message: `Claimed ${issue.identifier}` });
      await this.options.tracker.updateIssueState?.(issue.id, states.inProgress);

      const workspace = await this.options.workspaceManager.prepare({
        issueIdentifier: issue.identifier,
        workspaceRoot: this.options.config.workspace.root,
        mode: this.options.workspaceMode ?? "worktree",
        ...(this.options.sourceRepoPath ? { sourceRepoPath: this.options.sourceRepoPath } : {}),
        ...(this.options.repoUrl ? { repoUrl: this.options.repoUrl } : {}),
        branchName,
        ...(this.options.baseRef ? { baseRef: this.options.baseRef } : {}),
        ...(this.options.config.hooks.afterCreate ? { afterCreateHook: this.options.config.hooks.afterCreate } : {}),
        hookTimeoutMs: this.options.config.hooks.timeoutMs,
      });

      workspacePath = workspace.path;
      this.options.db.updateRunStatus(run.runId, "workspace_ready");
      this.options.db.appendEvent({ runId: run.runId, issueId: issue.id, identifier: issue.identifier, type: "workspace.ready", message: workspace.path, payload: workspace });

      if (this.options.config.hooks.beforeRun) {
        await this.options.workspaceManager.runHook(workspace.path, this.options.config.hooks.beforeRun, this.options.config.hooks.timeoutMs);
        this.options.db.appendEvent({ runId: run.runId, issueId: issue.id, identifier: issue.identifier, type: "hook.before_run", message: "before_run hook completed" });
      }

      const prompt = await renderWorkflowPrompt(this.options.workflow, { issue: issueToPrompt(issue), attempt });
      const runnerPrompt = context.reviewFindings?.length ? appendReviewFeedback(prompt, context.pullRequest, context.reviewFindings) : prompt;
      const result = await this.options.runner.run({
        workspacePath: workspace.path,
        prompt: runnerPrompt,
        issue,
        attempt,
        timeoutMs: this.options.config.codex.turnTimeoutMs,
        onEvent: (event) => {
          this.options.db.appendEvent({
            runId: run.runId,
            issueId: issue.id,
            identifier: issue.identifier,
            level: event.type.includes("failed") ? "error" : "info",
            type: event.type,
            message: event.message,
            payload: event.payload ?? { stream: event.stream },
            createdAt: event.timestamp,
          });
        },
      });

      await this.writeRunnerEvidence(run.runId, issue.id, result);
      if (result.tokenUsage) {
        this.options.db.recordTokenUsage({
          runId: run.runId,
          inputTokens: result.tokenUsage.inputTokens,
          outputTokens: result.tokenUsage.outputTokens,
          totalTokens: result.tokenUsage.totalTokens,
        });
      }

      if (!result.ok) {
        const error = result.error ?? `runner exited ${result.exitCode}`;
        await this.safeUpdateIssueState(issue, states.rework);
        await this.cleanupFailedWorkspace(workspacePath, branchName);
        this.options.db.updateRunStatus(run.runId, "failed", error);
        this.options.db.requeueRetry({ issueId: issue.id, identifier: issue.identifier, attempt: (attempt ?? 0) + 1, dueAtMs: Date.now() + retryDelayMs((attempt ?? 0) + 1, this.options.config.agent.maxRetryBackoffMs), error });
        this.options.db.appendEvent({ level: "error", runId: run.runId, issueId: issue.id, identifier: issue.identifier, type: "run.failed", message: error });
        return run.runId;
      }

      if (!this.options.config.hooks.afterRun) {
        throw new Error("hooks.after_run validation is required before Symphony can mark a run successful");
      }
      await this.options.workspaceManager.runHook(workspace.path, this.options.config.hooks.afterRun, this.options.config.hooks.timeoutMs);
      await this.captureRequiredEvidence(run.runId, issue, workspace.path);
      this.options.db.appendEvent({ runId: run.runId, issueId: issue.id, identifier: issue.identifier, type: "validation.passed", message: "after_run validation and required evidence completed" });

      await this.options.prManager?.ensureBranch?.({ workspacePath: workspace.path, branchName });
      await this.options.prManager?.pushBranch?.({ workspacePath: workspace.path, branchName });
      const prUrl = await this.options.prManager?.ensurePullRequest?.({
        workspacePath: workspace.path,
        branchName,
        title: `${issue.identifier}: ${issue.title}`,
        body: `Automated Symphony handoff for ${issue.identifier}.\n\nRun: ${run.runId}`,
      });

      if (prUrl) {
        this.options.db.appendEvent({ runId: run.runId, issueId: issue.id, identifier: issue.identifier, type: "pr.ready", message: prUrl });
      }

      await this.options.tracker.createOrUpdateWorkpad?.(issue.id, `## Symphony Workpad\n\nRun ${run.runId} completed.\n\n${prUrl ? `PR: ${prUrl}` : "PR: not created"}`);
      await this.options.tracker.updateIssueState?.(issue.id, states.humanReview);
      this.options.db.updateRunStatus(run.runId, "succeeded");
      this.options.db.appendEvent({ runId: run.runId, issueId: issue.id, identifier: issue.identifier, type: "run.succeeded", message: `Run ${run.runId} succeeded` });
      return run.runId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.safeUpdateIssueState(issue, states.rework);
      await this.cleanupFailedWorkspace(workspacePath, branchName);
      this.options.db.updateRunStatus(run.runId, "failed", message);
      this.options.db.requeueRetry({ issueId: issue.id, identifier: issue.identifier, attempt: (attempt ?? 0) + 1, dueAtMs: Date.now() + retryDelayMs((attempt ?? 0) + 1, this.options.config.agent.maxRetryBackoffMs), error: message });
      this.options.db.appendEvent({ level: "error", runId: run.runId, issueId: issue.id, identifier: issue.identifier, type: "run.failed", message });
      return run.runId;
    } finally {
      this.runningIssueIds.delete(issue.id);
      this.options.db.releaseClaim(issue.id);
    }
  }

  private shouldMerge(issue: NormalizedIssue, inspection: PullRequestInspection): boolean {
    if (!this.options.prManager?.mergePullRequest) return false;
    if (inspection.state !== "OPEN") return false;
    if (inspection.isDraft) return false;
    if (inspection.checksStatus !== "passing") return false;
    if (!inspection.mergeable) return false;
    if (sameState(issue.state, this.options.config.states.merging)) return true;
    return normalizeReviewDecision(inspection.reviewDecision) === "APPROVED";
  }

  private async mergePullRequest(issue: NormalizedIssue, branchName: string, workspacePath: string, inspection: PullRequestInspection): Promise<void> {
    const states = this.options.config.states;
    if (!sameState(issue.state, states.merging)) {
      await this.safeUpdateIssueState(issue, states.merging);
    }

    try {
      const result = await this.options.prManager?.mergePullRequest?.({ workspacePath, branchName });
      await this.safeUpdateIssueState(issue, states.done);
      this.options.db.appendEvent({ issueId: issue.id, identifier: issue.identifier, type: "pr.merged", message: result ?? inspection.url, payload: summarizePrInspection(inspection) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.safeUpdateIssueState(issue, states.rework);
      this.options.db.appendEvent({ level: "error", issueId: issue.id, identifier: issue.identifier, type: "pr.merge_failed", message, payload: { branchName, url: inspection.url } });
    }
  }

  private isReviewLifecycleState(state: string): boolean {
    return sameState(state, this.options.config.states.humanReview) || sameState(state, this.options.config.states.merging);
  }

  private async safeUpdateIssueState(issue: NormalizedIssue, stateName: string): Promise<void> {
    try {
      await this.options.tracker.updateIssueState?.(issue.id, stateName);
    } catch (error) {
      this.options.db.appendEvent({ level: "error", issueId: issue.id, identifier: issue.identifier, type: "tracker.state_update_failed", message: error instanceof Error ? error.message : String(error), payload: { stateName } });
    }
  }

  private async cleanupFailedWorkspace(workspacePath: string | null, branchName: string): Promise<void> {
    if (!workspacePath) return;
    try {
      await this.options.workspaceManager.remove(this.options.config.workspace.root, workspacePath, { ...(this.options.sourceRepoPath ? { sourceRepoPath: this.options.sourceRepoPath, branchName } : {}) });
      this.options.db.appendEvent({ level: "warn", type: "workspace.cleaned_after_failure", message: workspacePath });
    } catch (error) {
      this.options.db.appendEvent({ level: "error", type: "workspace.cleanup_failed", message: error instanceof Error ? error.message : String(error), payload: { workspacePath } });
    }
  }

  private async captureRequiredEvidence(runId: string, issue: NormalizedIssue, workspacePath: string): Promise<void> {
    const ui = this.options.config.evidence.ui;
    if (!ui || !ui.command || !requiresUiEvidence(issue, ui.requiredForLabels)) return;

    const outputDir = await this.options.evidenceStore.createRunDirectory(runId, "ui-evidence");
    this.options.db.appendEvent({ runId, issueId: issue.id, identifier: issue.identifier, type: "evidence.ui.started", message: ui.command, payload: { outputDir } });
    await this.options.workspaceManager.runHook(workspacePath, ui.command, ui.timeoutMs, {
      SYMPHONY_EVIDENCE_DIR: outputDir,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_RUN_ID: runId,
    });

    const files = await listFiles(outputDir);
    const missing: string[] = [];
    let recorded = 0;
    for (const requirement of ui.requiredArtifacts) {
      const matches = files.filter((file) => globMatches(requirement.glob, outputDir, file));
      if (matches.length === 0) {
        missing.push(`${requirement.kind}:${requirement.glob}`);
        continue;
      }
      for (const file of matches) {
        const artifact = this.options.evidenceStore.recordFileArtifact({
          runId,
          issueId: issue.id,
          kind: normalizeEvidenceKind(requirement.kind),
          label: requirement.label ?? `${requirement.kind}: ${basename(file)}`,
          path: file,
          metadata: { source: "evidence.ui", glob: requirement.glob },
        });
        this.options.db.recordEvidence(artifact);
        recorded += 1;
      }
    }

    if (missing.length > 0) {
      throw new Error(`Required UI evidence missing: ${missing.join(", ")}`);
    }
    this.options.db.appendEvent({ runId, issueId: issue.id, identifier: issue.identifier, type: "evidence.ui.passed", message: `Recorded ${recorded} UI evidence artifacts`, payload: { outputDir, recorded } });
  }

  private async writeRunnerEvidence(runId: string, issueId: string, result: RunnerResult): Promise<void> {
    if (result.stdout.trim()) {
      const artifact = await this.options.evidenceStore.writeTextArtifact({
        runId,
        issueId,
        kind: "log",
        label: "Runner stdout",
        filename: "runner-stdout.log",
        content: result.stdout,
      });
      this.options.db.recordEvidence(artifact);
    }
    if (result.stderr.trim()) {
      const artifact = await this.options.evidenceStore.writeTextArtifact({
        runId,
        issueId,
        kind: "log",
        label: "Runner stderr",
        filename: "runner-stderr.log",
        content: result.stderr,
      });
      this.options.db.recordEvidence(artifact);
    }
  }
}

function issueToPrompt(issue: NormalizedIssue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(issue.description !== undefined ? { description: issue.description } : {}),
    ...(issue.priority !== undefined ? { priority: issue.priority } : {}),
    state: issue.state,
    ...(issue.branchName !== undefined ? { branchName: issue.branchName } : {}),
    ...(issue.url !== undefined ? { url: issue.url } : {}),
    labels: issue.labels,
    blockedBy: issue.blockedBy,
    ...(issue.createdAt !== undefined ? { createdAt: issue.createdAt } : {}),
    ...(issue.updatedAt !== undefined ? { updatedAt: issue.updatedAt } : {}),
  };
}

function hasNonTerminalBlocker(issue: NormalizedIssue, terminalStates: readonly string[]): boolean {
  return issue.blockedBy.some((blocker) => blocker.state && !isTerminalState(blocker.state, terminalStates));
}

function requiresUiEvidence(issue: NormalizedIssue, requiredForLabels: readonly string[]): boolean {
  if (requiredForLabels.length === 0) return false;
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
  return requiredForLabels.some((label) => labels.has(label.toLowerCase()));
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if ((entry as Dirent).isDirectory()) files.push(...await listFiles(path));
    else if ((entry as Dirent).isFile()) files.push(path);
  }
  return files;
}

function globMatches(pattern: string, root: string, file: string): boolean {
  // Use Bun.Glob for full glob support (charsets, braces, etc.) instead of the
  // previous hand-rolled regex that silently missed unsupported syntax.
  const relativePath = relative(root, file).replaceAll("\\", "/");
  const target = pattern.includes("/") ? relativePath : basename(file);
  return new Bun.Glob(pattern).match(target);
}

function normalizeEvidenceKind(kind: string): "log" | "screenshot" | "video" | "test-output" | "link" | "other" {
  return ["log", "screenshot", "video", "test-output", "link", "other"].includes(kind) ? kind as "log" | "screenshot" | "video" | "test-output" | "link" | "other" : "other";
}

function retryDelayMs(attempt: number, maxRetryBackoffMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), maxRetryBackoffMs);
}

function sortIssues(issues: readonly NormalizedIssue[]): readonly NormalizedIssue[] {
  return [...issues].sort((left, right) => {
    const leftPriority = left.priority && left.priority > 0 ? left.priority : Number.POSITIVE_INFINITY;
    const rightPriority = right.priority && right.priority > 0 ? right.priority : Number.POSITIVE_INFINITY;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftCreated = left.createdAt ?? "";
    const rightCreated = right.createdAt ?? "";
    if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated);
    return left.identifier.localeCompare(right.identifier);
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function sameState(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeReviewDecision(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function blockingFindings(inspection: PullRequestInspection): readonly PullRequestReviewFinding[] {
  const findings = inspection.findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1" || finding.severity === "P2");

  const synthetic: PullRequestReviewFinding[] = [];
  if (inspection.checksStatus === "failing") {
    synthetic.push({ severity: "P1", source: "checks", message: "PR checks are failing; inspect CI output, fix the branch, and rerun validation." });
  }
  if (normalizeReviewDecision(inspection.reviewDecision) === "CHANGES_REQUESTED" && findings.length === 0) {
    synthetic.push({ severity: "P1", source: "review-decision", message: "GitHub review decision is CHANGES_REQUESTED; inspect review comments and address or explicitly push back on each actionable item." });
  }

  return [...findings, ...synthetic];
}

function appendReviewFeedback(prompt: string, inspection: PullRequestInspection | undefined, findings: readonly PullRequestReviewFinding[]): string {
  const lines = [
    prompt.trimEnd(),
    "",
    "## Pull Request Review Feedback",
    "",
    inspection ? `PR: ${inspection.url}` : "PR: unavailable",
    "Address every listed P0/P1/P2 item, rerun validation, commit, and push the branch before handing back to review.",
    "",
    ...findings.map((finding, index) => {
      const source = finding.source ? ` (${finding.source})` : "";
      const url = finding.url ? ` ${finding.url}` : "";
      return `${index + 1}. ${finding.severity}${source}: ${finding.message}${url}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function summarizePrInspection(inspection: PullRequestInspection): Record<string, unknown> {
  return {
    url: inspection.url,
    state: inspection.state,
    reviewDecision: inspection.reviewDecision ?? null,
    checksStatus: inspection.checksStatus,
    mergeable: inspection.mergeable,
    isDraft: inspection.isDraft ?? false,
    findings: inspection.findings.map((finding) => ({
      severity: finding.severity,
      source: finding.source ?? null,
      message: finding.message,
      url: finding.url ?? null,
    })),
  };
}

function prWaitingReason(issue: NormalizedIssue, inspection: PullRequestInspection, mergingState: string): string {
  if (inspection.state !== "OPEN") return `PR is ${inspection.state}`;
  if (inspection.isDraft) return "PR is draft";
  if (inspection.checksStatus !== "passing") return `PR checks are ${inspection.checksStatus}`;
  if (!inspection.mergeable) return "PR is not mergeable";
  if (!sameState(issue.state, mergingState) && normalizeReviewDecision(inspection.reviewDecision) !== "APPROVED") {
    return "PR is clean but not approved or in merging state";
  }
  return "PR is waiting";
}

export function newRunId(): string {
  return randomUUID();
}
