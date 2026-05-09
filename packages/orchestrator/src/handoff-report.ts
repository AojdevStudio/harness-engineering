import type { TokenUsage } from "@symphony/runner";
import type { HandoffFactsCommit, HandoffFactsDiffstat, HandoffFactsFile } from "@symphony/workspace-git";
import type { PullRequestCheckStatus } from "./index.ts";

export interface HandoffIssue {
  readonly identifier: string;
  readonly title: string;
}

export interface HandoffRunMeta {
  readonly runId: string;
}

export interface HandoffResultMeta {
  readonly runner: string;
  readonly prTitle: string;
  readonly prUrl: string | null;
  readonly checksStatus: PullRequestCheckStatus;
  readonly tokenUsage?: TokenUsage;
}

export interface HandoffVerificationItem {
  readonly command: string;
  readonly exitCode: number;
  readonly summary?: string;
  readonly durationMs?: number;
}

export interface HandoffPrTemplateSection {
  readonly header: string;
  readonly body: string;
}

export interface HandoffPrTemplate {
  readonly raw: string;
  readonly sections: readonly HandoffPrTemplateSection[];
}

export interface HandoffFollowUps {
  readonly unverified: readonly string[];
  readonly nextTime: readonly string[];
}

export interface HandoffReportInput {
  readonly issue: HandoffIssue;
  readonly run: HandoffRunMeta;
  readonly result: HandoffResultMeta;
  readonly commits: readonly HandoffFactsCommit[];
  readonly files: readonly HandoffFactsFile[];
  readonly diffstat: HandoffFactsDiffstat;
  readonly verification?: readonly HandoffVerificationItem[];
  readonly prTemplate?: HandoffPrTemplate;
  readonly followUps?: HandoffFollowUps;
}

function tokenLineFor(tokens: TokenUsage | undefined): string {
  if (!tokens) return "tokens in/out: 0/0";
  return `tokens in/out: ${tokens.inputTokens}/${tokens.outputTokens}`;
}

export function buildPrBody(input: HandoffReportInput): string {
  const summaryLines = input.commits.map((commit) => `- ${commit.subject}`);
  const diffstatLine = `- files changed: ${input.diffstat.filesChanged} | +${input.diffstat.insertions} / -${input.diffstat.deletions}`;
  return [
    "## Summary",
    ...summaryLines,
    diffstatLine,
    "",
    "## Linked issues",
    `Closes ${input.issue.identifier}`,
    "",
    "## Verification",
    "_Captured in a follow-up slice (#TBD)._",
    "",
    "---",
    "<details><summary>Run metadata</summary>",
    "",
    `runner: ${input.result.runner} · runId: ${input.run.runId} · ${tokenLineFor(input.result.tokenUsage)}`,
    "",
    "</details>",
  ].join("\n");
}

export function buildLinearComment(input: HandoffReportInput): string {
  const prLine = input.result.prUrl
    ? `**PR:** [${input.result.prTitle}](${input.result.prUrl}) (status: ${input.result.checksStatus})`
    : "**PR:** not created";
  const fileLines = input.files.map((file) => `- ${file.path}`);
  return [
    `## ${input.issue.identifier} — Symphony run report`,
    "",
    prLine,
    "",
    `**Files touched (${input.files.length}):**`,
    ...fileLines,
    "",
    "**Verification**",
    "_Captured in #TBD._",
    "",
    "---",
    `runner: ${input.result.runner} · runId: ${input.run.runId} · ${tokenLineFor(input.result.tokenUsage)}`,
  ].join("\n");
}
