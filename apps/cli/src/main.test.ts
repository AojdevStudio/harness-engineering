import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openSymphonyDatabase } from "@symphony/db";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "symphony-cli-main-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", resolve("apps/cli/src/main.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnvForCli(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function cleanEnvForCli(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key === "LINEAR_API_KEY" ||
      key.startsWith("SYMPHONY_")
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

describe("symphony cli", () => {
  test("serve loads auth settings from workflow-local .env before auth gate", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: proj
workspace:
  root: ./.symphony/workspaces
server:
  port: 0
states:
  human_review: Human Review
  merging: Merging
---
Prompt`,
        "utf8",
      );
      await writeFile(
        join(dir, ".env"),
        [
          "LINEAR_API_KEY=lin_from_file",
          "SYMPHONY_AUTH_TOKEN=secret_from_file",
          "SYMPHONY_RUNNER=codex",
          "SYMPHONY_CODEX_COMMAND=true",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(["serve", join(dir, "WORKFLOW.md")], process.cwd());

      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain("server.no_auth_no_insecure");
      expect(result.stderr).toContain("hooks.after_run validation command is required");
    });
  });

  test("serve without auth does not recover interrupted runs before refusing startup", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, ".symphony/symphony.db");
      await mkdir(join(dir, ".symphony"), { recursive: true });
      const db = openSymphonyDatabase({ path: dbPath });
      try {
        db.claimAndCreateRun(
          { issueId: "issue-1", identifier: "ABC-1", state: "In Progress", runId: "run-live" },
          { runId: "run-live", issueId: "issue-1", identifier: "ABC-1", status: "running" },
        );
      } finally {
        db.close();
      }

      await writeFile(
        join(dir, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: proj
workspace:
  root: ./.symphony/workspaces
hooks:
  after_run: bun test
server:
  port: 0
states:
  human_review: Human Review
  merging: Merging
---
Prompt`,
        "utf8",
      );
      await writeFile(
        join(dir, ".env"),
        [
          "LINEAR_API_KEY=lin_from_file",
          "SYMPHONY_DB_PATH=.symphony/symphony.db",
          "SYMPHONY_RUNNER=codex",
          "SYMPHONY_CODEX_COMMAND=true",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(["serve", join(dir, "WORKFLOW.md")], process.cwd());
      const reopened = openSymphonyDatabase({ path: dbPath });
      try {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("server.no_auth_no_insecure");
        expect(reopened.getRun("run-live")?.status).toBe("running");
        const claims = reopened.database.query("SELECT * FROM claims WHERE run_id = ?").all("run-live") as unknown[];
        expect(claims).toHaveLength(1);
      } finally {
        reopened.close();
      }
    });
  });
});
