#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openSymphonyDatabase } from "@symphony/db";
import { EvidenceStore } from "@symphony/evidence";
import { SymphonyOrchestrator } from "@symphony/orchestrator";
import { createCodexRunner, createPiRunner } from "@symphony/runner";
import { LinearTrackerAdapter } from "@symphony/tracker-linear";
import { loadWorkflowFile, resolveWorkflowConfig, validateDispatchConfig } from "@symphony/workflow";
import { GitHubPrManager, GitWorkspaceManager, defaultCommandRunner } from "@symphony/workspace-git";
import { startServer } from "@symphony/server";
import { logger } from "./logger.js";

function usage(): string {
  return `Usage: symphony <command> [WORKFLOW.md] [flags]

Commands:
  validate [WORKFLOW.md]   Validate workflow and print resolved config summary
  tick [WORKFLOW.md]       Run one poll/dispatch tick
  serve [WORKFLOW.md]      Start control plane server

Flags:
  --live-tracker          During validate, call Linear and verify project/state names exist

Env:
  LINEAR_API_KEY           Required for Linear dispatch
  SYMPHONY_AUTH_TOKEN      Bearer token required to authenticate API requests
  SYMPHONY_ALLOW_INSECURE  Set to "true" or "1" to start server without auth token
  SYMPHONY_DB_PATH         SQLite path (default ./.symphony/symphony.db)
  SYMPHONY_EVIDENCE_DIR    Evidence directory (default ./.symphony/evidence)
  SYMPHONY_RUNNER          codex | pi (default codex)
  SYMPHONY_CODEX_COMMAND   Codex command (default codex exec --skip-git-repo-check --sandbox workspace-write -)
  SYMPHONY_PI_COMMAND      Pi command (default pi --print)
  SYMPHONY_REPO_URL        Required for clone workspace mode
  SYMPHONY_SOURCE_REPO     Source repo for worktree mode (default cwd)
  SYMPHONY_WORKSPACE_MODE  worktree | clone (default worktree)
`;
}

// P2-B: buildConfig loads workflow + config + validates — no DB open.
async function buildConfig(workflowPath: string) {
  const workflow = await loadWorkflowFile(workflowPath);
  const config = resolveWorkflowConfig(workflow);
  const errors = validateDispatchConfig(config);
  return { workflow, config, errors };
}

// P2-A: pull DB and evidence paths from env so they are overridable.
function resolveDbPath(): string {
  return resolve(process.env.SYMPHONY_DB_PATH ?? ".symphony/symphony.db");
}

function resolveEvidenceDir(): string {
  return resolve(process.env.SYMPHONY_EVIDENCE_DIR ?? ".symphony/evidence");
}

// buildRuntime opens DB + creates evidenceStore + orchestrator. Used by tick and serve.
async function buildRuntime(workflowPath: string) {
  const { workflow, config, errors } = await buildConfig(workflowPath);

  const dbPath = resolveDbPath();
  await mkdir(dirname(dbPath), { recursive: true });
  const db = openSymphonyDatabase({ path: dbPath });

  const evidenceRoot = resolveEvidenceDir();
  await mkdir(evidenceRoot, { recursive: true });

  const runnerKind = process.env.SYMPHONY_RUNNER ?? "codex";
  const runner =
    runnerKind === "pi"
      ? createPiRunner(process.env.SYMPHONY_PI_COMMAND ?? "pi --print")
      : createCodexRunner(process.env.SYMPHONY_CODEX_COMMAND ?? config.codex.command);

  const orchestrator = new SymphonyOrchestrator({
    workflow,
    config,
    tracker: new LinearTrackerAdapter(config.tracker),
    workspaceManager: new GitWorkspaceManager(defaultCommandRunner),
    runner,
    db,
    evidenceStore: new EvidenceStore({ root: evidenceRoot }),
    prManager: new GitHubPrManager({ runner: defaultCommandRunner }),
    workspaceMode: process.env.SYMPHONY_WORKSPACE_MODE === "clone" ? "clone" : "worktree",
    sourceRepoPath: process.env.SYMPHONY_SOURCE_REPO ?? process.cwd(),
    ...(process.env.SYMPHONY_REPO_URL ? { repoUrl: process.env.SYMPHONY_REPO_URL } : {}),
    baseRef: process.env.SYMPHONY_BASE_REF ?? "HEAD",
  });

  orchestrator.recoverInterruptedRuns();
  return { workflow, config, errors, db, orchestrator };
}

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const workflowArg = args.slice(1).find((arg) => !arg.startsWith("--")) ?? "WORKFLOW.md";

function requiredLinearStates(
  config: Awaited<ReturnType<typeof buildRuntime>>["config"],
): string[] {
  return [
    ...config.tracker.activeStates,
    ...config.tracker.terminalStates,
    config.states.inProgress,
    config.states.humanReview,
    config.states.rework,
    config.states.merging,
    config.states.done,
  ];
}

async function validateLiveTracker(
  config: Awaited<ReturnType<typeof buildRuntime>>["config"],
): Promise<{ liveTracker: unknown; liveErrors: string[] }> {
  const tracker = new LinearTrackerAdapter(config.tracker);
  const preflight = await tracker.preflight(requiredLinearStates(config));
  const liveErrors: string[] = [];
  if (!preflight.project)
    liveErrors.push(`Linear project_slug not found: ${config.tracker.projectSlug}`);
  for (const state of preflight.missingStates)
    liveErrors.push(
      `Linear workflow state not found for project ${config.tracker.projectSlug}: ${state}`,
    );
  return { liveTracker: preflight, liveErrors };
}

// P1-B: explicit known-command guard — catches unknown commands before any if-chain.
const KNOWN = new Set(["help", "--help", "-h", "validate", "tick", "serve"]);

try {
  if (!KNOWN.has(command)) {
    process.stderr.write(usage() + "\n");
    process.exit(1);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    // P1-A: usage IS the result — write to stdout so it is pipeable.
    process.stdout.write(usage() + "\n");
    process.exit(0);
  }

  // P2-B: validate uses buildConfig only — no DB open needed.
  if (command === "validate") {
    const { workflow, config, errors } = await buildConfig(workflowArg);
    let liveTracker: unknown = undefined;
    const liveErrors: string[] = [];

    if (flags.has("--live-tracker") && errors.length === 0) {
      const result = await validateLiveTracker(config);
      liveTracker = result.liveTracker;
      liveErrors.push(...result.liveErrors);
    }

    // P1-A: result JSON goes to stdout.
    process.stdout.write(
      JSON.stringify(
        {
          workflow: workflow.path,
          tracker: {
            kind: config.tracker.kind,
            endpoint: config.tracker.endpoint,
            projectSlug: config.tracker.projectSlug,
            hasApiKey: Boolean(config.tracker.apiKey),
          },
          workspace: config.workspace,
          server: config.server,
          dispatchReady: errors.length === 0 && liveErrors.length === 0,
          dispatchErrors: [...errors, ...liveErrors],
          ...(liveTracker !== undefined ? { liveTracker } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(errors.length === 0 && liveErrors.length === 0 ? 0 : 1);
  }

  if (command === "tick") {
    const { errors, config, db, orchestrator } = await buildRuntime(workflowArg);
    const liveErrors =
      errors.length === 0 ? (await validateLiveTracker(config)).liveErrors : [];
    if (errors.length > 0 || liveErrors.length > 0) {
      // P1-A: validation errors go to stderr as structured log.
      logger.error("cli.validation_failed", { errors: [...errors, ...liveErrors] });
      db.close();
      process.exit(1);
    }
    const result = await orchestrator.tick({ waitForCompletion: true });
    // P1-A: tick result is stdout JSON.
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    db.close();
    process.exit(0);
  }

  if (command === "serve") {
    // P1-C: read allowInsecure from env.
    const allowInsecure =
      process.env.SYMPHONY_ALLOW_INSECURE === "true" ||
      process.env.SYMPHONY_ALLOW_INSECURE === "1";
    const hasAuthToken = Boolean(process.env.SYMPHONY_AUTH_TOKEN);

    // P1-C: warn and bail if neither auth mechanism is configured.
    if (!hasAuthToken && !allowInsecure) {
      logger.warn("server.no_auth_no_insecure", {
        hint: "set SYMPHONY_AUTH_TOKEN or SYMPHONY_ALLOW_INSECURE=true",
      });
      process.exit(1);
    }

    const { errors, config, db, orchestrator } = await buildRuntime(workflowArg);
    const liveErrors =
      errors.length === 0 ? (await validateLiveTracker(config)).liveErrors : [];
    for (const error of [...errors, ...liveErrors]) {
      db.appendEvent({ level: "error", type: "config.validation_error", message: error });
    }
    if (errors.length > 0 || liveErrors.length > 0) {
      // P1-A: validation errors go to stderr as structured log.
      logger.error("cli.validation_failed", { errors: [...errors, ...liveErrors] });
      db.close();
      process.exit(1);
    }

    const port = config.server.port ?? 7331;
    // P1-C: pass allowInsecure to startServer (Engineer D wires the field).
    const server = startServer({
      db,
      orchestrator,
      port,
      host: config.server.host,
      ...(process.env.SYMPHONY_AUTH_TOKEN ? { token: process.env.SYMPHONY_AUTH_TOKEN } : {}),
      allowInsecure,
    });

    // P1-A: server startup message goes to stderr as structured log.
    logger.info("server.listening", { url: `http://${server.hostname}:${server.port}` });

    let tickInFlight = false;
    const runScheduledTick = () => {
      if (tickInFlight) return;
      tickInFlight = true;
      orchestrator
        .tick()
        .catch((error) => {
          db.appendEvent({
            level: "error",
            type: "orchestrator.tick_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          tickInFlight = false;
        });
    };

    const interval = setInterval(runScheduledTick, config.polling.intervalMs);
    runScheduledTick();

    // P2-C: graceful shutdown with up-to-30s wait for in-flight tick.
    const shutdown = async () => {
      clearInterval(interval);
      const start = Date.now();
      while (tickInFlight && Date.now() - start < 30_000) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      server.stop();
      db.close();
      process.exit(0);
    };
    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // P1-A: fatal errors go to stderr as structured log.
  logger.error("cli.fatal", { message });
  process.exit(1);
}
