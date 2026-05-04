import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseWorkflowMarkdown,
  renderWorkflowPrompt,
  resolveWorkflowConfig,
  validateDispatchConfig,
  WorkflowError,
} from "../src/index.ts";

describe("parseWorkflowMarkdown", () => {
  test("splits YAML front matter from prompt body", () => {
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      `---\ntracker:\n  kind: linear\n  project_slug: abc\n---\nHello {{ issue.identifier }}\n`,
    );

    expect(workflow.path).toBe(resolve("/repo/WORKFLOW.md"));
    expect(workflow.directory).toBe(resolve("/repo"));
    expect(workflow.config).toEqual({ tracker: { kind: "linear", project_slug: "abc" } });
    expect(workflow.promptTemplate).toBe("Hello {{ issue.identifier }}");
  });

  test("uses empty config when front matter is absent", () => {
    const workflow = parseWorkflowMarkdown("/repo/WORKFLOW.md", "Do work");
    expect(workflow.config).toEqual({});
    expect(workflow.promptTemplate).toBe("Do work");
  });

  test("rejects non-map YAML", () => {
    expect(() => parseWorkflowMarkdown("/repo/WORKFLOW.md", "---\n- nope\n---\nBody")).toThrow(WorkflowError);
  });
});

describe("resolveWorkflowConfig", () => {
  test("applies defaults and resolves LINEAR_API_KEY fallback", () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      `---\ntracker:\n  kind: linear\n  project_slug: abc\nworkspace:\n  root: .workspaces\n---\nPrompt`,
    );

    const config = resolveWorkflowConfig(workflow);

    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.tracker.apiKey).toBe("lin_test");
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.workspace.root).toBe(resolve("/repo/.workspaces"));
    expect(config.polling.intervalMs).toBe(30_000);
    expect(config.hooks.timeoutMs).toBe(60_000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.codex.command).toBe("codex exec --skip-git-repo-check --sandbox workspace-write -");
  });

  test("resolves explicit env references and dispatch validation", () => {
    process.env.MY_LINEAR_KEY = "lin_custom";
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      `---\ntracker:\n  kind: linear\n  api_key: $MY_LINEAR_KEY\n  project_slug: abc\ncodex:\n  command: \"codex --profile test app-server\"\nhooks:\n  after_run: bun test\n---\nPrompt`,
    );

    const config = resolveWorkflowConfig(workflow);

    expect(config.tracker.apiKey).toBe("lin_custom");
    expect(config.codex.command).toBe("codex --profile test app-server");
    expect(validateDispatchConfig(config)).toEqual([]);
  });

  test("resolves UI evidence gate config", () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      `---
tracker:
  kind: linear
  project_slug: abc
hooks:
  after_run: bun test
evidence:
  ui:
    required_for_labels: [ui, Frontend]
    command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR"
    required_artifacts:
      - kind: video
        glob: "*.webm"
      - kind: screenshot
        glob: "*.png"
      - kind: test-output
        glob: "*.txt"
---
Prompt`,
    );

    const config = resolveWorkflowConfig(workflow);

    expect(config.evidence.ui?.requiredForLabels).toEqual(["ui", "frontend"]);
    expect(config.evidence.ui?.requiredArtifacts.map((artifact) => artifact.kind)).toEqual(["video", "screenshot", "test-output"]);
    expect(validateDispatchConfig(config)).toEqual([]);
  });

  test("reports missing dispatch requirements", () => {
    delete process.env.LINEAR_API_KEY;
    const config = resolveWorkflowConfig(parseWorkflowMarkdown("/repo/WORKFLOW.md", "---\ntracker:\n  kind: linear\n---\nPrompt"));

    expect(validateDispatchConfig(config)).toEqual([
      "tracker.api_key or LINEAR_API_KEY is required",
      "tracker.project_slug is required",
      "hooks.after_run validation command is required",
    ]);
  });

  test("uses system temp workspace root by default", () => {
    const config = resolveWorkflowConfig(parseWorkflowMarkdown("/repo/WORKFLOW.md", "Prompt"));
    expect(config.workspace.root).toBe(resolve(tmpdir(), "symphony_workspaces"));
  });

  test("emits warning for unknown top-level key", () => {
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      `---\nmystery: foo\ntracker:\n  kind: linear\n---\nPrompt`,
    );
    const config = resolveWorkflowConfig(workflow);
    expect(config.warnings).toContain("unknown key: mystery");
  });

  test("emits warning for unknown nested key inside tracker", () => {
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      `---\ntracker:\n  kind: linear\n  experimental: true\n---\nPrompt`,
    );
    const config = resolveWorkflowConfig(workflow);
    expect(config.warnings).toContain("unknown key: tracker.experimental");
  });

  test("warnings is empty array when all keys are known", () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      `---\ntracker:\n  kind: linear\n  project_slug: abc\npolling:\n  interval_ms: 5000\n---\nPrompt`,
    );
    const config = resolveWorkflowConfig(workflow);
    expect(config.warnings).toEqual([]);
  });

  test("existing resolved config fields remain intact alongside warnings", () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      `---\ntracker:\n  kind: linear\n  project_slug: abc\nmystery: foo\n---\nPrompt`,
    );
    const config = resolveWorkflowConfig(workflow);
    // existing fields still resolve correctly
    expect(config.tracker.kind).toBe("linear");
    expect(config.tracker.projectSlug).toBe("abc");
    expect(config.polling.intervalMs).toBe(30_000);
    // new warnings field present
    expect(config.warnings).toContain("unknown key: mystery");
  });
});

describe("renderWorkflowPrompt", () => {
  test("renders issue and attempt context with Liquid", async () => {
    const workflow = parseWorkflowMarkdown(
      "/repo/WORKFLOW.md",
      "Ticket {{ issue.identifier }} attempt={% if attempt %}{{ attempt }}{% else %}first{% endif %}",
    );

    await expect(
      renderWorkflowPrompt(workflow, {
        attempt: 2,
        issue: {
          id: "1",
          identifier: "ABC-1",
          title: "Test",
          state: "Todo",
          labels: [],
        },
      }),
    ).resolves.toBe("Ticket ABC-1 attempt=2");
  });

  test("falls back to default prompt when body is blank", async () => {
    const workflow = parseWorkflowMarkdown("/repo/WORKFLOW.md", "---\n{}\n---\n");
    const prompt = await renderWorkflowPrompt(workflow, {
      issue: {
        id: "1",
        identifier: "ABC-1",
        title: "Test issue",
        description: null,
        state: "Todo",
        labels: [],
      },
    });

    expect(prompt).toContain("ABC-1");
    expect(prompt).toContain("Test issue");
  });
});
