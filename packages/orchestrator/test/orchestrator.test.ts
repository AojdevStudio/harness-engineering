import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSymphonyDatabase } from "@symphony/db";
import { EvidenceStore } from "@symphony/evidence";
import type { AgentRunner } from "@symphony/runner";
import { parseWorkflowMarkdown, resolveWorkflowConfig } from "@symphony/workflow";
import { GitWorkspaceManager, type CommandRunner, type PrTemplate } from "@symphony/workspace-git";
import { SymphonyOrchestrator, type PullRequestInspection, type TrackerAdapter } from "../src/index.ts";

const issue = {
  id: "issue-1",
  identifier: "ABC-1",
  title: "Do work",
  description: "Body",
  priority: 1,
  state: "Todo",
  labels: [],
  blockedBy: [],
  createdAt: "2026-01-01T00:00:00Z",
};

function prInspection(closingIssuesReferences: readonly number[]): PullRequestInspection {
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

async function runMergeSettleScenario(input: {
  readonly reviewSettleMs: number;
  readonly inspections: readonly PullRequestInspection[];
  readonly pauseAfterSleeps?: number;
}): Promise<{
  readonly prCalls: readonly string[];
  readonly sleeps: readonly number[];
  readonly trackerWrites: readonly string[];
  readonly eventTypes: readonly string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "symphony-orch-review-settle-"));
  const db = openSymphonyDatabase();
  const reviewIssue = { ...issue, state: "Merging" };
  const trackerWrites: string[] = [];
  const prCalls: string[] = [];
  const sleeps: number[] = [];
  const inspections = [...input.inspections];
  let orchestrator!: SymphonyOrchestrator;
  const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const tracker: TrackerAdapter = {
    fetchCandidateIssues: async () => [],
    fetchIssuesByStates: async (states) => (states.includes("Merging") ? [reviewIssue] : []),
    fetchIssueStatesByIds: async () => [],
    updateIssueState: async (_id, state) => {
      trackerWrites.push(`state:${state}`);
    },
  };
  const runner: AgentRunner = {
    kind: "fake",
    run: async () => {
      throw new Error("review settle should not respawn an agent");
    },
  };

  try {
    const workflow = parseWorkflowMarkdown(
      join(root, "WORKFLOW.md"),
      `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nagent:\n  review_settle_ms: ${input.reviewSettleMs}\nhooks:\n  after_run: echo validated\n---\nWork on {{ issue.identifier }}`,
    );
    const config = resolveWorkflowConfig(workflow);
    orchestrator = new SymphonyOrchestrator({
      workflow,
      config,
      tracker,
      workspaceManager: new GitWorkspaceManager(gitRunner),
      runner,
      db,
      evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
      workspaceMode: "clone",
      repoUrl: "git@example.com:repo.git",
      sleep: async (ms) => {
        sleeps.push(ms);
        if (input.pauseAfterSleeps === sleeps.length) orchestrator.pause();
      },
      prManager: {
        inspectPullRequest: async () => {
          prCalls.push("inspect");
          return inspections.shift() ?? input.inspections[input.inspections.length - 1] ?? prInspection([]);
        },
        mergePullRequest: async () => {
          prCalls.push("merge");
          return "merged";
        },
      },
    });

    await orchestrator.tick({ waitForCompletion: true });
    return {
      prCalls,
      sleeps,
      trackerWrites,
      eventTypes: db.listEvents({ issueId: reviewIssue.id }).map((event) => event.type),
    };
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("SymphonyOrchestrator", () => {
  test("does not redispatch failed Rework issues before retry backoff is due", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-retry-backoff-"));
    const db = openSymphonyDatabase();
    let runnerCalls = 0;
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [{ ...issue, state: runnerCalls === 0 ? "Todo" : "Rework" }],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async () => {},
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => {
        runnerCalls += 1;
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          error: "runner failed",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
      },
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  api_key: test
  project_slug: proj
workspace:
  root: ${JSON.stringify(join(root, "workspaces"))}
hooks:
  after_run: bun test
agent:
  max_retry_backoff_ms: 300000
---
Work on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
      });

      const first = await orchestrator.tick({ waitForCompletion: true });
      const second = await orchestrator.tick({ waitForCompletion: true });

      expect(first.dispatched).toBe(1);
      expect(second).toEqual({ dispatched: 0, runIds: [] });
      expect(runnerCalls).toBe(1);
      expect(db.listDueRetries(Date.now() + 1_000)).toHaveLength(0);
      expect(db.listRetryQueue()).toHaveLength(1);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("dispatches an issue through workspace, runner, evidence, PR, and tracker handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-"));
    const db = openSymphonyDatabase();
    const trackerWrites: string[] = [];
    const prCalls: string[] = [];
    let capturedPrBody = "";
    let capturedWorkpadBody = "";
    const gitRunner: CommandRunner = async (command) => {
      if (command[0] === "sh" && command[2]?.includes("bun test")) {
        return { exitCode: 0, stdout: "88 pass\n0 fail\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
      createOrUpdateWorkpad: async (_id, body) => {
        capturedWorkpadBody = body;
        trackerWrites.push(`workpad:${body.includes("Symphony run report")}`);
      },
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async ({ onEvent }) => {
        await onEvent?.({ type: "runner.started", message: "started", timestamp: new Date().toISOString() });
        return {
          ok: true,
          exitCode: 0,
          stdout: "validation ok",
          stderr: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          followUps: {
            unverified: ["local browser launch"],
            nextTime: ["sequence after ABC-2 lands"],
          },
        };
      },
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nhooks:\n  after_run: bun run typecheck && bun test\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          ensureBranch: async () => {
            prCalls.push("branch");
          },
          pushBranch: async () => {
            prCalls.push("push");
          },
          validateIssueExists: async () => true,
          ensurePullRequest: async (input) => {
            prCalls.push("pr");
            capturedPrBody = input.body;
            return "https://github.test/pr/1";
          },
        },
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      expect(result.dispatched).toBe(1);
      const run = db.getRun(result.runIds[0]!);
      expect(run?.status).toBe("succeeded");
      expect(trackerWrites).toEqual(["state:In Progress", "workpad:true", "state:Human Review"]);
      expect(prCalls).toEqual(["branch", "push", "pr"]);
      expect(capturedPrBody).toContain("## Summary");
      expect(capturedPrBody).toContain("## Linked issues");
      expect(capturedPrBody).toContain("## Verification");
      expect(capturedPrBody).toContain("- `bun run typecheck && bun test` → exit 0");
      expect(capturedPrBody).toContain("88 pass / 0 fail");
      expect(capturedPrBody).toContain("Closes ABC-1");
      expect(capturedPrBody).toContain("Closes #1");
      expect(capturedPrBody).not.toContain("What could not be verified");
      expect(capturedPrBody).not.toContain("What's needed next time");
      expect(capturedWorkpadBody).toContain("ABC-1 — Symphony run report");
      expect(capturedWorkpadBody).toContain("**PR:** [ABC-1: Do work](https://github.test/pr/1)");
      expect(capturedWorkpadBody).toContain("- verified: `bun run typecheck && bun test` → exit 0");
      expect(capturedWorkpadBody).toContain("**What could not be verified**\n- local browser launch");
      expect(capturedWorkpadBody).toContain("**What's needed next time**\n- sequence after ABC-2 lands");
      expect(db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type)).toContain("run.succeeded");
      expect(db.listEvidence(result.runIds[0]!)).toHaveLength(1);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs configured PR self-review before moving to human review", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-self-review-pass-"));
    const db = openSymphonyDatabase();
    const trackerWrites: string[] = [];
    const commands: string[] = [];
    const prCalls: string[] = [];
    const gitRunner: CommandRunner = async (command, options) => {
      commands.push(command.join(" "));
      const script = command[2] ?? "";
      if (command[0] === "sh" && script.includes("review:pr")) {
        expect(options.env?.SYMPHONY_PR_URL).toBe("https://github.test/pr/11");
        expect(options.env?.SYMPHONY_BRANCH_NAME).toBe("symphony/ABC-1");
        return { exitCode: 0, stdout: "P3: consider a later docs polish\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    };
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
      createOrUpdateWorkpad: async () => {
        trackerWrites.push("workpad:true");
      },
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({
        ok: true,
        exitCode: 0,
        stdout: "implementation done",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }),
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  api_key: test
  project_slug: proj
workspace:
  root: ${JSON.stringify(join(root, "workspaces"))}
hooks:
  after_run: bun test
review:
  self:
    command: bun run review:pr
    blocking_severities:
      - P0
      - P1
      - P2
---
Work on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          ensureBranch: async () => {
            prCalls.push("branch");
          },
          pushBranch: async () => {
            prCalls.push("push");
          },
          ensurePullRequest: async () => {
            prCalls.push("pr");
            return "https://github.test/pr/11";
          },
          inspectPullRequest: async () => {
            prCalls.push("inspect");
            return prInspection([]);
          },
        },
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      const run = db.getRun(result.runIds[0]!);
      const eventTypes = db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type);
      const evidence = db.listEvidence(result.runIds[0]!);

      expect(run?.status).toBe("succeeded");
      expect(trackerWrites).toEqual(["state:In Progress", "workpad:true", "state:Human Review"]);
      expect(commands).toContain("sh -c bun run review:pr");
      expect(prCalls).toEqual(["branch", "push", "pr", "inspect", "inspect"]);
      expect(eventTypes).toContain("pr.self_review.started");
      expect(eventTypes).toContain("pr.self_review.passed");
      expect(evidence.some((artifact) => artifact.label === "PR self-review")).toBe(true);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks the run in Rework when PR self-review reports blocking findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-self-review-block-"));
    const db = openSymphonyDatabase();
    const trackerWrites: string[] = [];
    const prompts: string[] = [];
    let issueState = "Todo";
    let inspectCount = 0;
    const gitRunner: CommandRunner = async (command) => {
      if (command[0] === "sh" && command[2]?.includes("review:pr")) {
        return { exitCode: 0, stdout: "review complete\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    };
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [{ ...issue, state: issueState }],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
        issueState = state;
      },
      createOrUpdateWorkpad: async () => {
        trackerWrites.push("workpad:true");
      },
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          ok: true,
          exitCode: 0,
          stdout: "implementation done",
          stderr: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
      },
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  api_key: test
  project_slug: proj
workspace:
  root: ${JSON.stringify(join(root, "workspaces"))}
hooks:
  after_run: bun test
review:
  self:
    command: bun run review:pr
---
Work on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          ensureBranch: async () => {},
          pushBranch: async () => {},
          ensurePullRequest: async () => "https://github.test/pr/12",
          inspectPullRequest: async () => {
            inspectCount += 1;
            return {
              ...prInspection([]),
              findings: inspectCount <= 2
                ? [{ severity: "P1", source: "self-review", message: "Add a regression test before merge." }]
                : [],
            };
          },
        },
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      const run = db.getRun(result.runIds[0]!);
      const eventTypes = db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type);
      const evidence = db.listEvidence(result.runIds[0]!);

      expect(run?.status).toBe("review_blocked");
      expect(run?.lastError).toContain("PR self-review found blocking feedback");
      expect(trackerWrites).toEqual(["state:In Progress", "workpad:true", "state:Rework"]);
      expect(eventTypes).toContain("pr.self_review.blocked");
      expect(eventTypes).toContain("run.review_blocked");
      expect(eventTypes).not.toContain("run.succeeded");
      expect(evidence.some((artifact) => artifact.label === "PR self-review")).toBe(true);
      expect(db.listDueRetries(Date.now() + 1_000)).toHaveLength(1);

      const reworkResult = await orchestrator.tick({ waitForCompletion: true });
      expect(reworkResult.dispatched).toBe(1);
      expect(prompts[1]).toContain("## Pull Request Review Feedback");
      expect(prompts[1]).toContain("Add a regression test before merge.");
      expect(db.getRun(reworkResult.runIds[0]!)?.status).toBe("succeeded");
      expect(db.listDueRetries(Date.now() + 1_000)).toHaveLength(0);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails the run when a required in-progress tracker state write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-tracker-required-"));
    const db = openSymphonyDatabase();
    const trackerWrites: string[] = [];
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(state);
        if (state === "In Progress") throw new Error("Linear state update failed");
      },
      createOrUpdateWorkpad: async () => {},
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => {
        throw new Error("runner should not start when required tracker write fails");
      },
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nhooks:\n  after_run: echo validated\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      const events = db.listEvents({ runId: result.runIds[0]! });
      expect(db.getRun(result.runIds[0]!)?.status).toBe("failed");
      expect(trackerWrites).toEqual(["In Progress", "Rework"]);
      expect(events.map((event) => event.type)).toContain("tracker.state_update_failed");
      expect(events.find((event) => event.type === "tracker.state_update_failed")?.payload).toMatchObject({
        stateName: "In Progress",
        policy: "required",
        operation: "updateIssueState",
      });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes a detected PR template into the PR body builder", async () => {
    class TemplateWorkspaceManager extends GitWorkspaceManager {
      override async readPrTemplate(): Promise<PrTemplate | null> {
        return {
          raw: "",
          sections: [
            { header: "Description", body: "Template description" },
            { header: "Testing", body: "Template testing" },
          ],
        };
      }
    }

    const root = await mkdtemp(join(tmpdir(), "symphony-orch-template-"));
    const db = openSymphonyDatabase();
    let capturedPrBody = "";
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async () => {},
      createOrUpdateWorkpad: async () => {},
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }),
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nhooks:\n  after_run: echo validated\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new TemplateWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          validateIssueExists: async () => false,
          ensurePullRequest: async (input) => {
            capturedPrBody = input.body;
            return "https://github.test/pr/1";
          },
        },
      });

      await orchestrator.tick({ waitForCompletion: true });

      expect(capturedPrBody).toContain("## Description\n- files changed: 0 | +0 / -0");
      expect(capturedPrBody).toContain("## Testing\n- `echo validated` → exit 0");
      expect(capturedPrBody).toContain("## Linked issues\nCloses ABC-1");
      expect(capturedPrBody).not.toContain("Template description");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not repair PR metadata when GitHub parsed the closing reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-metadata-ok-"));
    const db = openSymphonyDatabase();
    const prCalls: string[] = [];
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async () => {},
      createOrUpdateWorkpad: async () => {},
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }),
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nhooks:\n  after_run: echo validated\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          validateIssueExists: async () => true,
          ensurePullRequest: async () => "https://github.test/pr/1",
          inspectPullRequest: async () => {
            prCalls.push("inspect");
            return prInspection([1]);
          },
          editPullRequestBody: async () => {
            prCalls.push("edit");
          },
        },
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      expect(db.getRun(result.runIds[0]!)?.status).toBe("succeeded");
      expect(prCalls).toEqual(["inspect"]);
      expect(db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type)).not.toContain("pr.metadata_repaired");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repairs PR metadata when the first inspection misses the closing reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-metadata-repair-"));
    const db = openSymphonyDatabase();
    const inspections = [prInspection([]), prInspection([1])];
    const prCalls: string[] = [];
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async () => {},
      createOrUpdateWorkpad: async () => {},
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }),
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nhooks:\n  after_run: echo validated\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          validateIssueExists: async () => true,
          ensurePullRequest: async () => "https://github.test/pr/1",
          inspectPullRequest: async () => {
            prCalls.push("inspect");
            return inspections.shift() ?? prInspection([1]);
          },
          editPullRequestBody: async (input) => {
            prCalls.push("edit");
            expect(input.body).toContain("Closes #1");
          },
        },
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      expect(db.getRun(result.runIds[0]!)?.status).toBe("succeeded");
      expect(prCalls).toEqual(["inspect", "edit", "inspect"]);
      expect(db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type)).toContain("pr.metadata_repaired");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails the run when one PR metadata repair attempt still misses the closing reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-metadata-fail-"));
    const db = openSymphonyDatabase();
    const prCalls: string[] = [];
    const trackerWrites: string[] = [];
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
      createOrUpdateWorkpad: async () => {},
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }),
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nhooks:\n  after_run: echo validated\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          validateIssueExists: async () => true,
          ensurePullRequest: async () => "https://github.test/pr/1",
          inspectPullRequest: async () => {
            prCalls.push("inspect");
            return prInspection([]);
          },
          editPullRequestBody: async () => {
            prCalls.push("edit");
          },
        },
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      expect(db.getRun(result.runIds[0]!)?.status).toBe("failed");
      expect(trackerWrites).toEqual(["state:In Progress", "state:Rework"]);
      expect(prCalls).toEqual(["inspect", "edit", "inspect"]);
      expect(db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type)).toContain("pr.metadata_repair_failed");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures required UI evidence artifacts before handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-ui-evidence-"));
    const db = openSymphonyDatabase();
    const uiIssue = { ...issue, labels: ["ui"] };
    const trackerWrites: string[] = [];
    const gitRunner: CommandRunner = async (command, options) => {
      if (command.join(" ").includes("evidence:ui")) {
        const outputDir = options.env?.SYMPHONY_EVIDENCE_DIR;
        expect(outputDir).toBeTruthy();
        await mkdir(outputDir!, { recursive: true });
        await writeFile(join(outputDir!, "ui-proof.webm"), "video");
        await writeFile(join(outputDir!, "final-state.png"), "png");
        await writeFile(join(outputDir!, "playwright-output.txt"), "ok");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [uiIssue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
      createOrUpdateWorkpad: async () => {
        trackerWrites.push("workpad");
      },
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({
        ok: true,
        exitCode: 0,
        stdout: "runner ok",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }),
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  api_key: test
  project_slug: proj
workspace:
  root: ${JSON.stringify(join(root, "workspaces"))}
hooks:
  after_run: echo validated
evidence:
  ui:
    required_for_labels: [ui]
    command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR"
    required_artifacts:
      - kind: video
        glob: "*.webm"
      - kind: screenshot
        glob: "*.png"
      - kind: test-output
        glob: "*.txt"
---
Work on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      const evidence = db.listEvidence(result.runIds[0]!);
      expect(db.getRun(result.runIds[0]!)?.status).toBe("succeeded");
      expect(evidence.map((artifact) => artifact.kind).sort()).toEqual(["log", "screenshot", "test-output", "video"]);
      expect(db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type)).toContain("evidence.ui.passed");
      expect(trackerWrites).toContain("state:Human Review");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails and retries when required UI evidence is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-ui-evidence-missing-"));
    const db = openSymphonyDatabase();
    const uiIssue = { ...issue, labels: ["frontend"] };
    const trackerWrites: string[] = [];
    const gitRunner: CommandRunner = async (_command, options) => {
      if (options.env?.SYMPHONY_EVIDENCE_DIR) {
        await mkdir(options.env.SYMPHONY_EVIDENCE_DIR, { recursive: true });
        await writeFile(join(options.env.SYMPHONY_EVIDENCE_DIR, "final-state.png"), "png");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [uiIssue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
      createOrUpdateWorkpad: async () => {
        trackerWrites.push("workpad");
      },
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({
        ok: true,
        exitCode: 0,
        stdout: "runner ok",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }),
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  api_key: test
  project_slug: proj
workspace:
  root: ${JSON.stringify(join(root, "workspaces"))}
hooks:
  after_run: echo validated
evidence:
  ui:
    required_for_labels: [frontend]
    command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR"
    required_artifacts:
      - kind: video
        glob: "*.webm"
      - kind: screenshot
        glob: "*.png"
---
Work on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      const run = db.getRun(result.runIds[0]!);
      expect(run?.status).toBe("failed");
      expect(run?.lastError).toContain("Required UI evidence missing: video:*.webm");
      expect(trackerWrites).toEqual(["state:In Progress", "state:Rework"]);
      expect(db.listDueRetries(Date.now() + 60_000)).toHaveLength(1);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips validation and UI evidence when runner fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-runner-fail-"));
    const db = openSymphonyDatabase();
    const uiIssue = { ...issue, labels: ["ui"] };
    const commands: string[] = [];
    const trackerWrites: string[] = [];
    const gitRunner: CommandRunner = async (command) => {
      commands.push(command.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [uiIssue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({
        ok: false,
        exitCode: 1,
        error: "runner failed before handoff",
        stdout: "partial",
        stderr: "boom",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }),
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  api_key: test
  project_slug: proj
workspace:
  root: ${JSON.stringify(join(root, "workspaces"))}
hooks:
  after_run: echo should-not-run
evidence:
  ui:
    required_for_labels: [ui]
    command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR"
    required_artifacts:
      - kind: video
        glob: "*.webm"
---
Work on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      const run = db.getRun(result.runIds[0]!);
      const eventTypes = db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type);
      expect(run?.status).toBe("failed");
      expect(run?.lastError).toBe("runner failed before handoff");
      expect(commands.some((command) => command.includes("should-not-run"))).toBe(false);
      expect(commands.some((command) => command.includes("evidence:ui"))).toBe(false);
      expect(eventTypes).not.toContain("validation.passed");
      expect(eventTypes).not.toContain("evidence.ui.passed");
      expect(trackerWrites).toEqual(["state:In Progress", "state:Rework"]);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("respawns an agent for blocking P0-P2 pull request findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-pr-rework-"));
    const db = openSymphonyDatabase();
    const reviewIssue = { ...issue, state: "Human Review" };
    const trackerWrites: string[] = [];
    const prompts: string[] = [];
    const prCalls: string[] = [];
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => {
        throw new Error("review feedback should be processed before new candidate dispatch");
      },
      fetchIssuesByStates: async (states) => (states.includes("Human Review") ? [reviewIssue] : []),
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
      createOrUpdateWorkpad: async (_id, body) => {
        trackerWrites.push(`workpad:${body.includes("https://github.test/pr/7")}`);
      },
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          ok: true,
          exitCode: 0,
          stdout: "fixed review feedback",
          stderr: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
      },
    };
    const inspection: PullRequestInspection = {
      url: "https://github.test/pr/7",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      checksStatus: "passing",
      mergeable: true,
      isDraft: false,
      closingIssuesReferences: [],
      findings: [{ severity: "P1", source: "reviewer", message: "Fix the missing regression test." }],
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nhooks:\n  after_run: echo validated\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          inspectPullRequest: async () => {
            prCalls.push("inspect");
            return inspection;
          },
          ensureBranch: async () => {
            prCalls.push("branch");
          },
          pushBranch: async () => {
            prCalls.push("push");
          },
          ensurePullRequest: async () => {
            prCalls.push("pr");
            return inspection.url;
          },
        },
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      expect(result.dispatched).toBe(1);
      expect(prompts[0]).toContain("## Pull Request Review Feedback");
      expect(prompts[0]).toContain("P1 (reviewer): Fix the missing regression test.");
      expect(trackerWrites).toEqual(["state:Rework", "state:In Progress", "workpad:true", "state:Human Review"]);
      expect(prCalls).toEqual(["inspect", "branch", "push", "pr", "inspect"]);
      expect(db.listEvents({ issueId: reviewIssue.id }).map((event) => event.type)).toContain("pr.inspected");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("merges an approved passing pull request and marks the issue done", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-pr-merge-"));
    const db = openSymphonyDatabase();
    const reviewIssue = { ...issue, state: "Human Review" };
    const trackerWrites: string[] = [];
    const prCalls: string[] = [];
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [],
      fetchIssuesByStates: async (states) => (states.includes("Human Review") ? [reviewIssue] : []),
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
    };
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => {
        throw new Error("clean approved PRs should merge without respawning an agent");
      },
    };
    const inspection: PullRequestInspection = {
      url: "https://github.test/pr/8",
      state: "OPEN",
      reviewDecision: "APPROVED",
      checksStatus: "passing",
      mergeable: true,
      isDraft: false,
      closingIssuesReferences: [],
      findings: [],
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nhooks:\n  after_run: echo validated\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
        prManager: {
          inspectPullRequest: async () => {
            prCalls.push("inspect");
            return inspection;
          },
          mergePullRequest: async () => {
            prCalls.push("merge");
            return "merged";
          },
        },
      });

      const result = await orchestrator.tick({ waitForCompletion: true });
      expect(result).toEqual({ dispatched: 0, runIds: [] });
      expect(trackerWrites).toEqual(["state:Merging", "state:Done"]);
      expect(prCalls).toEqual(["inspect", "merge"]);
      expect(db.listEvents({ issueId: reviewIssue.id }).map((event) => event.type)).toContain("pr.merged");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("review settle waits through a clean window before merging", async () => {
    const clean = prInspection([]);
    const result = await runMergeSettleScenario({
      reviewSettleMs: 120_000,
      inspections: [clean, clean, clean, clean, clean],
    });

    expect(result.sleeps).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(result.prCalls).toEqual(["inspect", "inspect", "inspect", "inspect", "inspect", "merge"]);
    expect(result.trackerWrites).toEqual(["state:Done"]);
    expect(result.eventTypes).toContain("pr.merged");
  });

  test("review settle aborts when changes are requested during the window", async () => {
    const clean = prInspection([]);
    const changesRequested: PullRequestInspection = {
      ...prInspection([]),
      reviewDecision: "CHANGES_REQUESTED",
      findings: [{ severity: "P1", source: "reviewer", message: "Fix the missing regression test." }],
    };
    const result = await runMergeSettleScenario({
      reviewSettleMs: 120_000,
      inspections: [clean, clean, clean, clean, changesRequested],
    });

    expect(result.sleeps).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(result.prCalls).toEqual(["inspect", "inspect", "inspect", "inspect", "inspect"]);
    expect(result.trackerWrites).toEqual(["state:Rework"]);
    expect(result.eventTypes).toContain("pr.review_changes_requested");
    expect(result.eventTypes).not.toContain("pr.merged");
  });

  test("review settle aborts when blocking review findings land during the window", async () => {
    const clean = prInspection([]);
    const automatedFinding: PullRequestInspection = {
      ...prInspection([]),
      findings: [{ severity: "P2", source: "coderabbit", message: "Handle the async stale-response path." }],
    };
    const result = await runMergeSettleScenario({
      reviewSettleMs: 120_000,
      inspections: [clean, automatedFinding],
    });

    expect(result.sleeps).toEqual([30_000]);
    expect(result.prCalls).toEqual(["inspect", "inspect"]);
    expect(result.trackerWrites).toEqual(["state:Rework"]);
    expect(result.eventTypes).toContain("pr.review_changes_requested");
    expect(result.eventTypes).not.toContain("pr.merged");
  });

  test("review settle short-circuits when approval lands", async () => {
    const clean = prInspection([]);
    const approved: PullRequestInspection = { ...prInspection([]), reviewDecision: "APPROVED" };
    const result = await runMergeSettleScenario({
      reviewSettleMs: 240_000,
      inspections: [clean, clean, approved],
    });

    expect(result.sleeps).toEqual([30_000, 30_000]);
    expect(result.prCalls).toEqual(["inspect", "inspect", "inspect", "merge"]);
    expect(result.trackerWrites).toEqual(["state:Done"]);
    expect(result.eventTypes).toContain("pr.merged");
  });

  test("review settle cancels when pause-and-drain pauses the orchestrator", async () => {
    const clean = prInspection([]);
    const result = await runMergeSettleScenario({
      reviewSettleMs: 120_000,
      inspections: [clean],
      pauseAfterSleeps: 1,
    });

    expect(result.sleeps).toEqual([30_000]);
    expect(result.prCalls).toEqual(["inspect"]);
    expect(result.trackerWrites).toEqual([]);
    expect(result.eventTypes).toContain("pr.review_settle_cancelled");
    expect(result.eventTypes).not.toContain("pr.merged");
  });

  test("review settle opt-out preserves immediate merge behavior", async () => {
    const clean = prInspection([]);
    const result = await runMergeSettleScenario({
      reviewSettleMs: 0,
      inspections: [clean],
    });

    expect(result.sleeps).toEqual([]);
    expect(result.prCalls).toEqual(["inspect", "merge"]);
    expect(result.trackerWrites).toEqual(["state:Done"]);
    expect(result.eventTypes).toContain("pr.merged");
  });

  test("review settle aborts when checks regress during the window", async () => {
    const clean = prInspection([]);
    const checksFailed: PullRequestInspection = { ...prInspection([]), checksStatus: "failing" };
    const result = await runMergeSettleScenario({
      reviewSettleMs: 120_000,
      inspections: [clean, checksFailed],
    });

    expect(result.sleeps).toEqual([30_000]);
    expect(result.prCalls).toEqual(["inspect", "inspect"]);
    expect(result.trackerWrites).toEqual(["state:Rework"]);
    expect(result.eventTypes).toContain("pr.checks_regressed");
    expect(result.eventTypes).not.toContain("pr.merged");
  });

  test("concurrency cap: total in-flight runs never exceed maxConcurrentAgents across two ticks", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-concurrency-"));
    const db = openSymphonyDatabase();
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    // Two issues available; cap is 1.
    const issues = [
      { ...issue, id: "issue-1", identifier: "ABC-1" },
      { ...issue, id: "issue-2", identifier: "ABC-2" },
    ];

    // Instant runner — resolves immediately so we don't need to juggle promises.
    // The key observation is that runningIssueIds is incremented synchronously before
    // the runner fires and decremented in finally. We measure between tick1 return and tick2.
    const runner: AgentRunner = {
      kind: "fake",
      run: async () => ({
        ok: false,
        exitCode: 1,
        error: "simulated fail",
        stdout: "",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }),
    };
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => issues,
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
    };

    try {
      const workflow = parseWorkflowMarkdown(
        join(root, "WORKFLOW.md"),
        `---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj\nworkspace:\n  root: ${JSON.stringify(join(root, "workspaces"))}\nagent:\n  max_concurrent_agents: 1\nhooks:\n  after_run: echo ok\n---\nWork on {{ issue.identifier }}`,
      );
      const config = resolveWorkflowConfig(workflow);
      const orchestrator = new SymphonyOrchestrator({
        workflow,
        config,
        tracker,
        workspaceManager: new GitWorkspaceManager(gitRunner),
        runner,
        db,
        evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
        workspaceMode: "clone",
        repoUrl: "git@example.com:repo.git",
      });

      // Tick 1 with waitForCompletion=true completes the first dispatch fully.
      const tick1Result = await orchestrator.tick({ waitForCompletion: true });
      expect(tick1Result.dispatched).toBe(1);
      // After tick1 completes, runningIssueIds should be 0 (finally block ran).
      const inFlightAfterTick1 = (orchestrator as unknown as { runningIssueIds: Set<string> }).runningIssueIds.size;
      expect(inFlightAfterTick1).toBe(0);

      // Both issues are now released (first claim finished). Tick 2 should dispatch issue-2.
      // This verifies that the cap logic correctly uses runningIssueIds.size (0 here) not a stale count.
      const tick2Result = await orchestrator.tick({ waitForCompletion: true });
      // issue-2 was not in-flight during tick1, so tick2 should pick it up.
      expect(tick2Result.dispatched).toBe(1);

      // Total runs ever in-flight = 1 at a time, never > maxConcurrentAgents.
      const runs = db.listRuns(10);
      // Each run was dispatched serially — exactly 2 runs total (one per issue).
      expect(runs).toHaveLength(2);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
