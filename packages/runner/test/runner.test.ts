import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellAgentRunner } from "../src/index.ts";

describe("ShellAgentRunner", () => {
  test("passes prompt on stdin and env, captures output and token metrics", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symphony-runner-test-"));
    try {
      const events: string[] = [];
      const runner = new ShellAgentRunner({
        kind: "test",
        command: ["sh", "-c", "read prompt; echo issue=$SYMPHONY_ISSUE_IDENTIFIER prompt=$prompt; echo METRIC total_tokens=42"],
      });

      const result = await runner.run({
        workspacePath: workspace,
        prompt: "hello",
        issue: { id: "1", identifier: "ABC-1", title: "T", state: "Todo" },
        attempt: null,
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("issue=ABC-1 prompt=hello");
      expect(result.tokenUsage?.totalTokens).toBe(42);
      expect(events).toContain("runner.started");
      expect(events).toContain("runner.output");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("returns failure on non-zero exit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symphony-runner-fail-"));
    try {
      const runner = new ShellAgentRunner({ kind: "test", command: ["sh", "-c", "echo nope >&2; exit 7"] });
      const result = await runner.run({
        workspacePath: workspace,
        prompt: "hello",
        issue: { id: "1", identifier: "ABC-1", title: "T", state: "Todo" },
        attempt: null,
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain("nope");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("timeout kills process group including forked child sleeps", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symphony-runner-timeout-"));
    try {
      // Script forks a long sleep in the background then sleeps itself.
      // Both must die when the timeout fires.
      const scriptPath = join(workspace, "fork-sleep.sh");
      await writeFile(scriptPath, "#!/bin/sh\nsleep 60 &\nsleep 60\n");
      await chmod(scriptPath, 0o755);

      const runner = new ShellAgentRunner({
        kind: "test",
        command: ["sh", "-c", scriptPath],
      });

      const before = Date.now();
      const result = await runner.run({
        workspacePath: workspace,
        prompt: "",
        issue: { id: "1", identifier: "ABC-1", title: "T", state: "Todo" },
        attempt: null,
        timeoutMs: 500,
      });
      const elapsed = Date.now() - before;

      // Must finish well under the 60-second child sleep duration.
      expect(elapsed).toBeLessThan(5000);
      // Non-zero exit (killed) or null exit code — either signals termination.
      expect(result.ok).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("parseMetricTokens returns undefined when output contains no METRIC lines", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symphony-runner-nometric-"));
    try {
      const runner = new ShellAgentRunner({
        kind: "test",
        command: ["sh", "-c", "echo hello world"],
      });

      const result = await runner.run({
        workspacePath: workspace,
        prompt: "",
        issue: { id: "1", identifier: "ABC-1", title: "T", state: "Todo" },
        attempt: null,
      });

      expect(result.ok).toBe(true);
      expect(result.tokenUsage).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
