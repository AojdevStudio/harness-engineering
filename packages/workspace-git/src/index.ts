import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { sanitizeWorkspaceKey, type WorkspaceRef } from "@symphony/core";
import { hookResultFromExecutedCommand } from "./hook-evidence.ts";

export { GitHubPrManager } from "./pr.ts";

export interface HandoffFactsCommit {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
}

export interface HandoffFactsFile {
  readonly path: string;
  readonly status: string;
}

export interface HandoffFactsDiffstat {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface HandoffFacts {
  readonly commits: readonly HandoffFactsCommit[];
  readonly files: readonly HandoffFactsFile[];
  readonly diffstat: HandoffFactsDiffstat;
}

export interface PrTemplateSection {
  readonly header: string;
  readonly body: string;
}

export interface PrTemplate {
  readonly raw: string;
  readonly sections: readonly PrTemplateSection[];
}

export async function collectHandoffFacts(
  workspacePath: string,
  baseBranch: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<HandoffFacts> {
  const [log, diff, shortstat] = await Promise.all([
    runOrThrow(runner, ["git", "log", "--format=%H%x00%s%x00%b%x00%x1e", `${baseBranch}..HEAD`], { cwd: workspacePath }),
    runOrThrow(runner, ["git", "diff", "--name-status", `${baseBranch}...HEAD`], { cwd: workspacePath }),
    runOrThrow(runner, ["git", "diff", "--shortstat", `${baseBranch}...HEAD`], { cwd: workspacePath }),
  ]);

  return {
    commits: parseCommits(log.stdout),
    files: parseFiles(diff.stdout),
    diffstat: parseDiffstat(shortstat.stdout),
  };
}

const PR_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
] as const;

export async function readPrTemplate(workspacePath: string): Promise<PrTemplate | null> {
  for (const templatePath of PR_TEMPLATE_PATHS) {
    try {
      const raw = await readFile(resolve(workspacePath, templatePath), "utf8");
      return { raw, sections: parsePrTemplateSections(raw) };
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function parsePrTemplateSections(raw: string): readonly PrTemplateSection[] {
  const sections: PrTemplateSection[] = [];
  let header: string | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (header === null) return;
    sections.push({ header, body: bodyLines.join("\n").trim() });
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      flush();
      header = line.slice(3).trim();
      bodyLines = [];
    } else if (header !== null) {
      bodyLines.push(line);
    }
  }
  flush();

  return sections;
}

function parseCommits(out: string): readonly HandoffFactsCommit[] {
  if (!out) return [];
  const RS = String.fromCharCode(30);
  const NUL = String.fromCharCode(0);
  return out
    .split(RS)
    .map((record) => record.replace(/^\n+/, "").trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split(NUL);
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
    })
    .filter((commit) => commit.sha.length > 0);
}

function parseFiles(out: string): readonly HandoffFactsFile[] {
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status = "", ...rest] = line.split("\t");
      return { status: status.trim(), path: rest.join("\t").trim() };
    })
    .filter((file) => file.path.length > 0);
}

function parseDiffstat(out: string): HandoffFactsDiffstat {
  const filesMatch = out.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = out.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = out.match(/(\d+)\s+deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    insertions: insertionsMatch ? Number(insertionsMatch[1]) : 0,
    deletions: deletionsMatch ? Number(deletionsMatch[1]) : 0,
  };
}

export type WorkspaceMode = "worktree" | "clone";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HookCommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export interface HookResult extends HookCommandResult {
  readonly commands: readonly HookCommandResult[];
}

export type CommandRunner = (command: readonly string[], options: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> }) => Promise<CommandResult>;

export interface PrepareWorkspaceInput {
  readonly issueIdentifier: string;
  readonly workspaceRoot: string;
  readonly mode: WorkspaceMode;
  readonly repoUrl?: string;
  readonly sourceRepoPath?: string;
  readonly branchName: string;
  readonly baseRef?: string;
  readonly afterCreateHook?: string;
  readonly hookTimeoutMs?: number;
}

export class WorkspaceError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "WorkspaceError";
    this.details = details;
  }
}

export function workspacePathFor(root: string, issueIdentifier: string): WorkspaceRef {
  const workspaceRoot = resolve(root);
  const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
  const path = resolve(workspaceRoot, workspaceKey);
  assertPathInsideRoot(workspaceRoot, path);
  return { path, workspaceKey, createdNow: false };
}

export function assertPathInsideRoot(workspaceRoot: string, workspacePath: string): void {
  const root = resolve(workspaceRoot);
  const target = resolve(workspacePath);
  const rel = relative(root, target);

  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..")) {
    return;
  }

  throw new WorkspaceError(`Workspace path escapes workspace root: ${target} is not under ${root}`);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function defaultCommandRunner(command: readonly string[], options: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> } = {}): Promise<CommandResult> {
  const proc = Bun.spawn([...command], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = options.timeoutMs
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
    if (timeout) clearTimeout(timeout);
  }
}

async function runOrThrow(runner: CommandRunner, command: readonly string[], options: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> } = {}): Promise<CommandResult> {
  const result = await runner(command, options);
  if (result.exitCode !== 0) {
    throw new WorkspaceError(`Command failed: ${command.join(" ")}`, result);
  }
  return result;
}

async function runHookCommand(runner: CommandRunner, script: string, options: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> }): Promise<HookCommandResult> {
  const startedAt = Date.now();
  const result = await runOrThrow(runner, ["sh", "-c", script], options);
  return {
    command: script,
    exitCode: result.exitCode,
    stdoutTail: tailText(result.stdout),
    stderrTail: tailText(result.stderr),
    durationMs: Date.now() - startedAt,
  };
}

function tailText(value: string, limit = 4_000): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

export class GitWorkspaceManager {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner = defaultCommandRunner) {
    this.runner = runner;
  }

  async prepare(input: PrepareWorkspaceInput): Promise<WorkspaceRef> {
    // Guard against branch names that start with '-', which git would interpret
    // as flags (e.g. "--no-edit"). The -- separator is not valid at the
    // <new-branch> argument position for worktree add, nor for checkout -b
    // where BASEREF is a treeish, not a pathspec. Rejection is the safe choice.
    if (input.branchName.startsWith("-")) {
      throw new WorkspaceError(`Invalid branchName: "${input.branchName}" — branch names must not start with '-'`);
    }
    const workspaceRoot = resolve(input.workspaceRoot);
    const ref = workspacePathFor(workspaceRoot, input.issueIdentifier);
    await mkdir(workspaceRoot, { recursive: true });

    const createdNow = input.mode === "worktree" ? await this.prepareWorktree(ref.path, input) : await this.prepareClone(ref.path, input);

    if (createdNow && input.afterCreateHook) {
      await runOrThrow(this.runner, ["sh", "-c", input.afterCreateHook], {
        cwd: ref.path,
        timeoutMs: input.hookTimeoutMs ?? 60_000,
      });
    }

    return { ...ref, createdNow };
  }

  async runHook(workspacePath: string, script: string, timeoutMs = 60_000, env?: Record<string, string>): Promise<HookResult> {
    const result = await runHookCommand(this.runner, script, { cwd: workspacePath, timeoutMs, ...(env ? { env } : {}) });
    return hookResultFromExecutedCommand(result);
  }

  collectHandoffFacts(workspacePath: string, baseBranch: string): Promise<HandoffFacts> {
    return collectHandoffFacts(workspacePath, baseBranch, this.runner);
  }

  readPrTemplate(workspacePath: string): Promise<PrTemplate | null> {
    return readPrTemplate(workspacePath);
  }

  async remove(workspaceRoot: string, workspacePath: string, options: { readonly sourceRepoPath?: string; readonly branchName?: string } = {}): Promise<void> {
    assertPathInsideRoot(workspaceRoot, workspacePath);
    if (options.sourceRepoPath) {
      const result = await this.runner(["git", "worktree", "remove", "--force", workspacePath], { cwd: options.sourceRepoPath });
      if (result.exitCode !== 0) {
        await this.runner(["git", "worktree", "prune"], { cwd: options.sourceRepoPath });
      }
      if (options.branchName) {
        // Use safe-delete (-d) so any commits on the branch are preserved.
        // If -d refuses because the branch has unmerged commits, log a warning
        // and skip — cleanup must not destroy work.
        const deleteResult = await this.runner(["git", "branch", "-d", options.branchName], { cwd: options.sourceRepoPath });
        if (deleteResult.exitCode !== 0) {
          // Branch preserved because it has unmerged commits; not an error.
          void deleteResult; // acknowledged — caller can inspect via prune output
        }
      }
    }
    await rm(workspacePath, { recursive: true, force: true });
  }

  private async prepareWorktree(path: string, input: PrepareWorkspaceInput): Promise<boolean> {
    if (!input.sourceRepoPath) {
      throw new WorkspaceError("worktree mode requires sourceRepoPath");
    }

    const existing = await directoryExists(path);
    if (existing) return false;

    await runOrThrow(this.runner, ["git", "worktree", "prune"], { cwd: input.sourceRepoPath });
    const baseRef = input.baseRef ?? "HEAD";
    await runOrThrow(this.runner, ["git", "worktree", "add", "-b", input.branchName, path, baseRef], {
      cwd: input.sourceRepoPath,
    });
    return true;
  }

  private async prepareClone(path: string, input: PrepareWorkspaceInput): Promise<boolean> {
    if (!input.repoUrl) {
      throw new WorkspaceError("clone mode requires repoUrl");
    }

    const existing = await directoryExists(path);
    if (existing) return false;

    await runOrThrow(this.runner, ["git", "clone", input.repoUrl, path]);
    await runOrThrow(this.runner, ["git", "checkout", "-b", input.branchName, input.baseRef ?? "HEAD"], {
      cwd: path,
    });
    return true;
  }
}
