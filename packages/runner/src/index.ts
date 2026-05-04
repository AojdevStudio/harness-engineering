export interface RunnerIssueContext {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly state: string;
  readonly url?: string | null;
}

export interface RunnerInput {
  readonly workspacePath: string;
  readonly prompt: string;
  readonly issue: RunnerIssueContext;
  readonly attempt: number | null;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly onEvent?: (event: RunnerEvent) => void | Promise<void>;
}

export interface RunnerEvent {
  readonly type: string;
  readonly message: string;
  readonly stream?: "stdout" | "stderr";
  readonly payload?: unknown;
  readonly timestamp: string;
}

export interface RunnerResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tokenUsage?: TokenUsage;
  readonly error?: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AgentRunner {
  readonly kind: string;
  run(input: RunnerInput): Promise<RunnerResult>;
}

export interface ShellRunnerOptions {
  readonly kind: string;
  readonly command: readonly string[];
  readonly inheritEnv?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parses optional METRIC lines from runner stdout/stderr in the form:
 *   METRIC input_tokens=N
 *   METRIC output_tokens=N
 *   METRIC total_tokens=N
 * Codex/Pi do not emit these by default. To populate token accounting,
 * agents must emit these lines or this parser must be replaced with
 * a runner-specific implementation. Returns undefined if no METRIC lines present.
 */
function parseMetricTokens(output: string): TokenUsage | undefined {
  const input = output.match(/METRIC\s+input_tokens=(\d+)/)?.[1];
  const outputTokens = output.match(/METRIC\s+output_tokens=(\d+)/)?.[1];
  const total = output.match(/METRIC\s+total_tokens=(\d+)/)?.[1];
  if (!input && !outputTokens && !total) return undefined;
  return {
    inputTokens: input ? Number(input) : 0,
    outputTokens: outputTokens ? Number(outputTokens) : 0,
    totalTokens: total ? Number(total) : Number(input ?? 0) + Number(outputTokens ?? 0),
  };
}

export class ShellAgentRunner implements AgentRunner {
  readonly kind: string;
  private readonly command: readonly string[];
  private readonly inheritEnv: boolean;

  constructor(options: ShellRunnerOptions) {
    this.kind = options.kind;
    this.command = options.command;
    this.inheritEnv = options.inheritEnv ?? true;
  }

  async run(input: RunnerInput): Promise<RunnerResult> {
    const startedAt = nowIso();
    await input.onEvent?.({ type: "runner.started", message: `${this.kind} runner started`, timestamp: startedAt });

    const env = {
      ...(this.inheritEnv ? process.env : {}),
      ...input.env,
      SYMPHONY_PROMPT: input.prompt,
      SYMPHONY_ISSUE_ID: input.issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: input.issue.identifier,
      SYMPHONY_ATTEMPT: input.attempt == null ? "" : String(input.attempt),
    } as Record<string, string>;

    const proc = Bun.spawn([...this.command], {
      cwd: input.workspacePath,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    const timeout = input.timeoutMs
      ? setTimeout(() => {
          try {
            // Negative pid targets the entire process group so child forks also die.
            process.kill(-proc.pid, "SIGTERM");
          } catch {
            // Process may have already exited — safe to ignore.
          }
        }, input.timeoutMs)
      : null;

    try {
      proc.stdin.write(input.prompt);
      proc.stdin.end();

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      const finishedAt = nowIso();
      if (stdout.trim()) {
        await input.onEvent?.({ type: "runner.output", stream: "stdout", message: stdout.slice(-4000), timestamp: finishedAt });
      }
      if (stderr.trim()) {
        await input.onEvent?.({ type: "runner.output", stream: "stderr", message: stderr.slice(-4000), timestamp: finishedAt });
      }

      const tokenUsage = parseMetricTokens(`${stdout}\n${stderr}`);
      return {
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        startedAt,
        finishedAt,
        ...(tokenUsage ? { tokenUsage } : {}),
        ...(exitCode === 0 ? {} : { error: `${this.kind} exited ${exitCode}` }),
      };
    } catch (error) {
      const finishedAt = nowIso();
      const message = error instanceof Error ? error.message : String(error);
      await input.onEvent?.({ type: "runner.failed", message, timestamp: finishedAt });
      return { ok: false, exitCode: null, stdout: "", stderr: "", startedAt, finishedAt, error: message };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export function createCodexRunner(command = "codex exec --skip-git-repo-check --sandbox workspace-write -"): AgentRunner {
  return new ShellAgentRunner({ kind: "codex", command: ["sh", "-c", command] });
}

export function createPiRunner(command = "pi --print"): AgentRunner {
  return new ShellAgentRunner({ kind: "pi", command: ["sh", "-c", command] });
}
