import type { AppendEventInput } from "@symphony/db";
import type { NormalizedIssue } from "@symphony/core";
import type { RunnerResult } from "@symphony/runner";
import type { HandoffFacts, HookResult, PrTemplate } from "@symphony/workspace-git";
import { buildLinearComment, buildPrBody, verificationItemsFromHookResult, type HandoffReportInput } from "./handoff-report.ts";
import { resolveIssueLink, verifyPrMetadata, type IssueLinkResolution } from "./issue-link.ts";
import { writeBestEffortWorkpad, type TrackerWorkpadWriter } from "./tracker-writes.ts";
import type { PullRequestInspection } from "./index.ts";

export interface HandoffWorkspace {
  collectHandoffFacts(workspacePath: string, baseBranch: string): Promise<HandoffFacts>;
  readPrTemplate(workspacePath: string): Promise<PrTemplate | null>;
}

export interface HandoffTracker extends TrackerWorkpadWriter {}

export interface HandoffPullRequestManager {
  validateIssueExists?(workspacePath: string, num: number): Promise<boolean>;
  ensurePullRequest?(input: { readonly workspacePath: string; readonly branchName: string; readonly title: string; readonly body: string }): Promise<string | null>;
  editPullRequestBody?(input: { readonly workspacePath: string; readonly branchName: string; readonly body: string }): Promise<void>;
  inspectPullRequest?(input: { readonly workspacePath: string; readonly branchName: string }): Promise<PullRequestInspection | null>;
}

export interface PublishPrHandoffInput {
  readonly issue: NormalizedIssue;
  readonly runId: string;
  readonly runnerKind: string;
  readonly runnerResult: RunnerResult;
  readonly afterRunVerification: HookResult;
  readonly workspacePath: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly workspace: HandoffWorkspace;
  readonly prManager?: HandoffPullRequestManager;
  readonly tracker?: HandoffTracker;
  readonly appendEvent: (event: AppendEventInput) => void;
}

export interface PublishPrHandoffResult {
  readonly prUrl: string | null;
  readonly handoffInput: HandoffReportInput;
  readonly issueLink: IssueLinkResolution;
}

export async function publishPrHandoff(input: PublishPrHandoffInput): Promise<PublishPrHandoffResult> {
  const facts = await input.workspace.collectHandoffFacts(input.workspacePath, input.baseBranch);
  const prTemplate = await input.workspace.readPrTemplate(input.workspacePath);
  const issueLink = await resolveIssueLink({
    trackerIdentifier: input.issue.identifier,
    branchName: input.branchName,
    commits: facts.commits,
    ...(prTemplate ? { prTemplate } : {}),
    ghValidator: {
      validateIssueExists: (num) => input.prManager?.validateIssueExists?.(input.workspacePath, num) ?? false,
    },
  });

  if (issueLink.source === "fallback") {
    input.appendEvent({
      runId: input.runId,
      issueId: input.issue.id,
      identifier: input.issue.identifier,
      type: "pr.no_github_issue_link",
      message: "No GitHub issue link resolved for PR body",
    });
  }

  const prTitle = `${input.issue.identifier}: ${input.issue.title}`;
  const handoffInput: HandoffReportInput = {
    issue: { identifier: input.issue.identifier, title: input.issue.title },
    run: { runId: input.runId },
    result: {
      runner: input.runnerKind,
      prTitle,
      prUrl: null,
      checksStatus: "pending",
      ...(input.runnerResult.tokenUsage ? { tokenUsage: input.runnerResult.tokenUsage } : {}),
    },
    commits: facts.commits,
    files: facts.files,
    diffstat: facts.diffstat,
    verification: verificationItemsFromHookResult(input.afterRunVerification),
    ...(prTemplate ? { prTemplate } : {}),
    issueLink,
    ...(input.runnerResult.followUps ? { followUps: input.runnerResult.followUps } : {}),
  };

  const prUrl = await input.prManager?.ensurePullRequest?.({
    workspacePath: input.workspacePath,
    branchName: input.branchName,
    title: prTitle,
    body: buildPrBody(handoffInput),
  });

  await verifyAndRepairPrMetadata({
    ...input,
    handoffInput,
    issueLink,
  });

  if (prUrl) {
    input.appendEvent({
      runId: input.runId,
      issueId: input.issue.id,
      identifier: input.issue.identifier,
      type: "pr.ready",
      message: prUrl,
    });
  }

  await writeBestEffortWorkpad({
    tracker: input.tracker,
    issue: input.issue,
    runId: input.runId,
    body: buildLinearComment({ ...handoffInput, result: { ...handoffInput.result, prUrl: prUrl ?? null } }),
    appendEvent: input.appendEvent,
  });

  return { prUrl: prUrl ?? null, handoffInput, issueLink };
}

async function verifyAndRepairPrMetadata(input: PublishPrHandoffInput & {
  readonly handoffInput: HandoffReportInput;
  readonly issueLink: IssueLinkResolution;
}): Promise<void> {
  if (!input.prManager?.inspectPullRequest) return;

  const inspection = await input.prManager.inspectPullRequest({
    workspacePath: input.workspacePath,
    branchName: input.branchName,
  });
  if (!inspection) return;

  const check = verifyPrMetadata(input.issueLink, inspection);
  if (check.ok) return;
  if (check.reason !== "missing-github-closing-keyword") return;

  if (!input.prManager.editPullRequestBody) {
    input.appendEvent({
      level: "error",
      runId: input.runId,
      issueId: input.issue.id,
      identifier: input.issue.identifier,
      type: "pr.metadata_repair_failed",
      message: "PR metadata repair required but editPullRequestBody is unavailable",
    });
    throw new Error("PR metadata repair required but editPullRequestBody is unavailable");
  }

  await input.prManager.editPullRequestBody({
    workspacePath: input.workspacePath,
    branchName: input.branchName,
    body: buildPrBody(input.handoffInput),
  });

  const repairedInspection = await input.prManager.inspectPullRequest({
    workspacePath: input.workspacePath,
    branchName: input.branchName,
  });
  if (repairedInspection && verifyPrMetadata(input.issueLink, repairedInspection).ok) {
    input.appendEvent({
      runId: input.runId,
      issueId: input.issue.id,
      identifier: input.issue.identifier,
      type: "pr.metadata_repaired",
      message: "PR closing issue metadata repaired",
    });
    return;
  }

  input.appendEvent({
    level: "error",
    runId: input.runId,
    issueId: input.issue.id,
    identifier: input.issue.identifier,
    type: "pr.metadata_repair_failed",
    message: "PR closing issue metadata still missing after one repair attempt",
  });
  throw new Error("PR closing issue metadata still missing after one repair attempt");
}
