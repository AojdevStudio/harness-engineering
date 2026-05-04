import type { CommandRunner } from "./index.ts";
import { WorkspaceError } from "./index.ts";

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

  constructor(options: { readonly runner: CommandRunner; readonly remote?: string; readonly base?: string }) {
    this.runner = options.runner;
    this.remote = options.remote ?? "origin";
    this.base = options.base ?? "main";
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
}
