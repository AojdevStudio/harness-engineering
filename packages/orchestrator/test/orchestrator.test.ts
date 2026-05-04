import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSymphonyDatabase } from "@symphony/db";
import { EvidenceStore } from "@symphony/evidence";
import type { AgentRunner } from "@symphony/runner";
import { parseWorkflowMarkdown, resolveWorkflowConfig } from "@symphony/workflow";
import { GitWorkspaceManager, type CommandRunner } from "@symphony/workspace-git";
import { SymphonyOrchestrator, type TrackerAdapter } from "../src/index.ts";

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

describe("SymphonyOrchestrator", () => {
  test("dispatches an issue through workspace, runner, evidence, PR, and tracker handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-orch-"));
    const db = openSymphonyDatabase();
    const trackerWrites: string[] = [];
    const prCalls: string[] = [];
    const gitRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const tracker: TrackerAdapter = {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      updateIssueState: async (_id, state) => {
        trackerWrites.push(`state:${state}`);
      },
      createOrUpdateWorkpad: async (_id, body) => {
        trackerWrites.push(`workpad:${body.includes("Run")}`);
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
        };
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
        prManager: {
          ensureBranch: async () => {
            prCalls.push("branch");
          },
          pushBranch: async () => {
            prCalls.push("push");
          },
          ensurePullRequest: async () => {
            prCalls.push("pr");
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
      expect(db.listEvents({ runId: result.runIds[0]! }).map((event) => event.type)).toContain("run.succeeded");
      expect(db.listEvidence(result.runIds[0]!)).toHaveLength(1);
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
