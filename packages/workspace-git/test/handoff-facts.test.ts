import { describe, expect, test } from "bun:test";
import { collectHandoffFacts, type CommandRunner } from "../src/index.ts";

const NUL = String.fromCharCode(0);
const RS = String.fromCharCode(30);

function fixedRunner(byCommand: Record<string, { stdout: string; stderr?: string; exitCode?: number }>): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command) => {
    calls.push([...command]);
    const key = command.join(" ");
    const match = byCommand[key];
    if (!match) throw new Error(`Unexpected command: ${key}`);
    return { stdout: match.stdout, stderr: match.stderr ?? "", exitCode: match.exitCode ?? 0 };
  };
  return { runner, calls };
}

describe("collectHandoffFacts", () => {
  test("parses commits, files, and diffstat from git output", async () => {
    const logOut =
      `aaa111${NUL}feat: first commit${NUL}body line${NUL}${RS}` +
      `bbb222${NUL}fix: second${NUL}${NUL}${RS}`;
    const diffOut = "M\tsrc/foo.ts\nA\tsrc/bar.ts\n";
    const shortstatOut = " 2 files changed, 42 insertions(+), 7 deletions(-)\n";
    const { runner, calls } = fixedRunner({
      "git log --format=%H%x00%s%x00%b%x00%x1e main..HEAD": { stdout: logOut },
      "git diff --name-status main...HEAD": { stdout: diffOut },
      "git diff --shortstat main...HEAD": { stdout: shortstatOut },
    });

    const facts = await collectHandoffFacts("/work/path", "main", runner);

    expect(calls[0]).toEqual(["git", "log", "--format=%H%x00%s%x00%b%x00%x1e", "main..HEAD"]);
    expect(calls[1]).toEqual(["git", "diff", "--name-status", "main...HEAD"]);
    expect(calls[2]).toEqual(["git", "diff", "--shortstat", "main...HEAD"]);
    expect(facts.commits).toEqual([
      { sha: "aaa111", subject: "feat: first commit", body: "body line" },
      { sha: "bbb222", subject: "fix: second", body: "" },
    ]);
    expect(facts.files).toEqual([
      { path: "src/foo.ts", status: "M" },
      { path: "src/bar.ts", status: "A" },
    ]);
    expect(facts.diffstat).toEqual({ filesChanged: 2, insertions: 42, deletions: 7 });
  });

  test("returns empty arrays and zero diffstat on empty output", async () => {
    const { runner } = fixedRunner({
      "git log --format=%H%x00%s%x00%b%x00%x1e main..HEAD": { stdout: "" },
      "git diff --name-status main...HEAD": { stdout: "" },
      "git diff --shortstat main...HEAD": { stdout: "" },
    });
    const facts = await collectHandoffFacts("/work/path", "main", runner);
    expect(facts.commits).toEqual([]);
    expect(facts.files).toEqual([]);
    expect(facts.diffstat).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  test("throws when a git command fails", async () => {
    const { runner } = fixedRunner({
      "git log --format=%H%x00%s%x00%b%x00%x1e main..HEAD": { stdout: "", stderr: "fatal: bad revision", exitCode: 128 },
      "git diff --name-status main...HEAD": { stdout: "" },
      "git diff --shortstat main...HEAD": { stdout: "" },
    });

    await expect(collectHandoffFacts("/work/path", "main", runner)).rejects.toThrow("Command failed: git log");
  });

  test("propagates the workspacePath as cwd to the runner", async () => {
    const calls: Array<{ command: string[]; cwd?: string }> = [];
    const runner: CommandRunner = async (command, options) => {
      calls.push({ command: [...command], ...(options.cwd ? { cwd: options.cwd } : {}) });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await collectHandoffFacts("/work/path", "main", runner);
    expect(calls.every((entry) => entry.cwd === "/work/path")).toBe(true);
  });
});
