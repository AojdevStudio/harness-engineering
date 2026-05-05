export type RawWorkflowConfig = Record<string, unknown>;

export interface WorkflowDefinition {
  readonly path: string;
  readonly directory: string;
  readonly config: RawWorkflowConfig;
  readonly promptTemplate: string;
}

export interface TrackerConfig {
  readonly kind: "linear" | string;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly projectSlug: string;
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
}

export interface PollingConfig {
  readonly intervalMs: number;
}

export interface WorkspaceConfig {
  readonly root: string;
}

export interface HooksConfig {
  readonly afterCreate?: string;
  readonly beforeRun?: string;
  readonly afterRun?: string;
  readonly beforeRemove?: string;
  readonly timeoutMs: number;
}

export interface AgentConfig {
  readonly maxConcurrentAgents: number;
  readonly maxTurns: number;
  readonly maxRetryBackoffMs: number;
  readonly maxConcurrentAgentsByState: Readonly<Record<string, number>>;
}

export interface CodexConfig {
  readonly command: string;
  readonly approvalPolicy?: unknown;
  readonly threadSandbox?: unknown;
  readonly turnSandboxPolicy?: unknown;
  readonly turnTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly stallTimeoutMs: number;
}

export interface ServerConfig {
  readonly port?: number;
  readonly host: string;
}

export interface EvidenceArtifactRequirement {
  readonly kind: "log" | "screenshot" | "video" | "test-output" | "link" | "other" | string;
  readonly glob: string;
  readonly label?: string;
}

export interface UiEvidenceConfig {
  readonly requiredForLabels: readonly string[];
  readonly command?: string;
  readonly requiredArtifacts: readonly EvidenceArtifactRequirement[];
  readonly timeoutMs: number;
}

export interface EvidenceConfig {
  readonly ui?: UiEvidenceConfig;
}

export interface WorkflowStateConfig {
  readonly inProgress: string;
  readonly humanReview: string;
  readonly rework: string;
  readonly merging: string;
  readonly done: string;
}

export interface ResolvedWorkflowConfig {
  readonly tracker: TrackerConfig;
  readonly polling: PollingConfig;
  readonly workspace: WorkspaceConfig;
  readonly hooks: HooksConfig;
  readonly agent: AgentConfig;
  readonly codex: CodexConfig;
  readonly server: ServerConfig;
  readonly states: WorkflowStateConfig;
  readonly evidence: EvidenceConfig;
  readonly raw: RawWorkflowConfig;
  /** Keys present in WORKFLOW.md that are not recognized by the schema. Never throws — unknown keys are surfaced here so callers can emit warn-level events. */
  readonly warnings: readonly string[];
}

export interface IssueForPrompt {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string | null;
  readonly priority?: number | null;
  readonly state: string;
  readonly branchName?: string | null;
  readonly url?: string | null;
  readonly labels: readonly string[];
  readonly blockedBy?: readonly unknown[];
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
}

export interface PromptRenderInput {
  readonly issue: IssueForPrompt;
  readonly attempt?: number | null;
}
