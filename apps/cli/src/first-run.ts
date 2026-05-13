import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LinearTrackerAdapter } from "@symphony/tracker-linear";
import {
  loadWorkflowFile,
  resolveWorkflowConfig,
  validateDispatchConfig,
  type ResolvedWorkflowConfig,
} from "@symphony/workflow";

export type InitActionStatus =
  | "created"
  | "skipped"
  | "overwritten"
  | "would-create"
  | "would-overwrite";

export interface InitAction {
  readonly path: string;
  readonly status: InitActionStatus;
}

export interface InitOptions {
  readonly cwd?: string;
  readonly targetDir?: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface InitResult {
  readonly targetDir: string;
  readonly actions: readonly InitAction[];
  readonly next: readonly string[];
}

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly details?: unknown;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly workflowPath: string;
  readonly checks: readonly DoctorCheck[];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
  };
  readonly next: readonly string[];
}

export interface CliCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CliCommandRunner = (
  command: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number },
) => Promise<CliCommandResult>;

export interface DoctorOptions {
  readonly cwd?: string;
  readonly workflowPath?: string;
  readonly liveTracker?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly runner?: CliCommandRunner;
  readonly commandTimeoutMs?: number;
}

export function initUsage(): string {
  return `Usage: symphony init [DIR] [flags]

Create first-run Symphony files in DIR.

Flags:
  --force       Overwrite existing WORKFLOW.md and .env
  --dry-run     Print planned actions without writing files
`;
}

export function doctorUsage(): string {
  return `Usage: symphony doctor [WORKFLOW.md] [flags]

Check whether Symphony is ready to run against a real ticket.

Flags:
  --live-tracker    Call Linear and verify configured project/state names
`;
}

export function defaultEnvExample(): string {
  return `# Symphony first-run environment
# Copy this file to .env, then fill in the values for your target repo.

# Required for Linear-backed dispatch.
LINEAR_API_KEY=

# Required for authenticated API/dashboard use.
SYMPHONY_AUTH_TOKEN=

# Local-only escape hatch. Keep false unless you intentionally want unauthenticated API access.
SYMPHONY_ALLOW_INSECURE=false

# Local state paths.
SYMPHONY_DB_PATH=.symphony/symphony.db
SYMPHONY_EVIDENCE_DIR=.symphony/evidence

# Runner selection. Supported values: codex, pi.
SYMPHONY_RUNNER=codex
SYMPHONY_CODEX_COMMAND="codex exec --skip-git-repo-check --sandbox workspace-write -"
SYMPHONY_PI_COMMAND="pi --print"

# Workspace source. Use worktree for a local repo, clone for a remote repo URL.
SYMPHONY_WORKSPACE_MODE=worktree
SYMPHONY_SOURCE_REPO=
SYMPHONY_REPO_URL=

# Base ref for workspaces, PR targets, and handoff diffs. Set to main, develop, or another target repo ref.
SYMPHONY_BASE_REF=
`;
}

export function defaultWorkflowMarkdown(): string {
  return `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "REPLACE_WITH_LINEAR_PROJECT_SLUG"
  active_states:
    - Todo
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 30000
workspace:
  root: ./.symphony/workspaces
hooks:
  after_create: |
    bun install
  after_run: |
    bun run verify
  timeout_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 20
  review_settle_ms: 240000
codex:
  command: codex exec --skip-git-repo-check --sandbox workspace-write -
  turn_timeout_ms: 3600000
server:
  host: 127.0.0.1
  port: 7331
states:
  in_progress: In Progress
  human_review: Human Review
  rework: Rework
  merging: Merging
  done: Done
# UI evidence is opt-in. Uncomment this block after the target repo has an evidence script.
# evidence:
#   ui:
#     required_for_labels:
#       - ui
#       - frontend
#       - browser
#     command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR" --issue "$SYMPHONY_ISSUE_IDENTIFIER"
#     required_artifacts:
#       - kind: video
#         glob: "*.webm"
#       - kind: screenshot
#         glob: "*.png"
#       - kind: test-output
#         glob: "*.txt"
---

You are working on Linear issue {{ issue.identifier }}.

Title: {{ issue.title }}
State: {{ issue.state }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Rules:

- Work only in this workspace.
- Reproduce or inspect current behavior before editing.
- Implement the issue completely.
- Run validation before handoff.
- Commit your changes.
- Produce concise evidence in stdout/stderr or artifact files.
- Do not ask the human for follow-up unless blocked by missing credentials, permissions, or required secrets.
- At the very end of your final assistant message, include these optional marker blocks only when they have content.
- Use the unverified block for checks you could not perform, and the next-time block for concrete follow-up work the next agent should pick up.
- Omit a marker block entirely when it would be empty; do not emit empty marker blocks.

Optional final-message marker format:

\`\`\`
<!-- unverified -->
- <one bullet per thing you did NOT verify>
<!-- /unverified -->

<!-- next-time -->
- <one bullet per follow-up the next agent should pick up>
<!-- /next-time -->
\`\`\`
`;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const targetDir = resolvePath(cwd, options.targetDir ?? ".");
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const actions: InitAction[] = [];

  const dirs = [".symphony", ".symphony/workspaces", ".symphony/evidence"];
  for (const dir of dirs) {
    const path = join(targetDir, dir);
    if (await pathExists(path)) {
      actions.push({ path, status: "skipped" });
      continue;
    }
    actions.push({ path, status: dryRun ? "would-create" : "created" });
    if (!dryRun) await mkdir(path, { recursive: true });
  }

  const files = [
    { path: join(targetDir, "WORKFLOW.md"), content: defaultWorkflowMarkdown() },
    { path: join(targetDir, ".env"), content: defaultEnvExample() },
  ];

  for (const file of files) {
    const exists = await pathExists(file.path);
    if (exists && !force) {
      actions.push({ path: file.path, status: "skipped" });
      continue;
    }
    const status: InitActionStatus = exists
      ? dryRun ? "would-overwrite" : "overwritten"
      : dryRun ? "would-create" : "created";
    actions.push({ path: file.path, status });
    if (!dryRun) await writeFile(file.path, file.content, "utf8");
  }

  return {
    targetDir,
    actions,
    next: [
      "Edit .env and WORKFLOW.md for your Linear project and target repo.",
      "Run `bun run symphony doctor WORKFLOW.md`.",
      "Run `bun run symphony validate WORKFLOW.md --live-tracker` once credentials are configured.",
      "Run `bun run symphony tick WORKFLOW.md` for one controlled dispatch/reconcile pass.",
    ],
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const workflowPath = resolvePath(cwd, options.workflowPath ?? "WORKFLOW.md");
  let env = options.env ?? process.env;
  const runner = options.runner ?? defaultCliCommandRunner;
  const timeoutMs = options.commandTimeoutMs ?? 10_000;
  const checks: DoctorCheck[] = [];
  let config: ResolvedWorkflowConfig | null = null;
  let workflowDirectory = dirname(workflowPath);

  checks.push(check("bun.runtime", "pass", `Bun ${Bun.version}`));

  try {
    const workflow = await loadWorkflowFile(workflowPath);
    workflowDirectory = workflow.directory;
    env = await envForWorkflow(workflowDirectory, env);
    config = withTemporaryEnv(env, () => resolveWorkflowConfig(workflow));
    checks.push(check("workflow.load", "pass", `Loaded ${workflow.path}`));
    if (config.warnings.length > 0) {
      checks.push(check("workflow.warnings", "warn", "WORKFLOW.md contains unknown keys", config.warnings));
    } else {
      checks.push(check("workflow.warnings", "pass", "No unknown workflow keys"));
    }

    const dispatchErrors = validateDispatchConfig(config);
    checks.push(
      dispatchErrors.length === 0
        ? check("workflow.dispatch", "pass", "Dispatch configuration is locally complete")
        : check("workflow.dispatch", "fail", "Dispatch configuration is incomplete", dispatchErrors),
    );
    checks.push(
      config.hooks.afterRun
        ? check("workflow.after_run", "pass", `after_run is configured: ${singleLine(config.hooks.afterRun)}`)
        : check("workflow.after_run", "fail", "hooks.after_run validation command is required"),
    );
    checks.push(
      config.tracker.apiKey
        ? check("linear.api_key", "pass", "Linear API key is present")
        : check("linear.api_key", "fail", "Set tracker.api_key or LINEAR_API_KEY"),
    );
    checks.push(projectSlugCheck(config.tracker.projectSlug));

    if (options.liveTracker) {
      if (validateDispatchConfig(config).length === 0) {
        await checkLiveTracker(config, checks);
      } else {
        checks.push(check("linear.live", "warn", "Skipped live Linear preflight because local dispatch config has errors"));
      }
    } else {
      checks.push(check("linear.live", "warn", "Live Linear project/state check skipped; rerun with --live-tracker"));
    }
  } catch (error) {
    checks.push(check("workflow.load", "fail", error instanceof Error ? error.message : String(error)));
  }

  checks.push(await checkCommandOnPath("tool.gh", "gh", runner, cwd, timeoutMs));
  checks.push(await checkGhAuth(runner, cwd, timeoutMs));
  checks.push(await checkRunnerCommand(config, env, runner, cwd, timeoutMs));
  checks.push(await checkWorkspace(config, env, runner, cwd, timeoutMs, workflowDirectory));
  checks.push(await checkBaseRef(env, runner, cwd, timeoutMs, workflowDirectory));
  checks.push(await checkServerAuth(env));
  checks.push(await checkLocalStateDirs(config, env, workflowDirectory));
  checks.push(await checkEvidence(config, env, runner, cwd, timeoutMs, workflowDirectory));

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length,
  };

  return {
    ok: summary.fail === 0,
    workflowPath,
    checks,
    summary,
    next: nextDoctorSteps(summary.fail === 0),
  };
}

export async function defaultCliCommandRunner(
  command: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): Promise<CliCommandResult> {
  const proc = Bun.spawn([...command], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = options.timeoutMs
    ? setTimeout(() => {
        proc.kill();
      }, options.timeoutMs)
    : null;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkLiveTracker(config: ResolvedWorkflowConfig, checks: DoctorCheck[]): Promise<void> {
  try {
    const tracker = new LinearTrackerAdapter(config.tracker);
    const preflight = await tracker.preflight(requiredLinearStates(config));
    const errors: string[] = [];
    if (!preflight.project) errors.push(`Linear project_slug not found: ${config.tracker.projectSlug}`);
    for (const state of preflight.missingStates) {
      errors.push(`Linear workflow state not found: ${state}`);
    }
    checks.push(
      errors.length === 0
        ? check("linear.live", "pass", "Linear project and workflow states are reachable", preflight)
        : check("linear.live", "fail", "Linear live preflight failed", errors),
    );
  } catch (error) {
    checks.push(check("linear.live", "fail", error instanceof Error ? error.message : String(error)));
  }
}

function requiredLinearStates(config: ResolvedWorkflowConfig): string[] {
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

function projectSlugCheck(projectSlug: string): DoctorCheck {
  if (!projectSlug) return check("linear.project_slug", "fail", "Set tracker.project_slug in WORKFLOW.md");
  if (projectSlug === "REPLACE_WITH_LINEAR_PROJECT_SLUG") {
    return check("linear.project_slug", "fail", "Replace tracker.project_slug with a real Linear project slug");
  }
  return check("linear.project_slug", "pass", `Linear project slug: ${projectSlug}`);
}

async function checkGhAuth(runner: CliCommandRunner, cwd: string, timeoutMs: number): Promise<DoctorCheck> {
  const result = await runSafely(runner, ["gh", "auth", "status"], { cwd, timeoutMs });
  if (result.exitCode === 0) return check("github.auth", "pass", "GitHub CLI is authenticated");
  return check("github.auth", "fail", "Run `gh auth login` before PR handoff", tail(`${result.stdout}\n${result.stderr}`));
}

async function checkRunnerCommand(
  config: ResolvedWorkflowConfig | null,
  env: Record<string, string | undefined>,
  runner: CliCommandRunner,
  cwd: string,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const runnerKind = compactEnv(env.SYMPHONY_RUNNER) === "pi" ? "pi" : "codex";
  const command =
    runnerKind === "pi"
      ? compactEnv(env.SYMPHONY_PI_COMMAND) ?? "pi --print"
      : compactEnv(env.SYMPHONY_CODEX_COMMAND) ?? config?.codex.command ?? "codex exec --skip-git-repo-check --sandbox workspace-write -";
  const executable = firstShellWord(command);
  if (!executable) return check("runner.command", "fail", `No executable found in ${runnerKind} command`);
  const result = await checkExecutable(executable, runner, cwd, timeoutMs);
  if (result.status === "pass") return check("runner.command", "pass", `${runnerKind} command is available: ${command}`);
  return check("runner.command", "fail", `${runnerKind} executable is not on PATH: ${executable}`);
}

async function checkWorkspace(
  config: ResolvedWorkflowConfig | null,
  env: Record<string, string | undefined>,
  runner: CliCommandRunner,
  cwd: string,
  timeoutMs: number,
  workflowDirectory: string,
): Promise<DoctorCheck> {
  const mode = compactEnv(env.SYMPHONY_WORKSPACE_MODE) ?? "worktree";
  if (mode !== "worktree" && mode !== "clone") {
    return check("workspace.mode", "fail", `SYMPHONY_WORKSPACE_MODE must be worktree or clone; got ${mode}`);
  }
  if (mode === "clone") {
    const repoUrl = compactEnv(env.SYMPHONY_REPO_URL);
    return repoUrl
      ? check("workspace.mode", "pass", `clone mode configured for ${repoUrl}`)
      : check("workspace.mode", "fail", "clone mode requires SYMPHONY_REPO_URL");
  }

  const sourceRepo = resolveSourceRepo(env, workflowDirectory);
  const git = await runSafely(runner, ["git", "-C", sourceRepo, "rev-parse", "--show-toplevel"], { cwd, timeoutMs });
  if (git.exitCode !== 0) {
    return check("workspace.mode", "fail", `worktree mode requires a git source repo: ${sourceRepo}`, tail(git.stderr || git.stdout));
  }
  const workspaceRoot = config?.workspace.root ?? resolve(cwd, ".symphony/workspaces");
  return check("workspace.mode", "pass", `worktree mode from ${sourceRepo} into ${workspaceRoot}`);
}

async function checkBaseRef(
  env: Record<string, string | undefined>,
  runner: CliCommandRunner,
  cwd: string,
  timeoutMs: number,
  workflowDirectory: string,
): Promise<DoctorCheck> {
  const baseRef = env.SYMPHONY_BASE_REF;
  if (!baseRef || baseRef.trim() === "") {
    return check("workspace.base_ref", "warn", "SYMPHONY_BASE_REF is not set; workspaces default to HEAD and PR target defaults to main");
  }
  if (compactEnv(env.SYMPHONY_WORKSPACE_MODE) === "clone") {
    const repoUrl = compactEnv(env.SYMPHONY_REPO_URL);
    if (!repoUrl) return check("workspace.base_ref", "warn", "Skipped base ref check because clone mode has no SYMPHONY_REPO_URL");
    const remote = await runSafely(runner, ["git", "ls-remote", "--exit-code", repoUrl, baseRef], { cwd, timeoutMs });
    if (remote.exitCode === 0) return check("workspace.base_ref", "pass", `Remote base ref exists: ${baseRef}`);
    return check("workspace.base_ref", "fail", `Remote base ref not found or repo is unreachable: ${baseRef}`, tail(remote.stderr || remote.stdout));
  }
  const sourceRepo = resolveSourceRepo(env, workflowDirectory);
  const result = await runSafely(runner, ["git", "-C", sourceRepo, "rev-parse", "--verify", baseRef], { cwd, timeoutMs });
  if (result.exitCode === 0) return check("workspace.base_ref", "pass", `Base ref exists: ${baseRef}`);
  return check("workspace.base_ref", "fail", `Base ref not found in ${sourceRepo}: ${baseRef}`, tail(result.stderr || result.stdout));
}

async function checkServerAuth(env: Record<string, string | undefined>): Promise<DoctorCheck> {
  if (compactEnv(env.SYMPHONY_AUTH_TOKEN)) {
    return check("server.auth", "pass", "SYMPHONY_AUTH_TOKEN is set");
  }
  if (env.SYMPHONY_ALLOW_INSECURE === "true" || env.SYMPHONY_ALLOW_INSECURE === "1") {
    return check("server.auth", "pass", "SYMPHONY_ALLOW_INSECURE explicitly enables unauthenticated API access");
  }
  return check("server.auth", "warn", "Set SYMPHONY_AUTH_TOKEN before `symphony serve`; server APIs fail closed by default");
}

async function checkLocalStateDirs(
  config: ResolvedWorkflowConfig | null,
  env: Record<string, string | undefined>,
  workflowDirectory: string,
): Promise<DoctorCheck> {
  const dbPath = resolvePath(workflowDirectory, compactEnv(env.SYMPHONY_DB_PATH) ?? ".symphony/symphony.db");
  const evidenceDir = resolvePath(workflowDirectory, compactEnv(env.SYMPHONY_EVIDENCE_DIR) ?? ".symphony/evidence");
  const workspaceRoot = config?.workspace.root ?? resolve(workflowDirectory, ".symphony/workspaces");
  const missing = [];
  if (!(await pathExists(join(workflowDirectory, ".symphony")))) missing.push(join(workflowDirectory, ".symphony"));
  if (!(await pathExists(workspaceRoot))) missing.push(workspaceRoot);
  if (!(await pathExists(evidenceDir))) missing.push(evidenceDir);
  if (missing.length > 0) return check("local_state", "warn", "Local state directories are missing; run `symphony init`", missing);
  return check("local_state", "pass", `Local state paths ready; database will be ${dbPath}`);
}

async function checkEvidence(
  config: ResolvedWorkflowConfig | null,
  env: Record<string, string | undefined>,
  runner: CliCommandRunner,
  cwd: string,
  timeoutMs: number,
  workflowDirectory: string,
): Promise<DoctorCheck> {
  const ui = config?.evidence.ui;
  if (!ui) return check("evidence.ui", "warn", "No UI evidence gate configured");
  if (!ui.command) return check("evidence.ui", "warn", "UI evidence labels are configured but no command is set");
  if (ui.requiredArtifacts.length === 0) return check("evidence.ui", "warn", "UI evidence command has no required_artifacts");
  const executable = firstShellWord(ui.command);
  if (!executable) return check("evidence.ui", "fail", "UI evidence command has no executable");
  const result = await checkExecutable(executable, runner, cwd, timeoutMs);
  if (result.status !== "pass") {
    return check("evidence.ui", "fail", `UI evidence executable is not on PATH: ${executable}`);
  }
  const scriptName = bunRunScriptName(ui.command);
  if (scriptName) {
    if (compactEnv(env.SYMPHONY_WORKSPACE_MODE) === "clone" && !compactEnv(env.SYMPHONY_SOURCE_REPO)) {
      return check("evidence.ui", "warn", `UI evidence executable is available, but clone-mode package scripts cannot be inspected before cloning: ${scriptName}`);
    }
    const sourceRepo = resolveSourceRepo(env, workflowDirectory);
    const script = await packageJsonScript(sourceRepo, scriptName);
    if (script === null) {
      return check("evidence.ui", "fail", `UI evidence script is missing from ${join(sourceRepo, "package.json")}: ${scriptName}`);
    }
  }
  if (result.status === "pass") return check("evidence.ui", "pass", `UI evidence command is ready: ${ui.command}`);
  return check("evidence.ui", "fail", `UI evidence executable is not on PATH: ${executable}`);
}

async function checkCommandOnPath(
  name: string,
  executable: string,
  runner: CliCommandRunner,
  cwd: string,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const result = await checkExecutable(executable, runner, cwd, timeoutMs);
  return result.status === "pass"
    ? check(name, "pass", `${executable} is on PATH`)
    : check(name, "fail", `${executable} is not on PATH`);
}

async function checkExecutable(
  executable: string,
  runner: CliCommandRunner,
  cwd: string,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const result = await runSafely(runner, ["sh", "-c", `command -v ${shellQuote(executable)}`], { cwd, timeoutMs });
  return result.exitCode === 0
    ? check(`tool.${executable}`, "pass", `${executable} is on PATH`)
    : check(`tool.${executable}`, "fail", `${executable} is not on PATH`, tail(result.stderr || result.stdout));
}

async function runSafely(
  runner: CliCommandRunner,
  command: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number },
): Promise<CliCommandResult> {
  try {
    return await runner(command, options);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function nextDoctorSteps(ok: boolean): readonly string[] {
  if (!ok) {
    return [
      "Fix failed checks above.",
      "Run `bun run symphony doctor WORKFLOW.md` again.",
      "Run `bun run symphony doctor WORKFLOW.md --live-tracker` before dispatching a real ticket.",
    ];
  }
  return [
    "Run `bun run symphony validate WORKFLOW.md --live-tracker`.",
    "Run `bun run symphony tick WORKFLOW.md` for one controlled dispatch/reconcile pass.",
    "Run `bun run symphony serve WORKFLOW.md` to inspect runs and evidence.",
  ];
}

function firstShellWord(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    const end = trimmed.indexOf(quote, 1);
    return end > 1 ? trimmed.slice(1, end) : null;
  }
  return trimmed.split(/\s+/)[0] ?? null;
}

function check(name: string, status: DoctorStatus, message: string, details?: unknown): DoctorCheck {
  return details === undefined ? { name, status, message } : { name, status, message, details };
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

async function envForWorkflow(
  workflowDirectory: string,
  baseEnv: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  const fileEnv = await readEnvFile(join(workflowDirectory, ".env"));
  return mergeEnv(fileEnv, baseEnv);
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
}

function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const equals = cleaned.indexOf("=");
    if (equals <= 0) continue;
    const key = cleaned.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = parseEnvValue(cleaned.slice(equals + 1).trim());
  }
  return values;
}

function parseEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  const hash = value.indexOf(" #");
  return hash >= 0 ? value.slice(0, hash).trimEnd() : value;
}

function mergeEnv(
  fileEnv: Record<string, string>,
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...fileEnv };
  for (const [key, value] of Object.entries(baseEnv)) {
    if (compactEnv(value) !== undefined) merged[key] = value;
  }
  return merged;
}

function compactEnv(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

function resolveSourceRepo(env: Record<string, string | undefined>, workflowDirectory: string): string {
  return resolvePath(workflowDirectory, compactEnv(env.SYMPHONY_SOURCE_REPO) ?? ".");
}

function bunRunScriptName(command: string): string | null {
  const match = command.trim().match(/^bun\s+run\s+([^\s]+)/);
  return match?.[1] && !match[1].startsWith("-") ? match[1] : null;
}

async function packageJsonScript(directory: string, scriptName: string): Promise<string | null> {
  try {
    const raw = await readFile(join(directory, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const script = pkg.scripts?.[scriptName];
    return typeof script === "string" ? script : null;
  } catch {
    return null;
  }
}

function withTemporaryEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  if (env === process.env) return fn();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function tail(value: string, limit = 1_000): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}
