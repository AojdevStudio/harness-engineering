import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { dashboardRoutes, renderDashboardHtml } from "@symphony/dashboard";
import type { StoredEvidenceRecord, SymphonyDatabase } from "@symphony/db";

export interface ServerControlPlane {
  readonly pause: () => void;
  readonly resume: () => void;
  readonly tick: () => Promise<unknown> | unknown;
}

export interface ServerOptions {
  readonly db: SymphonyDatabase;
  readonly orchestrator?: ServerControlPlane;
  readonly token?: string;
  /**
   * When no token is configured, the server is insecure-mode by default (returns 401
   * for all API requests). Set allowInsecure: true to explicitly opt in to unauthenticated
   * access. Has no effect when a token is configured.
   */
  readonly allowInsecure?: boolean;
}

export interface SymphonyServer {
  readonly fetch: (request: Request) => Promise<Response> | Response;
}

/** Escape special HTML characters to prevent injection in future templated content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function unauthorized(): Response {
  return json({ error: { code: "unauthorized", message: "Missing or invalid bearer token" } }, 401);
}

function contentTypeForEvidence(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function publicEvidence(artifact: StoredEvidenceRecord): Record<string, unknown> {
  return {
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    issueId: artifact.issueId,
    kind: artifact.kind,
    label: artifact.label,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt,
    contentUrl: `/api/v1/evidence/${encodeURIComponent(artifact.artifactId)}`,
  };
}

/**
 * Determine whether this request is authorised to access the API.
 *
 * Semantics:
 *   - token configured  → constant-time bearer comparison (P1-A)
 *   - no token + allowInsecure === true → open access (explicit opt-in)
 *   - no token + allowInsecure !== true → fail-closed, return false (P0)
 */
function isAuthorized(request: Request, token?: string, allowInsecure?: boolean): boolean {
  if (!token) {
    // Fail-closed by default; caller must explicitly opt in to insecure mode.
    return allowInsecure === true;
  }

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;

  // P1-A: constant-time comparison — buffers must be the same length first.
  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  if (headerBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(headerBuf, expectedBuf);
}

function isDashboardRoute(pathname: string): boolean {
  return pathname === "/" || dashboardRoutes.some((route) => route.path === pathname);
}

function healthPayload(options: ServerOptions): Record<string, unknown> {
  const runs = options.db.listRuns(1_000);
  const events = options.db.listEvents({ limit: 1_000, order: "desc" });
  const evidence = options.db.listEvidence(undefined, 1_000);
  const controlActions = options.db.listControlActions(50);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    authMode: options.token ? "bearer" : options.allowInsecure === true ? "insecure" : "fail-closed",
    counts: {
      runs: runs.length,
      events: events.length,
      evidence: evidence.length,
      controlActions: controlActions.length,
    },
    recentEvent: events[0] ?? null,
    recentControlAction: controlActions[0] ?? null,
  };
}

function recordControlAction(
  options: ServerOptions,
  input: { readonly action: string; readonly status: string; readonly payload?: unknown },
): string {
  const actionId = randomUUID();
  options.db.recordControlAction({ actionId, action: input.action, status: input.status, payload: input.payload ?? {} });
  return actionId;
}

function controlUnavailable(options: ServerOptions, action: string): Response {
  const actionId = recordControlAction(options, {
    action,
    status: "rejected",
    payload: { error: "orchestrator_unavailable" },
  });
  return json(
    {
      ok: false,
      action,
      actionId,
      error: { code: "control_unavailable", message: "No orchestrator is attached to this server" },
    },
    409,
  );
}

async function runControlAction(
  options: ServerOptions,
  action: string,
  execute: (orchestrator: ServerControlPlane) => Promise<unknown> | unknown,
): Promise<Response> {
  if (!options.orchestrator) return controlUnavailable(options, action);

  try {
    const result = await execute(options.orchestrator);
    const actionId = recordControlAction(options, { action, status: "completed", payload: { result } });
    return json({ ok: true, action, actionId, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const actionId = recordControlAction(options, { action, status: "failed", payload: { error: message } });
    return json({ ok: false, action, actionId, error: { code: "control_failed", message } }, 500);
  }
}

export function createServer(options: ServerOptions): SymphonyServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const isApi = url.pathname.startsWith("/api/");
      if (isApi && !isAuthorized(request, options.token, options.allowInsecure)) return unauthorized();

      if (request.method === "GET" && !isApi && isDashboardRoute(url.pathname)) {
        return new Response(renderDashboardHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/api/v1/state") {
        return json({ ok: true, runs: options.db.listRuns(100), events: options.db.listEvents({ limit: 100, order: "desc" }) });
      }

      if (url.pathname === "/api/v1/health") {
        return json(healthPayload(options));
      }

      if (url.pathname === "/api/v1/runs") {
        return json({ runs: options.db.listRuns(100) });
      }

      if (url.pathname === "/api/v1/events") {
        return json({ events: options.db.listEvents({ limit: 200, order: "desc" }) });
      }

      if (url.pathname === "/api/v1/evidence") {
        return json({ evidence: options.db.listEvidence(undefined, 200).map(publicEvidence) });
      }

      const evidenceMatch = url.pathname.match(/^\/api\/v1\/evidence\/([^/]+)$/);
      if (evidenceMatch?.[1]) {
        const artifact = options.db.getEvidence(decodeURIComponent(evidenceMatch[1]));
        if (!artifact) return json({ error: { code: "artifact_not_found", message: "Evidence artifact not found" } }, 404);
        const file = Bun.file(artifact.uri);
        if (!(await file.exists())) return json({ error: { code: "artifact_file_missing", message: "Evidence file missing" } }, 404);
        return new Response(file, { headers: { "content-type": contentTypeForEvidence(artifact.uri) } });
      }

      const runMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (runMatch?.[1]) {
        const runId = decodeURIComponent(runMatch[1]);
        const run = options.db.getRun(runId);
        if (!run) return json({ error: { code: "run_not_found", message: "Run not found" } }, 404);
        return json({ run, events: options.db.listEvents({ runId }), evidence: options.db.listEvidence(runId).map(publicEvidence) });
      }

      if (url.pathname === "/api/v1/control/actions") {
        return json({ actions: options.db.listControlActions(100) });
      }

      if (url.pathname === "/api/v1/control/pause" && request.method === "POST") {
        return runControlAction(options, "pause", (orchestrator) => orchestrator.pause());
      }

      if (url.pathname === "/api/v1/control/resume" && request.method === "POST") {
        return runControlAction(options, "resume", (orchestrator) => orchestrator.resume());
      }

      if (url.pathname === "/api/v1/control/tick" && request.method === "POST") {
        return runControlAction(options, "tick", (orchestrator) => orchestrator.tick());
      }

      if (url.pathname === "/api/v1/control/retry" && request.method === "POST") {
        return runControlAction(options, "retry", (orchestrator) => orchestrator.tick());
      }

      // P1-B: renamed from /cancel — this endpoint only pauses dispatch, it does NOT
      // abort in-flight subprocesses. The name now honestly describes the behaviour.
      if (url.pathname === "/api/v1/control/pause-and-drain" && request.method === "POST") {
        const response = await runControlAction(options, "pause-and-drain", (orchestrator) => orchestrator.pause());
        if (!response.ok) return response;
        const body = (await response.json()) as Record<string, unknown>;
        return json({
          ...body,
          note: "New dispatch paused; in-flight subprocesses continue to completion. Use runner-specific signals for hard cancellation.",
        });
      }

      return json({ error: { code: "not_found", message: "Route not found" } }, 404);
    },
  };
}

export function startServer(options: ServerOptions & { readonly port: number; readonly host?: string }): ReturnType<typeof Bun.serve> {
  const server = createServer(options);
  return Bun.serve({ port: options.port, hostname: options.host ?? "127.0.0.1", fetch: server.fetch });
}
