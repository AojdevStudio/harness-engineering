import type { TokenUsage } from "@symphony/runner";
import type { HandoffFactsCommit, HandoffFactsDiffstat, HandoffFactsFile, PrTemplate } from "@symphony/workspace-git";
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
  readonly prTemplate?: PrTemplate;
  readonly followUps?: HandoffFollowUps;
}

function tokenLineFor(tokens: TokenUsage | undefined): string {
  if (!tokens) return "tokens in/out: 0/0";
  return `tokens in/out: ${tokens.inputTokens}/${tokens.outputTokens}`;
}

export function buildPrBody(input: HandoffReportInput): string {
  if (input.prTemplate) return buildTemplatePrBody(input);

  return buildDefaultPrBody(input);
}

function buildDefaultPrBody(input: HandoffReportInput): string {
  const sections = symphonyPrSections(input);
  return [
    "## Summary",
    ...sections.summary.lines,
    "",
    "## Linked issues",
    ...sections.linked.lines,
    "",
    "## Verification",
    ...sections.verification.lines,
    "",
    ...runMetadataLines(input),
  ].join("\n");
}

type SymphonyPrSectionKey = "summary" | "linked" | "verification";

interface SymphonyPrSection {
  readonly header: string;
  readonly lines: readonly string[];
}

function symphonyPrSections(input: HandoffReportInput): Record<SymphonyPrSectionKey, SymphonyPrSection> {
  return {
    summary: {
      header: "Summary",
      lines: [
        ...input.commits.map((commit) => `- ${commit.subject}`),
        `- files changed: ${input.diffstat.filesChanged} | +${input.diffstat.insertions} / -${input.diffstat.deletions}`,
      ],
    },
    linked: {
      header: "Linked issues",
      lines: [`Closes ${input.issue.identifier}`],
    },
    verification: {
      header: "Verification",
      lines: ["_Captured in a follow-up slice (#TBD)._"],
    },
  };
}

function buildTemplatePrBody(input: HandoffReportInput): string {
  const template = input.prTemplate;
  if (!template) return buildDefaultPrBody(input);

  const sections = symphonyPrSections(input);
  const used = new Set<SymphonyPrSectionKey>();
  const lines: string[] = [];

  for (const templateSection of template.sections) {
    const key = matchingSectionKey(templateSection.header);
    lines.push(`## ${templateSection.header}`);
    if (key && !used.has(key)) {
      lines.push(...sections[key].lines);
      used.add(key);
    } else if (templateSection.body.trim() !== "") {
      lines.push(...templateSection.body.split("\n"));
    }
    lines.push("");
  }

  for (const key of ["summary", "linked", "verification"] as const) {
    if (used.has(key)) continue;
    const section = sections[key];
    lines.push(`## ${section.header}`);
    lines.push(...section.lines);
    lines.push("");
  }

  lines.push(...runMetadataLines(input));
  return lines.join("\n");
}

function matchingSectionKey(header: string): SymphonyPrSectionKey | null {
  const normalized = header.toLowerCase();
  if (["summary", "description", "what changed"].some((keyword) => normalized.includes(keyword))) return "summary";
  if (["verification", "testing", "validation", "checklist"].some((keyword) => normalized.includes(keyword))) return "verification";
  if (["linked issue", "related issue", "closes"].some((keyword) => normalized.includes(keyword))) return "linked";
  return null;
}

function runMetadataLines(input: HandoffReportInput): string[] {
  return [
    "---",
    "<details><summary>Run metadata</summary>",
    "",
    `runner: ${input.result.runner} · runId: ${input.run.runId} · ${tokenLineFor(input.result.tokenUsage)}`,
    "",
    "</details>",
  ];
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
