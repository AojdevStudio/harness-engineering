import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { WorkflowError } from "./errors.ts";
import type { RawWorkflowConfig, ResolvedWorkflowConfig, WorkflowDefinition } from "./types.ts";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"] as const;
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"] as const;

const workflowSchema = z
  .object({
    tracker: z
      .object({
        kind: z.string().optional(),
        endpoint: z.string().optional(),
        api_key: z.string().optional(),
        project_slug: z.string().optional(),
        active_states: z.array(z.string()).optional(),
        terminal_states: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    polling: z
      .object({
        interval_ms: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    workspace: z
      .object({
        root: z.string().optional(),
      })
      .passthrough()
      .optional(),
    hooks: z
      .object({
        after_create: z.string().optional(),
        before_run: z.string().optional(),
        after_run: z.string().optional(),
        before_remove: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    agent: z
      .object({
        max_concurrent_agents: z.number().int().positive().optional(),
        max_turns: z.number().int().positive().optional(),
        max_retry_backoff_ms: z.number().int().positive().optional(),
        max_concurrent_agents_by_state: z.record(z.string(), z.number().int().positive()).optional(),
      })
      .passthrough()
      .optional(),
    codex: z
      .object({
        command: z.string().optional(),
        approval_policy: z.unknown().optional(),
        thread_sandbox: z.unknown().optional(),
        turn_sandbox_policy: z.unknown().optional(),
        turn_timeout_ms: z.number().int().positive().optional(),
        read_timeout_ms: z.number().int().positive().optional(),
        stall_timeout_ms: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    server: z
      .object({
        port: z.number().int().nonnegative().optional(),
        host: z.string().optional(),
      })
      .passthrough()
      .optional(),
    evidence: z
      .object({
        ui: z
          .object({
            required_for_labels: z.array(z.string()).optional(),
            command: z.string().optional(),
            required_artifacts: z
              .array(
                z
                  .object({
                    kind: z.string(),
                    glob: z.string(),
                    label: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            timeout_ms: z.number().int().positive().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    states: z
      .object({
        in_progress: z.string().optional(),
        human_review: z.string().optional(),
        rework: z.string().optional(),
        merging: z.string().optional(),
        done: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

function resolveEnvReference(value: string | undefined, fallbackEnvName?: string): string | undefined {
  if (value == null || value.trim() === "") {
    return fallbackEnvName ? readEnv(fallbackEnvName) : undefined;
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("$") && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return readEnv(trimmed.slice(1));
  }

  return value;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function resolvePathValue(path: string | undefined, workflowDirectory: string, defaultPath: string): string {
  const envResolved = resolveEnvReference(path);
  const raw = envResolved ?? defaultPath;
  const homeExpanded = expandHome(raw);
  return isAbsolute(homeExpanded) ? resolve(homeExpanded) : resolve(workflowDirectory, homeExpanded);
}

function compactOptionalString(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : value;
}

/**
 * Allowed keys per config block, mirroring the Zod schema exactly.
 * Extend this map whenever the schema gains a new field.
 */
const KNOWN_KEYS: Record<string, readonly string[]> = {
  "": ["tracker", "polling", "workspace", "hooks", "agent", "codex", "server", "evidence", "states"],
  tracker: ["kind", "endpoint", "api_key", "project_slug", "active_states", "terminal_states"],
  polling: ["interval_ms"],
  workspace: ["root"],
  hooks: ["after_create", "before_run", "after_run", "before_remove", "timeout_ms"],
  agent: ["max_concurrent_agents", "max_turns", "max_retry_backoff_ms", "max_concurrent_agents_by_state"],
  codex: ["command", "approval_policy", "thread_sandbox", "turn_sandbox_policy", "turn_timeout_ms", "read_timeout_ms", "stall_timeout_ms"],
  server: ["port", "host"],
  evidence: ["ui"],
  "evidence.ui": ["required_for_labels", "command", "required_artifacts", "timeout_ms"],
  states: ["in_progress", "human_review", "rework", "merging", "done"],
};

/**
 * Walk the raw config object one level deep per known section, collecting any
 * key that is not present in KNOWN_KEYS. Returns messages like
 * "unknown key: tracker.experimental" that callers can surface as warnings.
 */
function findUnknownKeys(raw: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  // Check top-level keys
  const knownTopLevel = KNOWN_KEYS[""] ?? [];
  for (const key of Object.keys(raw)) {
    if (!knownTopLevel.includes(key)) {
      warnings.push(`unknown key: ${key}`);
    }
  }

  // Check one level inside each known top-level section
  for (const section of knownTopLevel) {
    const sectionValue = raw[section];
    if (sectionValue == null || typeof sectionValue !== "object" || Array.isArray(sectionValue)) {
      continue;
    }
    const sectionObj = sectionValue as Record<string, unknown>;
    const knownSectionKeys = KNOWN_KEYS[section] ?? [];
    for (const key of Object.keys(sectionObj)) {
      if (!knownSectionKeys.includes(key)) {
        warnings.push(`unknown key: ${section}.${key}`);
      }
    }

    // Check one level inside nested sub-sections (e.g. evidence.ui)
    const nestedSectionKey = section;
    for (const subSection of knownSectionKeys) {
      const subValue = sectionObj[subSection];
      if (subValue == null || typeof subValue !== "object" || Array.isArray(subValue)) {
        continue;
      }
      const nestedKey = `${nestedSectionKey}.${subSection}`;
      const knownNestedKeys = KNOWN_KEYS[nestedKey];
      if (knownNestedKeys == null) continue;
      const subObj = subValue as Record<string, unknown>;
      for (const key of Object.keys(subObj)) {
        if (!knownNestedKeys.includes(key)) {
          warnings.push(`unknown key: ${nestedKey}.${key}`);
        }
      }
    }
  }

  return warnings;
}

export function resolveWorkflowConfig(workflow: WorkflowDefinition): ResolvedWorkflowConfig {
  const parsed = workflowSchema.safeParse(workflow.config);
  if (!parsed.success) {
    throw new WorkflowError(
      "config_validation_error",
      "WORKFLOW.md config has invalid field types",
      parsed.error.flatten(),
    );
  }

  const raw = parsed.data as RawWorkflowConfig & z.infer<typeof workflowSchema>;
  const warnings = findUnknownKeys(workflow.config as Record<string, unknown>);
  const tracker = raw.tracker ?? {};
  const trackerKind = tracker.kind ?? "linear";
  const trackerEndpoint = tracker.endpoint ?? (trackerKind === "linear" ? "https://api.linear.app/graphql" : "");
  const apiKey = resolveEnvReference(tracker.api_key, trackerKind === "linear" ? "LINEAR_API_KEY" : undefined);
  const projectSlug = compactOptionalString(tracker.project_slug) ?? "";

  const workspaceRoot = resolvePathValue(
    raw.workspace?.root,
    workflow.directory,
    resolve(tmpdir(), "symphony_workspaces"),
  );
  const uiEvidenceCommand = compactOptionalString(raw.evidence?.ui?.command);
  const uiEvidence = raw.evidence?.ui
    ? {
        requiredForLabels: raw.evidence.ui.required_for_labels?.map((label) => label.toLowerCase()) ?? [],
        ...(uiEvidenceCommand !== undefined ? { command: uiEvidenceCommand } : {}),
        requiredArtifacts:
          raw.evidence.ui.required_artifacts?.map((artifact) => ({
            kind: artifact.kind,
            glob: artifact.glob,
            ...(artifact.label !== undefined ? { label: artifact.label } : {}),
          })) ?? [],
        timeoutMs: raw.evidence.ui.timeout_ms ?? 300_000,
      }
    : undefined;

  return {
    tracker: {
      kind: trackerKind,
      endpoint: trackerEndpoint,
      ...(apiKey ? { apiKey } : {}),
      projectSlug,
      activeStates: tracker.active_states ?? [...DEFAULT_ACTIVE_STATES],
      terminalStates: tracker.terminal_states ?? [...DEFAULT_TERMINAL_STATES],
    },
    polling: {
      intervalMs: raw.polling?.interval_ms ?? 30_000,
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      ...(raw.hooks?.after_create != null ? { afterCreate: raw.hooks.after_create } : {}),
      ...(raw.hooks?.before_run != null ? { beforeRun: raw.hooks.before_run } : {}),
      ...(raw.hooks?.after_run != null ? { afterRun: raw.hooks.after_run } : {}),
      ...(raw.hooks?.before_remove != null ? { beforeRemove: raw.hooks.before_remove } : {}),
      timeoutMs: raw.hooks?.timeout_ms ?? 60_000,
    },
    agent: {
      maxConcurrentAgents: raw.agent?.max_concurrent_agents ?? 10,
      maxTurns: raw.agent?.max_turns ?? 20,
      maxRetryBackoffMs: raw.agent?.max_retry_backoff_ms ?? 300_000,
      maxConcurrentAgentsByState: raw.agent?.max_concurrent_agents_by_state ?? {},
    },
    codex: {
      command: compactOptionalString(raw.codex?.command) ?? "codex exec --skip-git-repo-check --sandbox workspace-write -",
      ...(raw.codex?.approval_policy !== undefined ? { approvalPolicy: raw.codex.approval_policy } : {}),
      ...(raw.codex?.thread_sandbox !== undefined ? { threadSandbox: raw.codex.thread_sandbox } : {}),
      ...(raw.codex?.turn_sandbox_policy !== undefined ? { turnSandboxPolicy: raw.codex.turn_sandbox_policy } : {}),
      turnTimeoutMs: raw.codex?.turn_timeout_ms ?? 3_600_000,
      readTimeoutMs: raw.codex?.read_timeout_ms ?? 5_000,
      stallTimeoutMs: raw.codex?.stall_timeout_ms ?? 300_000,
    },
    server: {
      ...(raw.server?.port !== undefined ? { port: raw.server.port } : {}),
      host: raw.server?.host ?? "127.0.0.1",
    },
    states: {
      inProgress: raw.states?.in_progress ?? "In Progress",
      humanReview: raw.states?.human_review ?? "Human Review",
      rework: raw.states?.rework ?? "Rework",
      merging: raw.states?.merging ?? "Merging",
      done: raw.states?.done ?? "Done",
    },
    evidence: {
      ...(uiEvidence !== undefined ? { ui: uiEvidence } : {}),
    },
    raw: workflow.config,
    warnings,
  };
}

export function validateDispatchConfig(config: ResolvedWorkflowConfig): string[] {
  const errors: string[] = [];

  if (!config.tracker.kind) errors.push("tracker.kind is required");
  if (config.tracker.kind !== "linear") errors.push(`unsupported tracker.kind: ${config.tracker.kind}`);
  if (!config.tracker.apiKey) errors.push("tracker.api_key or LINEAR_API_KEY is required");
  if (!config.tracker.projectSlug) errors.push("tracker.project_slug is required");
  if (!config.codex.command.trim()) errors.push("codex.command is required");
  if (!config.hooks.afterRun?.trim()) errors.push("hooks.after_run validation command is required");
  if (config.evidence.ui?.requiredForLabels.length && !config.evidence.ui.command?.trim()) errors.push("evidence.ui.command is required when evidence.ui.required_for_labels is set");
  if (config.evidence.ui?.command?.trim() && config.evidence.ui.requiredArtifacts.length === 0) errors.push("evidence.ui.required_artifacts is required when evidence.ui.command is set");

  return errors;
}
