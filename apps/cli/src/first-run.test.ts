import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor, runInit, type CliCommandRunner } from "./first-run.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "symphony-cli-first-run-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function passingRunner(): CliCommandRunner {
  return async (command) => {
    const joined = command.join(" ");
    if (joined.includes("command -v gh")) return { exitCode: 0, stdout: "/usr/bin/gh\n", stderr: "" };
    if (joined.includes("command -v codex")) return { exitCode: 0, stdout: "/usr/bin/codex\n", stderr: "" };
    if (joined.includes("command -v bun")) return { exitCode: 0, stdout: "/usr/bin/bun\n", stderr: "" };
    if (joined.startsWith("gh auth status")) return { exitCode: 0, stdout: "Logged in\n", stderr: "" };
    if (joined.includes("git -C")) return { exitCode: 0, stdout: "/repo\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

async function withUnsetEnv<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return await fn();
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

async function configureReadyWorkflow(dir: string): Promise<void> {
  const workflowPath = join(dir, "WORKFLOW.md");
  const workflow = (await readFile(workflowPath, "utf8")).replace(
    "REPLACE_WITH_LINEAR_PROJECT_SLUG",
    "proj",
  );
  await writeFile(workflowPath, workflow, "utf8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { "evidence:ui": "node evidence.js" } }, null, 2),
    "utf8",
  );
}

function enableUiEvidence(workflow: string): string {
  return workflow.replace(
    "\n---\n\nYou are working on Linear issue",
    `\nevidence:\n  ui:\n    required_for_labels:\n      - ui\n    command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR"\n    required_artifacts:\n      - kind: screenshot\n        glob: "*.png"\n---\n\nYou are working on Linear issue`,
  );
}

describe("runInit", () => {
  test("creates first-run files and local state directories", async () => {
    await withTempDir(async (dir) => {
      const result = await runInit({ cwd: dir });

      expect(result.actions.map((action) => action.status)).toContain("created");
      const workflow = await readFile(join(dir, "WORKFLOW.md"), "utf8");
      expect(workflow).toContain("project_slug");
      expect(workflow).toContain("- Rework");
      expect(await readFile(join(dir, ".env"), "utf8")).toContain("LINEAR_API_KEY=");
      expect(result.next.join("\n")).toContain("symphony doctor WORKFLOW.md");
      expect(result.next.join("\n")).not.toContain("bun run symphony");
    });
  });

  test("skips existing files unless force is set", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "WORKFLOW.md"), "keep me", "utf8");

      const result = await runInit({ cwd: dir });

      expect(result.actions).toContainEqual({ path: join(dir, "WORKFLOW.md"), status: "skipped" });
      expect(await readFile(join(dir, "WORKFLOW.md"), "utf8")).toBe("keep me");
    });
  });
});

describe("runDoctor", () => {
  test("passes local readiness checks with configured workflow and tools", async () => {
    await withTempDir(async (dir) => {
      await runInit({ cwd: dir });
      await configureReadyWorkflow(dir);
      const oldLinearApiKey = process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_API_KEY;

      try {
        const result = await runDoctor({
          cwd: dir,
          runner: passingRunner(),
          env: {
            LINEAR_API_KEY: "lin_test",
            SYMPHONY_AUTH_TOKEN: "secret",
            SYMPHONY_RUNNER: "codex",
            SYMPHONY_SOURCE_REPO: "",
            SYMPHONY_BASE_REF: "HEAD",
          },
        });

        expect(result.ok).toBe(true);
        expect(result.summary.fail).toBe(0);
        expect(result.checks.find((item) => item.name === "workflow.dispatch")?.status).toBe("pass");
        expect(result.checks.find((item) => item.name === "github.auth")?.status).toBe("pass");
        expect(result.checks.find((item) => item.name === "runner.command")?.status).toBe("pass");
        expect(result.next.join("\n")).toContain("symphony validate WORKFLOW.md --live-tracker");
        expect(result.next.join("\n")).not.toContain("bun run symphony");
      } finally {
        if (oldLinearApiKey === undefined) {
          delete process.env.LINEAR_API_KEY;
        } else {
          process.env.LINEAR_API_KEY = oldLinearApiKey;
        }
      }
    });
  });

  test("fails when WORKFLOW.md is missing", async () => {
    await withTempDir(async (dir) => {
      const result = await runDoctor({
        cwd: dir,
        runner: passingRunner(),
        env: {
          LINEAR_API_KEY: "lin_test",
          SYMPHONY_AUTH_TOKEN: "secret",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.checks.find((item) => item.name === "workflow.load")?.status).toBe("fail");
    });
  });

  test("fails when the generated Linear project slug has not been replaced", async () => {
    await withTempDir(async (dir) => {
      await runInit({ cwd: dir });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { "evidence:ui": "node evidence.js" } }, null, 2),
        "utf8",
      );

      const result = await runDoctor({
        cwd: dir,
        runner: passingRunner(),
        env: {
          LINEAR_API_KEY: "lin_test",
          SYMPHONY_AUTH_TOKEN: "secret",
          SYMPHONY_BASE_REF: "HEAD",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.checks.find((item) => item.name === "linear.project_slug")?.status).toBe("fail");
      expect(result.checks.find((item) => item.name === "workflow.dispatch")?.status).toBe("fail");
    });
  });

  test("fails when configured UI evidence bun script is missing", async () => {
    await withTempDir(async (dir) => {
      await runInit({ cwd: dir });
      const workflowPath = join(dir, "WORKFLOW.md");
      const workflow = (await readFile(workflowPath, "utf8")).replace(
        "REPLACE_WITH_LINEAR_PROJECT_SLUG",
        "proj",
      );
      await writeFile(workflowPath, enableUiEvidence(workflow), "utf8");
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: {} }), "utf8");

      const result = await runDoctor({
        cwd: dir,
        runner: passingRunner(),
        env: {
          LINEAR_API_KEY: "lin_test",
          SYMPHONY_AUTH_TOKEN: "secret",
          SYMPHONY_BASE_REF: "HEAD",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.checks.find((item) => item.name === "evidence.ui")?.status).toBe("fail");
    });
  });

  test("loads .env beside an absolute workflow path", async () => {
    await withTempDir(async (dir) => {
      await runInit({ cwd: dir });
      await configureReadyWorkflow(dir);
      await writeFile(
        join(dir, ".env"),
        [
          "LINEAR_API_KEY=lin_from_file",
          "SYMPHONY_AUTH_TOKEN=secret_from_file",
          "SYMPHONY_BASE_REF=HEAD",
          "",
        ].join("\n"),
        "utf8",
      );

      await withUnsetEnv(
        ["LINEAR_API_KEY", "SYMPHONY_AUTH_TOKEN", "SYMPHONY_BASE_REF", "SYMPHONY_SOURCE_REPO"],
        async () => {
          const result = await runDoctor({
            cwd: tmpdir(),
            workflowPath: join(dir, "WORKFLOW.md"),
            runner: passingRunner(),
          });

          expect(result.ok).toBe(true);
          expect(result.checks.find((item) => item.name === "linear.api_key")?.status).toBe("pass");
          expect(result.checks.find((item) => item.name === "server.auth")?.status).toBe("pass");
        },
      );
    });
  });

  test("checks clone-mode base refs against the remote repo url", async () => {
    await withTempDir(async (dir) => {
      await runInit({ cwd: dir });
      await configureReadyWorkflow(dir);

      const commands: string[] = [];
      const runner: CliCommandRunner = async (command) => {
        commands.push(command.join(" "));
        if (command[0] === "git" && command[1] === "ls-remote") {
          return { exitCode: 0, stdout: "abc\trefs/heads/main\n", stderr: "" };
        }
        return passingRunner()(command, {});
      };

      const result = await runDoctor({
        cwd: dir,
        runner,
        env: {
          LINEAR_API_KEY: "lin_test",
          SYMPHONY_AUTH_TOKEN: "secret",
          SYMPHONY_WORKSPACE_MODE: "clone",
          SYMPHONY_REPO_URL: "git@example.com:org/repo.git",
          SYMPHONY_BASE_REF: "main",
        },
      });

      expect(result.checks.find((item) => item.name === "workspace.base_ref")?.status).toBe("pass");
      expect(commands).toContain("git ls-remote --exit-code git@example.com:org/repo.git main");
      expect(commands.some((command) => command.includes("git -C"))).toBe(false);
    });
  });
});
