import { describe, expect, test } from "bun:test";
import { GitHubPrManager, WorkspaceError, type CommandRunner } from "../src/index.ts";

describe("GitHubPrManager", () => {
  test("reuses existing PR URL", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stdout: "https://github.test/pr/1\n", stderr: "" };
    };
    const manager = new GitHubPrManager({ runner });
    const url = await manager.ensurePullRequest({ workspacePath: "/repo", branchName: "b", title: "T", body: "B" });
    expect(url).toBe("https://github.test/pr/1");
    expect(commands).toHaveLength(1);
  });

  test("creates PR when none exists", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      if (command[0] === "gh" && command[2] === "view") return { exitCode: 1, stdout: "", stderr: "none" };
      return { exitCode: 0, stdout: "https://github.test/pr/2\n", stderr: "" };
    };
    const manager = new GitHubPrManager({ runner, base: "main" });
    const url = await manager.ensurePullRequest({ workspacePath: "/repo", branchName: "b", title: "T", body: "B" });
    expect(url).toBe("https://github.test/pr/2");
    expect(commands[1]).toEqual(["gh", "pr", "create", "--base", "main", "--head", "b", "--title", "T", "--body", "B"]);
  });

  // P1-C: base is configurable — verify "develop" flows through to gh pr create
  test("uses custom base branch when configured", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      if (command[0] === "gh" && command[2] === "view") return { exitCode: 1, stdout: "", stderr: "none" };
      return { exitCode: 0, stdout: "https://github.test/pr/3\n", stderr: "" };
    };
    const manager = new GitHubPrManager({ runner, base: "develop" });
    const url = await manager.ensurePullRequest({ workspacePath: "/repo", branchName: "feature/x", title: "T", body: "B" });
    expect(url).toBe("https://github.test/pr/3");
    const createCmd = commands.find((c) => c[0] === "gh" && c[2] === "create");
    expect(createCmd).toBeDefined();
    const baseIdx = createCmd!.indexOf("--base");
    expect(baseIdx).toBeGreaterThan(-1);
    expect(createCmd![baseIdx + 1]).toBe("develop");
  });

  test("inspects PR review findings and check status", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      if (command[0] === "gh" && command[1] === "api") {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ body: "[P0] Inline breakage", path: "src/app.ts", html_url: "https://github.test/acme/repo/pull/9#discussion_r1" })}\n`,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 9,
          url: "https://github.test/acme/repo/pull/9",
          state: "OPEN",
          isDraft: false,
          reviewDecision: "CHANGES_REQUESTED",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS" },
            { state: "SUCCESS" },
          ],
          comments: [{ body: "P2: tighten the copy", url: "https://github.test/acme/repo/pull/9#issuecomment-1" }],
          reviews: [{ body: "P1 - add a regression test", author: { login: "reviewer" }, url: "https://github.test/acme/repo/pull/9#pullrequestreview-1" }],
        }),
        stderr: "",
      };
    };
    const manager = new GitHubPrManager({ runner });
    const inspection = await manager.inspectPullRequest({ workspacePath: "/repo", branchName: "feature/x" });
    expect(commands[0]).toEqual(["gh", "pr", "view", "feature/x", "--json", "number,url,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,comments,reviews"]);
    expect(commands[1]).toEqual(["gh", "api", "repos/acme/repo/pulls/9/comments", "--paginate", "--jq", ".[] | @json"]);
    expect(inspection?.checksStatus).toBe("passing");
    expect(inspection?.mergeable).toBe(true);
    expect(inspection?.findings.map((finding) => `${finding.severity}:${finding.source}:${finding.message}`)).toEqual([
      "P2:comment:tighten the copy",
      "P1:review:reviewer:add a regression test",
      "P0:inline:src/app.ts:Inline breakage",
    ]);
  });

  test("merges PRs with configured strategy and deletes the branch", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stdout: "merged\n", stderr: "" };
    };
    const manager = new GitHubPrManager({ runner, mergeMethod: "rebase" });
    await expect(manager.mergePullRequest({ workspacePath: "/repo", branchName: "feature/x" })).resolves.toBe("merged");
    expect(commands[0]).toEqual(["gh", "pr", "merge", "feature/x", "--rebase", "--delete-branch"]);
  });
});

// P1-D: ensureBranch uses git rev-parse --verify refs/heads/BRANCH
describe("GitHubPrManager.ensureBranch", () => {
  test("resolves when branch exists", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stdout: "abc123", stderr: "" };
    };
    const manager = new GitHubPrManager({ runner });
    await expect(manager.ensureBranch({ workspacePath: "/repo", branchName: "feature/x" })).resolves.toBeUndefined();
    expect(commands[0]).toEqual(["git", "rev-parse", "--verify", "refs/heads/feature/x"]);
  });

  test("throws WorkspaceError when branch does not exist", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "fatal: Needed a single revision" });
    const manager = new GitHubPrManager({ runner });
    await expect(manager.ensureBranch({ workspacePath: "/repo", branchName: "ghost-branch" })).rejects.toThrow(WorkspaceError);
  });

  test("does not use git checkout (no-op / failure risk)", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stdout: "abc123", stderr: "" };
    };
    const manager = new GitHubPrManager({ runner });
    await manager.ensureBranch({ workspacePath: "/repo", branchName: "my-branch" });
    const checkoutCmd = commands.find((c) => c[0] === "git" && c[1] === "checkout");
    expect(checkoutCmd).toBeUndefined();
  });
});
