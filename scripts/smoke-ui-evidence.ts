import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openSymphonyDatabase } from "@symphony/db";
import { EvidenceStore } from "@symphony/evidence";
import { SymphonyOrchestrator, type TrackerAdapter } from "@symphony/orchestrator";
import type { AgentRunner } from "@symphony/runner";
import { parseWorkflowMarkdown, resolveWorkflowConfig, validateDispatchConfig } from "@symphony/workflow";
import { GitWorkspaceManager, defaultCommandRunner, type CommandRunner } from "@symphony/workspace-git";

const repoRoot = resolve(".");
const smokeRoot = resolve(".symphony/smoke-runs/ui-evidence");
const root = process.env.SYMPHONY_UI_EVIDENCE_SMOKE_ROOT ? resolve(process.env.SYMPHONY_UI_EVIDENCE_SMOKE_ROOT) : join(smokeRoot, "latest");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const db = openSymphonyDatabase({ path: join(root, "symphony.db") });

const issue = {
  id: "issue-ui-smoke",
  identifier: "SMOKE-UI-1",
  title: "Prove real Playwright UI evidence capture",
  description: "Fake UI ticket for Symphony evidence smoke.",
  priority: 1,
  state: "Todo",
  labels: ["ui"],
  blockedBy: [],
  createdAt: new Date().toISOString(),
};

const commands: string[] = [];
const trackerWrites: string[] = [];

const commandRunner: CommandRunner = async (command, options) => {
  commands.push(command.join(" "));
  if (command[0] === "git" && command[1] === "clone") {
    const workspacePath = String(command[3]);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "fake-app.html"), html("Pending", issue.identifier), "utf8");
    return { exitCode: 0, stdout: "fake clone created workspace", stderr: "" };
  }
  if (command[0] === "git" && command[1] === "checkout") {
    return { exitCode: 0, stdout: "fake checkout", stderr: "" };
  }
  return defaultCommandRunner(command, options);
};

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
  kind: "fake-real-ui-smoke",
  run: async (input) => {
    await writeFile(join(input.workspacePath, "fake-app.html"), html("Done by agent", input.issue.identifier), "utf8");
    await input.onEvent?.({ type: "runner.fake_ui_change", message: "Updated fake browser page", timestamp: new Date().toISOString() });
    return {
      ok: true,
      exitCode: 0,
      stdout: "fake runner updated fake-app.html",
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
  project_slug: smoke
workspace:
  root: ${JSON.stringify(join(root, "workspaces"))}
hooks:
  after_run: grep -q 'Done by agent' fake-app.html
evidence:
  ui:
    required_for_labels: [ui]
    command: bun ${JSON.stringify(join(repoRoot, "scripts/playwright-ui-evidence-smoke.ts"))}
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
  const errors = validateDispatchConfig(config);
  if (errors.length) throw new Error(errors.join("\n"));

  const orchestrator = new SymphonyOrchestrator({
    workflow,
    config,
    tracker,
    workspaceManager: new GitWorkspaceManager(commandRunner),
    runner,
    db,
    evidenceStore: new EvidenceStore({ root: join(root, "evidence") }),
    workspaceMode: "clone",
    repoUrl: "fake://repo.git",
  });

  const tickResult = await orchestrator.tick({ waitForCompletion: true });
  const runId = tickResult.runIds[0];
  if (!runId) throw new Error("No run dispatched");
  const run = db.getRun(runId);
  const evidence = db.listEvidence(runId);
  const byKind = Object.fromEntries(await Promise.all(evidence.map(async (artifact) => [artifact.kind, { uri: artifact.uri, size: (await stat(artifact.uri)).size }])));
  const output = evidence.find((artifact) => artifact.kind === "test-output");
  const outputText = output ? await readFile(output.uri, "utf8") : "";

  if (run?.status !== "succeeded") throw new Error(`Run did not succeed: ${run?.status} ${run?.lastError}`);
  for (const kind of ["video", "screenshot", "test-output"]) {
    if (!byKind[kind]) throw new Error(`Missing ${kind} evidence`);
    if (byKind[kind].size <= 0) throw new Error(`${kind} evidence is empty`);
  }
  if (!outputText.includes("1 passed")) throw new Error("Playwright output did not report a passing browser test");

  const smokeResult = {
    ok: true,
    smokeRoot: root,
    run,
    trackerWrites,
    evidence: byKind,
    evidenceEvents: db.listEvents({ runId }).filter((event) => event.type.startsWith("evidence.")).map((event) => event.type),
    commands,
  };
  await writeFile(join(root, "result.json"), JSON.stringify(smokeResult, null, 2), "utf8");
  await copyConvenienceArtifacts(root, evidence);
  console.log(JSON.stringify(smokeResult, null, 2));
  console.log(`\nArtifacts:\n  ${join(root, "final-state.png")}\n  ${join(root, "ui-proof.webm")}\n  ${join(root, "playwright-output.txt")}\n  ${join(root, "result.json")}`);
} finally {
  db.close();
}

async function copyConvenienceArtifacts(root: string, evidence: readonly { readonly kind: string; readonly uri: string }[]): Promise<void> {
  for (const artifact of evidence) {
    if (artifact.kind === "video") await cp(artifact.uri, join(root, "ui-proof.webm"));
    if (artifact.kind === "screenshot") await cp(artifact.uri, join(root, "final-state.png"));
    if (artifact.kind === "test-output") await cp(artifact.uri, join(root, "playwright-output.txt"));
  }
}

function html(status: string, identifier: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Symphony UI Smoke</title>
<style>body{font-family:system-ui;margin:40px;background:#111;color:#f6f6f6}.card{border:1px solid #555;padding:24px;border-radius:16px;max-width:520px}.ok{color:#66ffa6}</style></head>
<body><main class="card"><p>Issue</p><h1 data-testid="issue">${identifier}</h1><p>Status</p><h2 class="ok" data-testid="status">${status}</h2></main></body></html>`;
}
