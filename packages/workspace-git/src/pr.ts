import type { CommandRunner } from "./index.ts";
import { WorkspaceError } from "./index.ts";

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
  readonly state: string;
  readonly reviewDecision?: string | null;
  readonly checksStatus: PullRequestCheckStatus;
  readonly mergeable: boolean;
  readonly isDraft?: boolean;
  readonly findings: readonly PullRequestReviewFinding[];
}

async function runOrThrow(runner: CommandRunner, command: readonly string[], cwd: string): Promise<string> {
  const result = await runner(command, { cwd });
  if (result.exitCode !== 0) {
    throw new WorkspaceError(`Command failed: ${command.join(" ")}`, result);
  }
  return result.stdout.trim();
}

/**
 * Manages GitHub pull requests for a workspace branch via the `gh` CLI.
 *
 * The `base` branch defaults to `"main"`. To target a different branch
 * (e.g. a release or staging branch), pass `base` in the constructor options:
 *
 * ```ts
 * const manager = new GitHubPrManager({ runner, base: "develop" });
 * ```
 *
 * All other options (`remote`) follow the same override pattern.
 */
export class GitHubPrManager {
  private readonly runner: CommandRunner;
  private readonly remote: string;
  private readonly base: string;
  private readonly mergeMethod: "merge" | "squash" | "rebase";

  constructor(options: { readonly runner: CommandRunner; readonly remote?: string; readonly base?: string; readonly mergeMethod?: "merge" | "squash" | "rebase" }) {
    this.runner = options.runner;
    this.remote = options.remote ?? "origin";
    this.base = options.base ?? "main";
    this.mergeMethod = options.mergeMethod ?? "squash";
  }

  async ensureBranch(input: { readonly workspacePath: string; readonly branchName: string }): Promise<void> {
    // Verify the branch exists locally. git checkout after worktree creation
    // is a no-op at best and fails if the branch was deleted. Use rev-parse
    // instead to confirm the ref is present without touching the working tree.
    const result = await this.runner(["git", "rev-parse", "--verify", `refs/heads/${input.branchName}`], { cwd: input.workspacePath });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`Branch "${input.branchName}" does not exist in ${input.workspacePath}`, result);
    }
  }

  async pushBranch(input: { readonly workspacePath: string; readonly branchName: string }): Promise<void> {
    await runOrThrow(this.runner, ["git", "push", "-u", this.remote, input.branchName], input.workspacePath);
  }

  async ensurePullRequest(input: { readonly workspacePath: string; readonly branchName: string; readonly title: string; readonly body: string }): Promise<string | null> {
    const existing = await this.runner(["gh", "pr", "view", "--json", "url", "--jq", ".url"], { cwd: input.workspacePath });
    if (existing.exitCode === 0 && existing.stdout.trim()) {
      return existing.stdout.trim();
    }

    const created = await runOrThrow(
      this.runner,
      ["gh", "pr", "create", "--base", this.base, "--head", input.branchName, "--title", input.title, "--body", input.body],
      input.workspacePath,
    );
    return created || null;
  }

  async inspectPullRequest(input: { readonly workspacePath: string; readonly branchName: string }): Promise<PullRequestInspection | null> {
    const result = await this.runner(
      ["gh", "pr", "view", input.branchName, "--json", "number,url,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,comments,reviews"],
      { cwd: input.workspacePath },
    );
    if (result.exitCode !== 0) return null;

    let body: unknown;
    try {
      body = JSON.parse(result.stdout);
    } catch (error) {
      throw new WorkspaceError("Unable to parse gh pr view JSON", error);
    }

    const inlineComments = await this.fetchInlineReviewComments(input.workspacePath, body);
    return normalizePrView(body, inlineComments);
  }

  async mergePullRequest(input: { readonly workspacePath: string; readonly branchName: string }): Promise<string | null> {
    const methodFlag = this.mergeMethod === "merge" ? "--merge" : this.mergeMethod === "rebase" ? "--rebase" : "--squash";
    const result = await runOrThrow(this.runner, ["gh", "pr", "merge", input.branchName, methodFlag, "--delete-branch"], input.workspacePath);
    return result || null;
  }

  private async fetchInlineReviewComments(workspacePath: string, prViewBody: unknown): Promise<readonly Record<string, unknown>[]> {
    const record = asRecord(prViewBody);
    const url = stringValue(record.url);
    const ownerRepo = url ? ownerRepoFromPrUrl(url) : null;
    const number = numberValue(record.number) ?? numberFromPrUrl(url);
    if (!ownerRepo || number === null) return [];

    const result = await this.runner(
      ["gh", "api", `repos/${ownerRepo}/pulls/${number}/comments`, "--paginate", "--jq", ".[] | @json"],
      { cwd: workspacePath },
    );
    if (result.exitCode !== 0) {
      throw new WorkspaceError("Unable to inspect PR inline review comments", result);
    }
    return parseJsonLines(result.stdout);
  }
}

function normalizePrView(value: unknown, inlineComments: readonly Record<string, unknown>[] = []): PullRequestInspection {
  const record = asRecord(value);
  const url = stringValue(record.url) ?? "";
  const state = stringValue(record.state) ?? "UNKNOWN";
  const reviewDecision = stringValue(record.reviewDecision);
  const mergeStateStatus = stringValue(record.mergeStateStatus);
  const isDraft = booleanValue(record.isDraft) ?? false;

  return {
    url,
    state,
    ...(reviewDecision !== null ? { reviewDecision } : {}),
    checksStatus: normalizeChecksStatus(record.statusCheckRollup),
    mergeable: !isDraft && (mergeStateStatus === "CLEAN" || mergeStateStatus === "HAS_HOOKS"),
    isDraft,
    findings: extractFindings(record, inlineComments),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function normalizeChecksStatus(value: unknown): PullRequestCheckStatus {
  const checks = Array.isArray(value) ? value.map(asRecord) : [];
  if (checks.length === 0) return "unknown";

  let pending = false;
  for (const check of checks) {
    const conclusion = stringValue(check.conclusion)?.toUpperCase() ?? null;
    const status = stringValue(check.status)?.toUpperCase() ?? null;
    const state = stringValue(check.state)?.toUpperCase() ?? null;

    if (state === "FAILURE" || state === "ERROR") return "failing";
    if (conclusion && ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) return "failing";
    if (state === "PENDING" || state === "EXPECTED") pending = true;
    if (status && status !== "COMPLETED") pending = true;
    if (!conclusion && !state) pending = true;
  }

  return pending ? "pending" : "passing";
}

function extractFindings(record: Record<string, unknown>, inlineComments: readonly Record<string, unknown>[]): PullRequestReviewFinding[] {
  const comments = Array.isArray(record.comments) ? record.comments : [];
  const reviews = Array.isArray(record.reviews) ? record.reviews : [];
  const findings: PullRequestReviewFinding[] = [];

  for (const comment of comments.map(asRecord)) {
    const url = stringValue(comment.url);
    findings.push(...extractFindingsFromText(stringValue(comment.body), {
      source: "comment",
      ...(url ? { url } : {}),
    }));
  }

  for (const review of reviews.map(asRecord)) {
    const author = asRecord(review.author);
    const login = stringValue(author.login);
    const url = stringValue(review.url);
    findings.push(...extractFindingsFromText(stringValue(review.body), {
      source: login ? `review:${login}` : "review",
      ...(url ? { url } : {}),
    }));
  }

  for (const comment of inlineComments) {
    const path = stringValue(comment.path);
    const url = stringValue(comment.html_url) ?? stringValue(comment.url);
    findings.push(...extractFindingsFromText(stringValue(comment.body), {
      source: path ? `inline:${path}` : "inline-comment",
      ...(url ? { url } : {}),
    }));
  }

  return findings;
}

function extractFindingsFromText(text: string | null, context: { readonly source: string; readonly url?: string }): PullRequestReviewFinding[] {
  if (!text) return [];

  const findings: PullRequestReviewFinding[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\b(P[0-3])\b[\]\)]?\s*[:\-–—]?\s*(.+)/i);
    if (!match) continue;
    const severity = match[1]?.toUpperCase() as PullRequestReviewSeverity | undefined;
    const message = match[2]?.trim();
    if (!severity || !message) continue;
    findings.push({
      severity,
      message,
      source: context.source,
      ...(context.url ? { url: context.url } : {}),
    });
  }
  return findings;
}

function ownerRepoFromPrUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/);
  return match?.[1] ?? null;
}

function numberFromPrUrl(url: string | null): number | null {
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)/);
  const value = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isInteger(value) ? value : null;
}

function parseJsonLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      try {
        return asRecord(JSON.parse(line));
      } catch (error) {
        throw new WorkspaceError("Unable to parse gh api inline review comment JSON", error);
      }
    });
}
