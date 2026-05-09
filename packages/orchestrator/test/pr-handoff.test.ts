import { describe, expect, test } from "bun:test";
import type { AppendEventInput } from "@symphony/db";
import type { NormalizedIssue } from "@symphony/core";
import type { RunnerResult } from "@symphony/runner";
import type { HandoffFacts, HookResult, PrTemplate } from "@symphony/workspace-git";
import { publishPrHandoff, type HandoffPullRequestManager, type HandoffWorkspace } from "../src/pr-handoff.ts";
import type { PullRequestInspection } from "../src/index.ts";

const issue: NormalizedIssue = {
  id: "issue-1",
  identifier: "ABC-1",
  title: "Do work",
  description: "Body",
  priority: 1,
  state: "In Progress",
  labels: [],
  blockedBy: [],
  createdAt: "2026-01-01T00:00:00Z",
};

const facts: HandoffFacts = {
  commits: [
    { sha: "aaa111", subject: "feat: implement handoff", body: "" },
  ],
  files: [
    { path: "packages/orchestrator/src/pr-handoff.ts", status: "A" },
    { path: "packages/orchestrator/src/index.ts", status: "M" },
  ],
  diffstat: { filesChanged: 2, insertions: 120, deletions: 40 },
};

const afterRunVerification: HookResult = {
  command: "bun run typecheck && bun test",
  exitCode: 0,
  stdoutTail: "88 pass\n0 fail\n",
  stderrTail: "",
  durationMs: 5900,
  commands: [
    { command: "bun run typecheck", exitCode: 0, stdoutTail: "typecheck ok\n", stderrTail: "", durationMs: 1200 },
    { command: "bun test", exitCode: 0, stdoutTail: "88 pass\n0 fail\n", stderrTail: "", durationMs: 4700 },
  ],
};

const runnerResult: RunnerResult = {
  ok: true,
  exitCode: 0,
  stdout: "done",
  stderr: "",
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
  tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  followUps: {
    unverified: ["browser smoke on deployed preview"],
    nextTime: ["wait for ABC-2 before broadening scope"],
  },
};

function workspace(input: {
  readonly template?: PrTemplate | null;
  readonly calls?: string[];
} = {}): HandoffWorkspace {
  return {
    collectHandoffFacts: async (_workspacePath, baseBranch) => {
      input.calls?.push(`facts:${baseBranch}`);
      return facts;
    },
    readPrTemplate: async () => {
      input.calls?.push("template");
      return input.template ?? null;
    },
  };
}

function inspection(closingIssuesReferences: readonly number[]): PullRequestInspection {
  return {
    url: "https://github.test/pr/1",
    state: "OPEN",
    checksStatus: "passing",
    mergeable: true,
    isDraft: false,
    closingIssuesReferences,
    findings: [],
  };
}

function baseInput(input: {
  readonly workspace: HandoffWorkspace;
  readonly prManager?: HandoffPullRequestManager;
  readonly tracker?: { createOrUpdateWorkpad?(issueId: string, body: string): Promise<void> };
  readonly events?: AppendEventInput[];
  readonly branchName?: string;
}) {
  return {
    issue,
    runId: "run-1",
    runnerKind: "codex",
    runnerResult,
    afterRunVerification,
    workspacePath: "/repo/workspace",
    branchName: input.branchName ?? "feature/123-pr-handoff",
    baseBranch: "origin/symphony-base",
    workspace: input.workspace,
    ...(input.prManager ? { prManager: input.prManager } : {}),
    ...(input.tracker ? { tracker: input.tracker } : {}),
    appendEvent: (event: AppendEventInput) => {
      input.events?.push(event);
    },
  };
}

describe("publishPrHandoff", () => {
  test("publishes a PR handoff and tracker report from completed attempt data", async () => {
    const calls: string[] = [];
    const events: AppendEventInput[] = [];
    let prTitle = "";
    let prBody = "";
    let workpadBody = "";

    const result = await publishPrHandoff(baseInput({
      workspace: workspace({ calls }),
      events,
      prManager: {
        validateIssueExists: async (_workspacePath, num) => {
          calls.push(`validate:${num}`);
          return num === 123;
        },
        ensurePullRequest: async (input) => {
          calls.push("pr");
          prTitle = input.title;
          prBody = input.body;
          return "https://github.test/pr/1";
        },
      },
      tracker: {
        createOrUpdateWorkpad: async (_issueId, body) => {
          calls.push("workpad");
          workpadBody = body;
        },
      },
    }));

    expect(calls).toEqual(["facts:origin/symphony-base", "template", "validate:123", "pr", "workpad"]);
    expect(result.prUrl).toBe("https://github.test/pr/1");
    expect(result.issueLink).toMatchObject({ trackerKeyword: "Closes ABC-1", githubKeyword: "Closes #123", source: "branch" });
    expect(prTitle).toBe("ABC-1: Do work");
    expect(prBody).toContain("## Summary");
    expect(prBody).toContain("Closes ABC-1");
    expect(prBody).toContain("Closes #123");
    expect(prBody).toContain("bun run typecheck");
    expect(prBody).toContain("88 pass / 0 fail");
    expect(workpadBody).toContain("**PR:** [ABC-1: Do work](https://github.test/pr/1)");
    expect(workpadBody).toContain("**What could not be verified**\n- browser smoke on deployed preview");
    expect(workpadBody).toContain("**What's needed next time**\n- wait for ABC-2 before broadening scope");
    expect(events.map((event) => event.type)).toEqual(["pr.ready"]);
  });

  test("records fallback issue-link events when no GitHub issue can be resolved", async () => {
    const events: AppendEventInput[] = [];

    const result = await publishPrHandoff(baseInput({
      workspace: workspace(),
      events,
      branchName: "feature/no-github-issue",
      prManager: {
        validateIssueExists: async () => false,
        ensurePullRequest: async () => "https://github.test/pr/1",
      },
    }));

    expect(result.issueLink).toEqual({ trackerKeyword: "Closes ABC-1", source: "fallback" });
    expect(events.map((event) => event.type)).toEqual(["pr.no_github_issue_link", "pr.ready"]);
  });

  test("keeps handoff successful when the best-effort workpad write fails", async () => {
    const events: AppendEventInput[] = [];

    const result = await publishPrHandoff(baseInput({
      workspace: workspace(),
      events,
      prManager: {
        validateIssueExists: async () => true,
        ensurePullRequest: async () => "https://github.test/pr/1",
      },
      tracker: {
        createOrUpdateWorkpad: async () => {
          throw new Error("Linear comment failed");
        },
      },
    }));

    expect(result.prUrl).toBe("https://github.test/pr/1");
    expect(events.map((event) => event.type)).toEqual(["pr.ready", "tracker.workpad_update_failed"]);
    expect(events[1]).toMatchObject({
      level: "error",
      message: "Linear comment failed",
      payload: { policy: "best-effort", operation: "createOrUpdateWorkpad" },
    });
  });

  test("repairs PR metadata when GitHub did not parse the closing keyword", async () => {
    const events: AppendEventInput[] = [];
    const calls: string[] = [];
    const inspections = [inspection([]), inspection([123])];
    let repairedBody = "";

    await publishPrHandoff(baseInput({
      workspace: workspace(),
      events,
      prManager: {
        validateIssueExists: async () => true,
        ensurePullRequest: async () => {
          calls.push("pr");
          return "https://github.test/pr/1";
        },
        inspectPullRequest: async () => {
          calls.push("inspect");
          return inspections.shift() ?? inspection([123]);
        },
        editPullRequestBody: async (input) => {
          calls.push("edit");
          repairedBody = input.body;
        },
      },
    }));

    expect(calls).toEqual(["pr", "inspect", "edit", "inspect"]);
    expect(repairedBody).toContain("Closes #123");
    expect(events.map((event) => event.type)).toEqual(["pr.metadata_repaired", "pr.ready"]);
  });

  test("fails loudly when metadata repair is required but the PR manager cannot edit", async () => {
    const events: AppendEventInput[] = [];

    await expect(publishPrHandoff(baseInput({
      workspace: workspace(),
      events,
      prManager: {
        validateIssueExists: async () => true,
        ensurePullRequest: async () => "https://github.test/pr/1",
        inspectPullRequest: async () => inspection([]),
      },
    }))).rejects.toThrow("PR metadata repair required but editPullRequestBody is unavailable");

    expect(events.map((event) => event.type)).toEqual(["pr.metadata_repair_failed"]);
    expect(events[0]?.level).toBe("error");
  });
});
