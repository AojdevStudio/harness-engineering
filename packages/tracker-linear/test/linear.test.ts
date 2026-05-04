import { describe, expect, test } from "bun:test";
import { LinearClient, LinearClientError, LinearTrackerAdapter, normalizeLinearIssue } from "../src/index.ts";

describe("normalizeLinearIssue", () => {
  test("normalizes Linear payload into core issue", () => {
    const issue = normalizeLinearIssue({
      id: "lin-id",
      identifier: "ABC-1",
      title: "Do thing",
      description: "Body",
      priority: 2,
      branchName: "abc-1-do-thing",
      url: "https://linear.app/acme/issue/ABC-1",
      state: { name: "Todo" },
      labels: { nodes: [{ name: "Bug" }, { name: "Backend" }] },
      relations: {
        nodes: [
          { type: "blocked_by", relatedIssue: { id: "dep", identifier: "ABC-0", state: { name: "Done" } } },
        ],
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });

    expect(issue).toEqual({
      id: "lin-id",
      identifier: "ABC-1",
      title: "Do thing",
      description: "Body",
      priority: 2,
      branchName: "abc-1-do-thing",
      url: "https://linear.app/acme/issue/ABC-1",
      state: "Todo",
      labels: ["bug", "backend"],
      blockedBy: [{ id: "dep", identifier: "ABC-0", state: "Done" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });

  test("drops malformed issues missing required fields", () => {
    expect(normalizeLinearIssue({ id: "1", title: "Missing identifier", state: { name: "Todo" } })).toBeNull();
  });
});

describe("LinearClient", () => {
  test("sends GraphQL request with auth and returns data", async () => {
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://linear.test/graphql");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("lin_key");
      return Response.json({ data: { ok: true } });
    };

    const client = new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl });
    await expect(client.request<{ ok: boolean }>("query { ok }", {})).resolves.toEqual({ ok: true });
  });

  test("throws on GraphQL errors", async () => {
    const fetchImpl = async () => Response.json({ errors: [{ message: "bad query" }] });
    const client = new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl });

    await expect(client.request("query { bad }", {})).rejects.toThrow(LinearClientError);
  });

  // P1-B: retry on 429 — succeeds on second attempt
  test("retries on HTTP 429 and succeeds on next attempt", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      if (callCount === 1) {
        // Return 429 with no Retry-After header so the loop backoff handles it
        return new Response(JSON.stringify({}), { status: 429, headers: {} });
      }
      return Response.json({ data: { ok: true } });
    };

    const client = new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl });
    const result = await client.request<{ ok: boolean }>("query { ok }", {});
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  // P1-B: exhausts retries on persistent 500 and throws
  test("throws after 3 attempts on persistent 5xx", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      return new Response(JSON.stringify({}), { status: 500 });
    };

    const client = new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl });
    await expect(client.request("query { x }", {})).rejects.toThrow(LinearClientError);
    expect(callCount).toBe(3);
  });

  // P1-B: reads Retry-After header on 429
  test("reads Retry-After header when rate-limited", async () => {
    let callCount = 0;
    const delays: number[] = [];
    // Patch setTimeout to record but not actually delay
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = (fn: () => void, ms: number) => {
      delays.push(ms);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };

    try {
      const fetchImpl = async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({}), {
            status: 429,
            headers: { "retry-after": "2" },
          });
        }
        return Response.json({ data: { ok: true } });
      };

      const client = new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl });
      await client.request<{ ok: boolean }>("query { ok }", {});
      // Should have delayed 2000ms from the Retry-After header
      expect(delays).toContain(2000);
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });
});

describe("LinearTrackerAdapter", () => {
  test("preflights project and workflow states", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.variables).toEqual({ projectSlug: "proj" });
      return Response.json({
        data: {
          projects: {
            nodes: [
              {
                id: "project-id",
                name: "Project",
                slugId: "proj",
                teams: {
                  nodes: [
                    {
                      id: "team-id",
                      key: "ABC",
                      name: "Team",
                      states: { nodes: [{ name: "Todo" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }] },
                    },
                  ],
                },
              },
            ],
          },
        },
      });
    };

    const adapter = new LinearTrackerAdapter(
      {
        kind: "linear",
        endpoint: "https://linear.test/graphql",
        apiKey: "lin_key",
        projectSlug: "proj",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl }),
    );

    await expect(adapter.preflight(["Todo", "In Progress", "In Review", "Done", "Missing"])).resolves.toEqual({
      ok: false,
      project: {
        id: "project-id",
        name: "Project",
        slugId: "proj",
        teams: [{ id: "team-id", key: "ABC", name: "Team" }],
      },
      availableStates: ["Done", "In Progress", "In Review", "Todo"],
      checkedStates: ["Todo", "In Progress", "In Review", "Done", "Missing"],
      missingStates: ["Missing"],
    });
  });

  test("preflights missing project", async () => {
    const fetchImpl = async () => Response.json({ data: { projects: { nodes: [] } } });
    const adapter = new LinearTrackerAdapter(
      {
        kind: "linear",
        endpoint: "https://linear.test/graphql",
        apiKey: "lin_key",
        projectSlug: "missing",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl }),
    );

    await expect(adapter.preflight(["Todo"])).resolves.toEqual({ ok: false, availableStates: [], checkedStates: ["Todo"], missingStates: ["Todo"] });
  });

  test("fetches candidate issues using active states", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.variables).toMatchObject({ projectSlug: "proj", stateNames: ["Todo"] });
      return Response.json({
        data: {
          issues: {
            nodes: [
              { id: "1", identifier: "ABC-1", title: "Task", state: { name: "Todo" }, labels: { nodes: [] } },
              { id: "bad", title: "Malformed", state: { name: "Todo" } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    };

    const adapter = new LinearTrackerAdapter(
      {
        kind: "linear",
        endpoint: "https://linear.test/graphql",
        apiKey: "lin_key",
        projectSlug: "proj",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl }),
    );

    const issues = await adapter.fetchCandidateIssues();
    expect(issues.map((issue) => issue.identifier)).toEqual(["ABC-1"]);
  });

  // P1-A: pagination — two pages merged into one result set
  test("fetchIssuesByStates paginates through multiple pages", async () => {
    let callCount = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body));
      const after = body.variables.after ?? null;

      if (after === null) {
        // First page
        return Response.json({
          data: {
            issues: {
              nodes: [{ id: "1", identifier: "ABC-1", title: "First", state: { name: "Todo" }, labels: { nodes: [] } }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-page-2" },
            },
          },
        });
      }

      // Second page
      expect(after).toBe("cursor-page-2");
      return Response.json({
        data: {
          issues: {
            nodes: [{ id: "2", identifier: "ABC-2", title: "Second", state: { name: "Todo" }, labels: { nodes: [] } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    };

    const adapter = new LinearTrackerAdapter(
      {
        kind: "linear",
        endpoint: "https://linear.test/graphql",
        apiKey: "lin_key",
        projectSlug: "proj",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl }),
    );

    const issues = await adapter.fetchIssuesByStates(["Todo"]);
    expect(issues.map((i) => i.identifier)).toEqual(["ABC-1", "ABC-2"]);
    expect(callCount).toBe(2);
  });

  // P1-A: pagination for fetchIssueStatesByIds
  test("fetchIssueStatesByIds paginates through multiple pages", async () => {
    let callCount = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body));
      const after = body.variables.after ?? null;

      if (after === null) {
        return Response.json({
          data: {
            issues: {
              nodes: [{ id: "1", identifier: "ABC-1", title: "First", state: { name: "Todo" }, labels: { nodes: [] } }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-ids-2" },
            },
          },
        });
      }

      expect(after).toBe("cursor-ids-2");
      return Response.json({
        data: {
          issues: {
            nodes: [{ id: "2", identifier: "ABC-2", title: "Second", state: { name: "In Progress" }, labels: { nodes: [] } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    };

    const adapter = new LinearTrackerAdapter(
      {
        kind: "linear",
        endpoint: "https://linear.test/graphql",
        apiKey: "lin_key",
        projectSlug: "proj",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl }),
    );

    const issues = await adapter.fetchIssueStatesByIds(["1", "2"]);
    expect(issues.map((i) => i.identifier)).toEqual(["ABC-1", "ABC-2"]);
    expect(callCount).toBe(2);
  });

  // P2: state cache — second call for same team+state skips workflow state lookup
  test("updateIssueState caches stateId and skips second workflow state query", async () => {
    const calls: string[] = [];

    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const operationName: string = body.query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unknown";
      calls.push(operationName);

      if (operationName === "SymphonyIssueTeam") {
        return Response.json({ data: { issue: { team: { id: "team-1" } } } });
      }

      if (operationName === "SymphonyWorkflowState") {
        return Response.json({ data: { workflowStates: { nodes: [{ id: "state-done", name: "Done" }] } } });
      }

      if (operationName === "SymphonyIssueUpdate") {
        return Response.json({ data: { issueUpdate: { success: true } } });
      }

      throw new Error(`Unexpected operation: ${operationName}`);
    };

    const adapter = new LinearTrackerAdapter(
      {
        kind: "linear",
        endpoint: "https://linear.test/graphql",
        apiKey: "lin_key",
        projectSlug: "proj",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      new LinearClient({ endpoint: "https://linear.test/graphql", apiKey: "lin_key", fetchImpl }),
    );

    // First call: 3 queries (team lookup + workflow state lookup + mutation)
    await adapter.updateIssueState("issue-1", "Done");
    expect(calls).toEqual(["SymphonyIssueTeam", "SymphonyWorkflowState", "SymphonyIssueUpdate"]);

    calls.length = 0;

    // Second call with same state: only 2 queries (team lookup + mutation, cache hit)
    await adapter.updateIssueState("issue-1", "Done");
    expect(calls).toEqual(["SymphonyIssueTeam", "SymphonyIssueUpdate"]);
  });
});
