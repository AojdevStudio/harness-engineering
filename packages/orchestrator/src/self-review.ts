import type { AppendEventInput, EvidenceRecordInput } from "@symphony/db";
import type { EvidenceStore } from "@symphony/evidence";
import type { NormalizedIssue } from "@symphony/core";
import type { SelfReviewConfig } from "@symphony/workflow";
import type { HookResult } from "@symphony/workspace-git";
import type { PullRequestInspection, PullRequestReviewFinding } from "./index.ts";

export interface SelfReviewWorkspace {
  runHook(workspacePath: string, script: string, timeoutMs?: number, env?: Record<string, string>): Promise<HookResult>;
}

export interface SelfReviewPullRequestManager {
  inspectPullRequest?(input: { readonly workspacePath: string; readonly branchName: string }): Promise<PullRequestInspection | null>;
}

export interface RunSelfReviewInput {
  readonly config: SelfReviewConfig;
  readonly issue: NormalizedIssue;
  readonly runId: string;
  readonly workspacePath: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly prUrl: string | null;
  readonly workspace: SelfReviewWorkspace;
  readonly evidenceStore: EvidenceStore;
  readonly prManager?: SelfReviewPullRequestManager;
  readonly appendEvent: (event: AppendEventInput) => void;
  readonly recordEvidence: (artifact: EvidenceRecordInput) => void;
}

export type SelfReviewResult =
  | { readonly status: "skipped" }
  | { readonly status: "passed"; readonly findings: readonly PullRequestReviewFinding[] }
  | { readonly status: "blocked"; readonly findings: readonly PullRequestReviewFinding[]; readonly message: string };

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runConfiguredSelfReview(input: RunSelfReviewInput): Promise<SelfReviewResult> {
  const command = input.config.command?.trim();
  if (!command) return { status: "skipped" };

  const env = {
    SYMPHONY_RUN_ID: input.runId,
    SYMPHONY_ISSUE_ID: input.issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: input.issue.identifier,
    SYMPHONY_BRANCH_NAME: input.branchName,
    SYMPHONY_BASE_REF: input.baseBranch,
    SYMPHONY_PR_URL: input.prUrl ?? "",
  };

  input.appendEvent({
    runId: input.runId,
    issueId: input.issue.id,
    identifier: input.issue.identifier,
    type: "pr.self_review.started",
    message: command,
    payload: { branchName: input.branchName, prUrl: input.prUrl },
  });

  let hookResult: HookResult | null = null;
  let commandOutput: CommandOutput;
  try {
    hookResult = await input.workspace.runHook(input.workspacePath, command, input.config.timeoutMs, env);
    commandOutput = hookOutput(hookResult);
  } catch (error) {
    commandOutput = commandOutputFromError(error);
  }

  let inspection: PullRequestInspection | null = null;
  if (input.prManager?.inspectPullRequest) {
    try {
      inspection = await input.prManager.inspectPullRequest({
        workspacePath: input.workspacePath,
        branchName: input.branchName,
      });
    } catch (error) {
      input.appendEvent({
        level: "warn",
        runId: input.runId,
        issueId: input.issue.id,
        identifier: input.issue.identifier,
        type: "pr.self_review.inspect_failed",
        message: error instanceof Error ? error.message : String(error),
        payload: { branchName: input.branchName, prUrl: input.prUrl },
      });
    }
  }

  const findings = [
    ...parseSelfReviewFindings(`${commandOutput.stdout}\n${commandOutput.stderr}`, "self-review:output"),
    ...(inspection?.findings ?? []),
  ];
  const commandFailed = commandOutput.exitCode !== 0;
  const allFindings = commandFailed && findings.length === 0
    ? [
        ...findings,
        {
          severity: "P1" as const,
          source: "self-review:exit",
          message: `Self-review command exited ${commandOutput.exitCode} without structured findings.`,
        },
      ]
    : findings;
  const blocking = blockingSelfReviewFindings(allFindings, input.config.blockingSeverities);

  const artifact = await input.evidenceStore.writeTextArtifact({
    runId: input.runId,
    issueId: input.issue.id,
    kind: "test-output",
    label: "PR self-review",
    filename: "pr-self-review.txt",
    content: renderSelfReviewArtifact({
      command,
      prUrl: input.prUrl,
      branchName: input.branchName,
      output: commandOutput,
      findings: allFindings,
      hookResult,
      inspection,
    }),
    metadata: {
      source: "pr.self_review",
      branchName: input.branchName,
      prUrl: input.prUrl,
      command,
      exitCode: commandOutput.exitCode,
      findings: allFindings.length,
      blockingFindings: blocking.length,
    },
  });
  input.recordEvidence(artifact);

  if (commandFailed || blocking.length > 0) {
    const message = summarizeSelfReviewBlock(commandOutput.exitCode, blocking);
    input.appendEvent({
      level: "warn",
      runId: input.runId,
      issueId: input.issue.id,
      identifier: input.issue.identifier,
      type: "pr.self_review.blocked",
      message,
      payload: {
        branchName: input.branchName,
        prUrl: input.prUrl,
        artifactId: artifact.artifactId,
        findings: allFindings.map(serializeFinding),
      },
    });
    return { status: "blocked", findings: allFindings, message };
  }

  input.appendEvent({
    runId: input.runId,
    issueId: input.issue.id,
    identifier: input.issue.identifier,
    type: "pr.self_review.passed",
    message: `PR self-review passed with ${allFindings.length} non-blocking findings`,
    payload: {
      branchName: input.branchName,
      prUrl: input.prUrl,
      artifactId: artifact.artifactId,
      findings: allFindings.map(serializeFinding),
    },
  });
  return { status: "passed", findings: allFindings };
}

export function parseSelfReviewFindings(text: string, source: string): readonly PullRequestReviewFinding[] {
  const findings: PullRequestReviewFinding[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, "");
    const match = line.match(/^(P[0-3])\b\s*(?::|-)?\s*(.+)$/i);
    if (!match?.[1] || !match[2]?.trim()) continue;
    findings.push({
      severity: match[1].toUpperCase() as PullRequestReviewFinding["severity"],
      source,
      message: match[2].trim(),
    });
  }
  return findings;
}

function blockingSelfReviewFindings(
  findings: readonly PullRequestReviewFinding[],
  severities: readonly string[],
): readonly PullRequestReviewFinding[] {
  const blocking = new Set(severities.map((severity) => severity.toUpperCase()));
  return findings.filter((finding) => blocking.has(finding.severity));
}

function hookOutput(result: HookResult): CommandOutput {
  return {
    exitCode: result.exitCode,
    stdout: result.stdoutTail,
    stderr: result.stderrTail,
  };
}

function commandOutputFromError(error: unknown): CommandOutput {
  const details = typeof error === "object" && error !== null && "details" in error
    ? (error as { readonly details?: unknown }).details
    : null;
  if (typeof details === "object" && details !== null) {
    const record = details as { readonly exitCode?: unknown; readonly stdout?: unknown; readonly stderr?: unknown };
    return {
      exitCode: typeof record.exitCode === "number" ? record.exitCode : 1,
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string" ? record.stderr : "",
    };
  }
  return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}

function summarizeSelfReviewBlock(
  exitCode: number,
  blocking: readonly PullRequestReviewFinding[],
): string {
  if (blocking.length === 0) return `PR self-review command exited ${exitCode}`;
  const summary = blocking
    .map((finding) => `${finding.severity}${finding.source ? ` (${finding.source})` : ""}: ${finding.message}`)
    .join("; ");
  return `PR self-review found blocking feedback: ${summary}`;
}

function renderSelfReviewArtifact(input: {
  readonly command: string;
  readonly prUrl: string | null;
  readonly branchName: string;
  readonly output: CommandOutput;
  readonly findings: readonly PullRequestReviewFinding[];
  readonly hookResult: HookResult | null;
  readonly inspection: PullRequestInspection | null;
}): string {
  const findings = input.findings.length
    ? input.findings.map((finding) => `- ${finding.severity}${finding.source ? ` (${finding.source})` : ""}: ${finding.message}${finding.url ? ` ${finding.url}` : ""}`).join("\n")
    : "- none";
  return [
    "# Symphony PR Self-Review",
    "",
    `Command: ${input.command}`,
    `Exit: ${input.output.exitCode}`,
    `Branch: ${input.branchName}`,
    `PR: ${input.prUrl ?? "unavailable"}`,
    input.hookResult ? `Duration: ${input.hookResult.durationMs}ms` : "Duration: unavailable",
    input.inspection ? `Review decision: ${input.inspection.reviewDecision ?? "none"}` : "Review decision: unavailable",
    "",
    "## Findings",
    "",
    findings,
    "",
    "## Stdout",
    "",
    input.output.stdout || "(empty)",
    "",
    "## Stderr",
    "",
    input.output.stderr || "(empty)",
  ].join("\n");
}

function serializeFinding(finding: PullRequestReviewFinding): Record<string, unknown> {
  return {
    severity: finding.severity,
    source: finding.source ?? null,
    message: finding.message,
    url: finding.url ?? null,
  };
}
