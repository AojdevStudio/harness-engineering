import type { HandoffFactsCommit, PrTemplate } from "@symphony/workspace-git";
import type { PullRequestInspection } from "./index.ts";

export type IssueLinkSource = "branch" | "commits" | "no-issue" | "fallback";

export interface IssueLinkResolution {
  readonly trackerKeyword: string;
  readonly githubKeyword?: string;
  readonly noIssueChecked?: boolean;
  readonly source: IssueLinkSource;
}

export interface IssueLinkValidator {
  validateIssueExists(num: number): boolean | Promise<boolean>;
}

export type MetadataCheckReason = "missing-github-closing-keyword" | "missing-tracker-keyword" | "unexpected-base-ref";

export interface MetadataCheckResult {
  readonly ok: boolean;
  readonly reason?: MetadataCheckReason;
}

export interface ResolveIssueLinkInput {
  readonly trackerIdentifier: string;
  readonly branchName: string;
  readonly commits: readonly HandoffFactsCommit[];
  readonly prTemplate?: PrTemplate;
  readonly allowNoIssue?: boolean;
  readonly ghValidator: IssueLinkValidator;
}

const BRANCH_ISSUE_RE = /(^|[/_#-])([0-9]{1,6})([/_-]|$)/g;
const COMMIT_ISSUE_RE = /\b(Fixes|Closes|Resolves|Refs)\s+#([0-9]{1,6})\b/gi;
const NO_ISSUE_RE = /^-\s+\[\s\]\s+No issue required.*$/im;

export async function resolveIssueLink(input: ResolveIssueLinkInput): Promise<IssueLinkResolution> {
  const trackerKeyword = `Closes ${input.trackerIdentifier}`;

  for (const num of issueNumbersFromBranch(input.branchName)) {
    if (await input.ghValidator.validateIssueExists(num)) {
      return { trackerKeyword, githubKeyword: `Closes #${num}`, source: "branch" };
    }
  }

  for (const match of issueLinksFromCommits(input.commits)) {
    if (await input.ghValidator.validateIssueExists(match.num)) {
      return {
        trackerKeyword,
        githubKeyword: `${match.verb === "Refs" ? "Refs" : "Closes"} #${match.num}`,
        source: "commits",
      };
    }
  }

  if (input.allowNoIssue === true && templateHasNoIssueCheckbox(input.prTemplate)) {
    return { trackerKeyword, noIssueChecked: true, source: "no-issue" };
  }

  return { trackerKeyword, source: "fallback" };
}

export function verifyPrMetadata(resolution: IssueLinkResolution, inspection: PullRequestInspection): MetadataCheckResult {
  if (!resolution.githubKeyword) return { ok: true };

  const closingIssueNumber = githubClosingIssueNumber(resolution.githubKeyword);
  if (closingIssueNumber === null) return { ok: true };
  if (inspection.closingIssuesReferences.includes(closingIssueNumber)) return { ok: true };

  return { ok: false, reason: "missing-github-closing-keyword" };
}

function githubClosingIssueNumber(keyword: string): number | null {
  const match = keyword.match(/^(?:Closes|Fixes|Resolves)\s+#([0-9]{1,6})$/i);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

function issueNumbersFromBranch(branchName: string): readonly number[] {
  const nums: number[] = [];
  for (const match of branchName.matchAll(BRANCH_ISSUE_RE)) {
    const value = Number.parseInt(match[2] ?? "", 10);
    if (Number.isInteger(value)) nums.push(value);
  }
  return nums;
}

function issueLinksFromCommits(commits: readonly HandoffFactsCommit[]): readonly { readonly verb: "Fixes" | "Closes" | "Resolves" | "Refs"; readonly num: number }[] {
  const links: Array<{ verb: "Fixes" | "Closes" | "Resolves" | "Refs"; num: number }> = [];
  for (const commit of commits) {
    const text = `${commit.subject}\n${commit.body}`;
    for (const match of text.matchAll(COMMIT_ISSUE_RE)) {
      const verb = normalizeVerb(match[1]);
      const num = Number.parseInt(match[2] ?? "", 10);
      if (verb && Number.isInteger(num)) links.push({ verb, num });
    }
  }
  return links;
}

function normalizeVerb(value: string | undefined): "Fixes" | "Closes" | "Resolves" | "Refs" | null {
  const lower = value?.toLowerCase();
  if (lower === "fixes") return "Fixes";
  if (lower === "closes") return "Closes";
  if (lower === "resolves") return "Resolves";
  if (lower === "refs") return "Refs";
  return null;
}

export function templateHasNoIssueCheckbox(template: PrTemplate | undefined): boolean {
  return template?.raw.match(NO_ISSUE_RE) !== null;
}
