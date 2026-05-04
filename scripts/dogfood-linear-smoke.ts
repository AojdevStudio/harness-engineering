import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openSymphonyDatabase } from "@symphony/db";
import { EvidenceStore } from "@symphony/evidence";
import { SymphonyOrchestrator } from "@symphony/orchestrator";
import type { AgentRunner } from "@symphony/runner";
import { LinearTrackerAdapter } from "@symphony/tracker-linear";
import { parseWorkflowMarkdown, resolveWorkflowConfig, validateDispatchConfig } from "@symphony/workflow";
import { GitWorkspaceManager, type CommandRunner } from "@symphony/workspace-git";

const projectSlug = process.env.SYMPHONY_DOGFOOD_PROJECT_SLUG ?? "61056bfe6dc1";
const issueIdentifier = process.env.SYMPHONY_DOGFOOD_ISSUE_IDENTIFIER ?? "AOJ-577";

if (!process.env.LINEAR_API_KEY) {
  throw new Error("LINEAR_API_KEY is required");
}

const root = resolve(".symphony/dogfood-linear");
await mkdir(root, { recursive: true });

const workflow = parseWorkflowMarkdown(
  resolve("WORKFLOW.dogfood.md"),
  `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: ${projectSlug}
  active_states: [Todo]
  terminal_states: [Done, Closed, Canceled, Cancelled, Duplicate]
workspace:
  root: ${JSON.stringify(resolve(root, "workspaces"))}
hooks:
  after_run: echo dogfood validation passed
agent:
  max_concurrent_agents: 1
  max_retry_backoff_ms: 300000
states:
  in_progress: In Progress
  human_review: In Review
---
Dogfood smoke test for {{ issue.identifier }}: {{ issue.title }}.
`,
);
const config = resolveWorkflowConfig(workflow);
const errors = validateDispatchConfig(config);
if (errors.length) throw new Error(errors.join("\n"));

const db = openSymphonyDatabase({ path: resolve(root, "symphony.db") });
const commandRunner: CommandRunner = async (command, options) => {
  db.appendEvent({ type: "dogfood.command", message: command.join(" "), payload: { cwd: options.cwd } });
  return { exitCode: 0, stdout: "", stderr: "" };
};
const runner: AgentRunner = {
  kind: "dogfood-fake",
  async run(input) {
    await input.onEvent?.({ type: "runner.started", message: "dogfood fake runner started", timestamp: new Date().toISOString() });
    return {
      ok: true,
      exitCode: 0,
      stdout: `Dogfood runner handled ${input.issue.identifier}\nMETRIC total_tokens=11\n`,
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 11 },
    };
  },
};

const realTracker = new LinearTrackerAdapter(config.tracker);
const tracker = {
  fetchCandidateIssues: async () => {
    const issues = await realTracker.fetchCandidateIssues();
    return issues.filter((issue) => issue.identifier === issueIdentifier);
  },
  fetchIssuesByStates: (stateNames: readonly string[]) => realTracker.fetchIssuesByStates(stateNames),
  fetchIssueStatesByIds: (issueIds: readonly string[]) => realTracker.fetchIssueStatesByIds(issueIds),
  updateIssueState: (issueId: string, stateName: string) => realTracker.updateIssueState(issueId, stateName),
  createOrUpdateWorkpad: (issueId: string, body: string) => realTracker.createOrUpdateWorkpad(issueId, body),
};

const orchestrator = new SymphonyOrchestrator({
  workflow,
  config,
  tracker,
  workspaceManager: new GitWorkspaceManager(commandRunner),
  runner,
  db,
  evidenceStore: new EvidenceStore({ root: resolve(root, "evidence") }),
  workspaceMode: "clone",
  repoUrl: "https://example.com/symphony-smoke.git",
});

const result = await orchestrator.tick({ waitForCompletion: true });
console.log(JSON.stringify({ result, runs: db.listRuns(), events: db.listEvents({ limit: 50 }) }, null, 2));
db.close();
