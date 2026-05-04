export type IssueId = string;
export type IssueIdentifier = string;

export type OrchestrationClaimState =
  | "unclaimed"
  | "claimed"
  | "running"
  | "retry_queued"
  | "released";

export type RunAttemptStatus =
  | "created"
  | "preparing_workspace"
  | "workspace_ready"
  | "building_prompt"
  | "launching_agent_process"
  | "initializing_session"
  | "streaming_turn"
  | "finishing"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stalled"
  | "canceled_by_reconciliation";

export interface NormalizedIssue {
  readonly id: IssueId;
  readonly identifier: IssueIdentifier;
  readonly title: string;
  readonly description?: string | null;
  readonly priority?: number | null;
  readonly state: string;
  readonly branchName?: string | null;
  readonly url?: string | null;
  readonly labels: readonly string[];
  readonly blockedBy: readonly IssueBlockerRef[];
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
}

export interface IssueBlockerRef {
  readonly id?: string | null;
  readonly identifier?: string | null;
  readonly state?: string | null;
}

export interface WorkspaceRef {
  readonly path: string;
  readonly workspaceKey: string;
  readonly createdNow: boolean;
}

export interface RunAttemptRef {
  readonly issueId: IssueId;
  readonly issueIdentifier: IssueIdentifier;
  readonly attempt: number | null;
  readonly workspacePath: string;
  readonly startedAt: string;
  readonly status: RunAttemptStatus;
  readonly error?: string;
}

export interface RetryEntry {
  readonly issueId: IssueId;
  readonly identifier: IssueIdentifier;
  readonly attempt: number;
  readonly dueAtMs: number;
  readonly error?: string | null;
}

export function normalizeIssueState(state: string): string {
  return state.toLowerCase();
}

export function sanitizeWorkspaceKey(identifier: string): string {
  // Strip characters outside safe set.
  // Downstream assertPathInsideRoot is a second line of defense for traversal.
  let key = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  // Prevent leading dots (hidden files / `..` as the whole key causes
  // relative-path confusion even if downstream checks exist).
  if (key === "." || key === ".." || key.startsWith(".")) {
    key = `_${key.replace(/^\.+/, "")}`;
  }
  return key;
}

export function isTerminalState(state: string, terminalStates: readonly string[]): boolean {
  const normalized = normalizeIssueState(state);
  return terminalStates.some((candidate) => normalizeIssueState(candidate) === normalized);
}

export function isActiveState(state: string, activeStates: readonly string[]): boolean {
  const normalized = normalizeIssueState(state);
  return activeStates.some((candidate) => normalizeIssueState(candidate) === normalized);
}
