import type { NormalizedIssue } from "@symphony/core";
import type { TrackerConfig } from "@symphony/workflow";

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LinearClientOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetchImpl?: FetchLike;
}

export interface LinearGraphQLError {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly extensions?: unknown;
}

export class LinearClientError extends Error {
  readonly status: number | undefined;
  readonly errors: readonly LinearGraphQLError[] | undefined;
  readonly responseBody: unknown;

  constructor(message: string, details: { readonly status?: number; readonly errors?: readonly LinearGraphQLError[]; readonly responseBody?: unknown } = {}) {
    super(message);
    this.name = "LinearClientError";
    this.status = details.status;
    this.errors = details.errors;
    this.responseBody = details.responseBody;
  }
}

export class LinearClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: LinearClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // P1-B: retry on 429 and 5xx with exponential backoff, capped at 3 attempts
  async request<TData>(query: string, variables: Record<string, unknown> = {}): Promise<TData> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        await new Promise((r) => setTimeout(r, backoff));
      }

      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: this.apiKey,
          },
          body: JSON.stringify({ query, variables }),
        });

        if (response.status === 429) {
          // Read Retry-After header if available; otherwise let the outer loop handle backoff
          const retryAfterRaw = response.headers.get("retry-after");
          const retryAfter = parseInt(retryAfterRaw ?? "", 10);
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
          }
          lastError = new LinearClientError("Linear rate-limited (HTTP 429)", { status: 429 });
          continue;
        }

        if (response.status >= 500 && response.status < 600) {
          lastError = new LinearClientError(`Linear server error (HTTP ${response.status})`, { status: response.status });
          continue;
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          throw new LinearClientError("Linear returned a non-JSON response", {
            status: response.status,
            responseBody: error,
          });
        }

        if (!response.ok) {
          throw new LinearClientError(`Linear request failed with HTTP ${response.status}`, {
            status: response.status,
            responseBody: body,
          });
        }

        const envelope = body as { data?: TData; errors?: readonly LinearGraphQLError[] };
        if (envelope.errors && envelope.errors.length > 0) {
          throw new LinearClientError("Linear GraphQL errors", {
            status: response.status,
            errors: envelope.errors,
            responseBody: body,
          });
        }

        if (envelope.data === undefined) {
          throw new LinearClientError("Linear response did not include data", {
            status: response.status,
            responseBody: body,
          });
        }

        return envelope.data;
      } catch (err) {
        // Only retry network-level errors (not LinearClientError throws from above
        // which are deliberate control flow for non-retriable conditions)
        if (err instanceof LinearClientError) {
          throw err;
        }
        lastError = err;
        // continue to next retry attempt
      }
    }

    throw lastError ?? new LinearClientError("Linear request failed after retries");
  }
}

type LinearIssueNode = {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  branchName?: unknown;
  branch_name?: unknown;
  url?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  state?: { name?: unknown } | null;
  labels?: { nodes?: readonly { name?: unknown }[] } | null;
  relations?: { nodes?: readonly { type?: unknown; relatedIssue?: LinearIssueNode | null }[] } | null;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeLinearIssue(node: LinearIssueNode): NormalizedIssue | null {
  const id = stringOrNull(node.id);
  const identifier = stringOrNull(node.identifier);
  const title = stringOrNull(node.title);
  const state = stringOrNull(node.state?.name);

  if (!id || !identifier || !title || !state) {
    return null;
  }

  const labels =
    node.labels?.nodes
      ?.map((label) => stringOrNull(label.name)?.toLowerCase())
      .filter((label): label is string => Boolean(label)) ?? [];

  const blockedBy =
    node.relations?.nodes
      ?.filter((relation) => relation.type === "blocked_by")
      .map((relation) => relation.relatedIssue)
      .filter((issue): issue is LinearIssueNode => Boolean(issue))
      .map((issue) => ({
        id: stringOrNull(issue.id),
        identifier: stringOrNull(issue.identifier),
        state: stringOrNull(issue.state?.name),
      })) ?? [];

  return {
    id,
    identifier,
    title,
    description: stringOrNull(node.description),
    priority: numberOrNull(node.priority),
    state,
    branchName: stringOrNull(node.branchName) ?? stringOrNull(node.branch_name),
    url: stringOrNull(node.url),
    labels,
    blockedBy,
    createdAt: stringOrNull(node.createdAt),
    updatedAt: stringOrNull(node.updatedAt),
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  relations { nodes { type relatedIssue { id identifier state { name } } } }
`;

export interface LinearTrackerPreflightResult {
  readonly ok: boolean;
  readonly project?: {
    readonly id: string;
    readonly name: string;
    readonly slugId: string;
    readonly teams: readonly { readonly id: string; readonly key: string; readonly name: string }[];
  };
  readonly availableStates: readonly string[];
  readonly missingStates: readonly string[];
  readonly checkedStates: readonly string[];
}

// Shape returned by paginated issue queries
type PaginatedIssuesData = {
  issues: {
    nodes: readonly LinearIssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const MAX_PAGINATED_ISSUES = 1000;

export class LinearTrackerAdapter {
  private readonly client: LinearClient;
  private readonly config: TrackerConfig;
  // P2: cache (teamId:stateName) → stateId to avoid redundant GraphQL calls
  private readonly stateCache = new Map<string, string>();

  constructor(config: TrackerConfig, client?: LinearClient) {
    if (!config.apiKey) {
      throw new LinearClientError("Linear tracker requires an API key");
    }
    this.config = config;
    this.client = client ?? new LinearClient({ endpoint: config.endpoint, apiKey: config.apiKey });
  }

  async preflight(requiredStates: readonly string[] = []): Promise<LinearTrackerPreflightResult> {
    const data = await this.client.request<{
      projects: {
        nodes: readonly {
          id: string;
          name: string;
          slugId: string;
          teams: {
            nodes: readonly {
              id: string;
              key: string;
              name: string;
              states: { nodes: readonly { name: string }[] };
            }[];
          };
        }[];
      };
    }>(
      `query SymphonyProjectPreflight($projectSlug: String!) {
        projects(first: 1, filter: { slugId: { eq: $projectSlug } }) {
          nodes {
            id
            name
            slugId
            teams { nodes { id key name states { nodes { name } } } }
          }
        }
      }`,
      { projectSlug: this.config.projectSlug },
    );

    const project = data.projects.nodes[0];
    if (!project) {
      return { ok: false, availableStates: [], checkedStates: [...new Set(requiredStates)], missingStates: [...new Set(requiredStates)] };
    }

    const availableStates = [...new Set(project.teams.nodes.flatMap((team) => team.states.nodes.map((state) => state.name)))].sort();
    const checkedStates = [...new Set(requiredStates.filter((state) => state.trim() !== ""))];
    const missingStates = checkedStates.filter((state) => !availableStates.includes(state));

    return {
      ok: missingStates.length === 0,
      project: {
        id: project.id,
        name: project.name,
        slugId: project.slugId,
        teams: project.teams.nodes.map((team) => ({ id: team.id, key: team.key, name: team.name })),
      },
      availableStates,
      checkedStates,
      missingStates,
    };
  }

  async fetchCandidateIssues(): Promise<readonly NormalizedIssue[]> {
    return this.fetchIssuesByStates(this.config.activeStates);
  }

  // P1-A: paginate through all pages using Relay-style cursor pagination
  async fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly NormalizedIssue[]> {
    const allNodes: LinearIssueNode[] = [];
    let cursor: string | null = null;

    do {
      const variables: Record<string, unknown> = { projectSlug: this.config.projectSlug, stateNames: [...stateNames] };
      if (cursor !== null) variables.after = cursor;

      const data = await this.client.request<PaginatedIssuesData>(
        `query SymphonyIssuesByStates($projectSlug: String!, $stateNames: [String!], $after: String) {
          issues(
            first: 100,
            after: $after,
            filter: { project: { slugId: { eq: $projectSlug } }, state: { name: { in: $stateNames } } }
          ) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables,
      );

      allNodes.push(...data.issues.nodes);
      cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    } while (cursor !== null && allNodes.length < MAX_PAGINATED_ISSUES);

    return allNodes.map(normalizeLinearIssue).filter((issue): issue is NormalizedIssue => issue !== null);
  }

  // P1-A: paginate through all pages using Relay-style cursor pagination
  async fetchIssueStatesByIds(issueIds: readonly string[]): Promise<readonly NormalizedIssue[]> {
    if (issueIds.length === 0) return [];

    const allNodes: LinearIssueNode[] = [];
    let cursor: string | null = null;

    do {
      const variables: Record<string, unknown> = { issueIds: [...issueIds] };
      if (cursor !== null) variables.after = cursor;

      const data = await this.client.request<PaginatedIssuesData>(
        `query SymphonyIssuesByIds($issueIds: [ID!], $after: String) {
          issues(
            first: 100,
            after: $after,
            filter: { id: { in: $issueIds } }
          ) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables,
      );

      allNodes.push(...data.issues.nodes);
      cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    } while (cursor !== null && allNodes.length < MAX_PAGINATED_ISSUES);

    return allNodes.map(normalizeLinearIssue).filter((issue): issue is NormalizedIssue => issue !== null);
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const data = await this.client.request<{ issue: { team: { id: string } } | null }>(
      `query SymphonyIssueTeam($issueId: String!) { issue(id: $issueId) { team { id } } }`,
      { issueId },
    );
    const teamId = data.issue?.team.id;
    if (!teamId) throw new LinearClientError(`Unable to find team for issue ${issueId}`);

    // P2: cache miss → fetch and store; cache hit → skip the workflow state lookup
    const cacheKey = `${teamId}:${stateName}`;
    let stateId = this.stateCache.get(cacheKey);

    if (stateId === undefined) {
      const states = await this.client.request<{ workflowStates: { nodes: readonly { id: string; name: string }[] } }>(
        `query SymphonyWorkflowState($teamId: ID!, $stateName: String!) {
          workflowStates(first: 20, filter: { team: { id: { eq: $teamId } }, name: { eq: $stateName } }) { nodes { id name } }
        }`,
        { teamId, stateName },
      );
      stateId = states.workflowStates.nodes[0]?.id;
      if (!stateId) throw new LinearClientError(`Unable to find Linear workflow state ${stateName}`);
      this.stateCache.set(cacheKey, stateId);
    }

    await this.client.request(
      `mutation SymphonyIssueUpdate($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
      }`,
      { issueId, stateId },
    );
  }

  async createOrUpdateWorkpad(issueId: string, body: string): Promise<void> {
    await this.client.request(
      `mutation SymphonyCommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId, body },
    );
  }
}
