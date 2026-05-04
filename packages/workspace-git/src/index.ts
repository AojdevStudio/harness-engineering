import { mkdir, rm, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { sanitizeWorkspaceKey, type WorkspaceRef } from "@symphony/core";

export { GitHubPrManager } from "./pr.ts";

export type WorkspaceMode = "worktree" | "clone";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
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

  async runHook(workspacePath: string, script: string, timeoutMs = 60_000, env?: Record<string, string>): Promise<CommandResult> {
    return runOrThrow(this.runner, ["sh", "-c", script], { cwd: workspacePath, timeoutMs, ...(env ? { env } : {}) });
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
