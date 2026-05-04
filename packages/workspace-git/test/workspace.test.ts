import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GitWorkspaceManager, WorkspaceError, assertPathInsideRoot, workspacePathFor, type CommandRunner } from "../src/index.ts";

describe("workspace path safety", () => {
  test("sanitizes issue identifier under root", () => {
    const ref = workspacePathFor("/tmp/symphony", "ABC / ../ 123");
    expect(ref.workspaceKey).toBe("ABC___..__123");
    expect(ref.path).toBe(resolve("/tmp/symphony/ABC___..__123"));
  });

  test("rejects paths outside root", () => {
    expect(() => assertPathInsideRoot("/tmp/root", "/tmp/root/child")).not.toThrow();
    expect(() => assertPathInsideRoot("/tmp/root", "/tmp/other")).toThrow(WorkspaceError);
  });
});

describe("GitWorkspaceManager", () => {
  test("prepares clone workspace and runs after create hook", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command, options) => {
      commands.push([...command, ...(options.cwd ? [`cwd=${options.cwd}`] : [])]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const root = await mkdtemp(join(tmpdir(), "symphony-workspace-test-"));

    try {
      const manager = new GitWorkspaceManager(runner);
      const workspace = await manager.prepare({
        issueIdentifier: "ABC-1",
        workspaceRoot: root,
        mode: "clone",
        repoUrl: "git@example.com:repo.git",
        branchName: "symphony/ABC-1",
        afterCreateHook: "echo ready",
      });

      expect(workspace.createdNow).toBe(true);
      expect(commands[0]).toEqual(["git", "clone", "git@example.com:repo.git", workspace.path]);
      expect(commands[1]).toEqual(["git", "checkout", "-b", "symphony/ABC-1", "HEAD", `cwd=${workspace.path}`]);
      // P1-B: hook must use sh -c (not sh -lc)
      expect(commands[2]).toEqual(["sh", "-c", "echo ready", `cwd=${workspace.path}`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prepares worktree workspace from source repo", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command, options) => {
      commands.push([...command, ...(options.cwd ? [`cwd=${options.cwd}`] : [])]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const root = await mkdtemp(join(tmpdir(), "symphony-worktree-test-"));

    try {
      const manager = new GitWorkspaceManager(runner);
      const workspace = await manager.prepare({
        issueIdentifier: "ABC-2",
        workspaceRoot: root,
        mode: "worktree",
        sourceRepoPath: "/repo/source",
        branchName: "symphony/ABC-2",
        baseRef: "origin/main",
      });

      expect(workspace.createdNow).toBe(true);
      expect(commands).toEqual([
        ["git", "worktree", "prune", "cwd=/repo/source"],
        ["git", "worktree", "add", "-b", "symphony/ABC-2", workspace.path, "origin/main", "cwd=/repo/source"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// P1-B: runHook must use sh -c
describe("GitWorkspaceManager.runHook", () => {
  test("invokes sh -c (not sh -lc)", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command, options) => {
      commands.push([...command, ...(options.cwd ? [`cwd=${options.cwd}`] : [])]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new GitWorkspaceManager(runner);
    await manager.runHook("/workspace", "echo hello");
    expect(commands).toHaveLength(1);
    const hookCmd = commands[0];
    expect(hookCmd).toBeDefined();
    expect(hookCmd).toEqual(["sh", "-c", "echo hello", "cwd=/workspace"]);
    // Confirm -lc is NOT used
    expect(hookCmd).not.toContain("-lc");
  });
});

// P0: remove() safe-delete tests
describe("GitWorkspaceManager.remove", () => {
  test("uses git branch -d (not -D) when removing branch", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command, options) => {
      commands.push([...command, ...(options.cwd ? [`cwd=${options.cwd}`] : [])]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const root = await mkdtemp(join(tmpdir(), "symphony-remove-test-"));
    try {
      const manager = new GitWorkspaceManager(runner);
      await manager.remove(root, root, {
        sourceRepoPath: "/repo/source",
        branchName: "feature/my-branch",
      });

      const branchDeleteCmd = commands.find((c) => c[0] === "git" && c[1] === "branch");
      expect(branchDeleteCmd).toBeDefined();
      expect(branchDeleteCmd![2]).toBe("-d");
      // Must NOT use -D
      expect(branchDeleteCmd).not.toContain("-D");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not throw when -d fails (unmerged commits on branch)", async () => {
    const runner: CommandRunner = async (command) => {
      if (command[1] === "branch" && command[2] === "-d") {
        // Simulate git refusing safe-delete due to unmerged commits
        return { exitCode: 1, stdout: "", stderr: "error: The branch 'feature/x' is not fully merged." };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const root = await mkdtemp(join(tmpdir(), "symphony-remove-nodelete-test-"));
    try {
      const manager = new GitWorkspaceManager(runner);
      // Must not throw — cleanup continues even when branch is preserved
      await expect(
        manager.remove(root, root, {
          sourceRepoPath: "/repo/source",
          branchName: "feature/x",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// P1-A: branchName input validation
describe("GitWorkspaceManager branch name validation", () => {
  test("rejects branchName starting with --", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const root = await mkdtemp(join(tmpdir(), "symphony-branch-validate-test-"));
    try {
      const manager = new GitWorkspaceManager(runner);
      await expect(
        manager.prepare({
          issueIdentifier: "ABC-99",
          workspaceRoot: root,
          mode: "clone",
          repoUrl: "git@example.com:repo.git",
          branchName: "--no-edit",
        }),
      ).rejects.toThrow(WorkspaceError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects branchName starting with single -", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const root = await mkdtemp(join(tmpdir(), "symphony-branch-validate-single-test-"));
    try {
      const manager = new GitWorkspaceManager(runner);
      await expect(
        manager.prepare({
          issueIdentifier: "ABC-98",
          workspaceRoot: root,
          mode: "worktree",
          sourceRepoPath: "/repo/source",
          branchName: "-b",
        }),
      ).rejects.toThrow(WorkspaceError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts normal branchName", async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (command, options) => {
      commands.push([...command, ...(options.cwd ? [`cwd=${options.cwd}`] : [])]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const root = await mkdtemp(join(tmpdir(), "symphony-branch-ok-test-"));
    try {
      const manager = new GitWorkspaceManager(runner);
      await expect(
        manager.prepare({
          issueIdentifier: "ABC-3",
          workspaceRoot: root,
          mode: "clone",
          repoUrl: "git@example.com:repo.git",
          branchName: "feature/normal-branch",
        }),
      ).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
