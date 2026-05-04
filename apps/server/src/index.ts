import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { SymphonyDatabase } from "@symphony/db";
import type { SymphonyOrchestrator } from "@symphony/orchestrator";

export interface ServerOptions {
  readonly db: SymphonyDatabase;
  readonly orchestrator?: SymphonyOrchestrator;
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

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Symphony</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0f1115;color:#e8e8e8}main{max-width:1100px;margin:0 auto;padding:24px}section{border:1px solid #303540;background:#171a21;margin:16px 0;padding:16px}pre{white-space:pre-wrap;background:#0b0d11;padding:12px;overflow:auto}.muted{color:#9aa3b2}button{background:#e8e8e8;border:0;padding:8px 12px}</style>
</head>
<body><main>
<h1>Symphony</h1><p class="muted">Self-hosted agent orchestration control plane.</p>
<section><h2>Runs</h2><pre id="runs">Loading...</pre></section>
<section><h2>Recent events</h2><pre id="events">Loading...</pre></section>
<script>
function authHeaders(){
 const token = localStorage.getItem('symphonyToken') || prompt('API token, if configured') || '';
 if (token) localStorage.setItem('symphonyToken', token);
 return token ? {authorization: 'Bearer ' + token} : {};
}
async function api(path){
 const response = await fetch(path, {headers: authHeaders()});
 if (response.status === 401) { localStorage.removeItem('symphonyToken'); throw new Error('Unauthorized'); }
 return response.json();
}
async function load(){
 const [runs, events] = await Promise.all([api('/api/v1/runs'), api('/api/v1/events')]);
 document.getElementById('runs').textContent = JSON.stringify(runs, null, 2);
 document.getElementById('events').textContent = JSON.stringify(events, null, 2);
}
load(); setInterval(load, 3000);
</script>
</main></body></html>`;
}

export function createServer(options: ServerOptions): SymphonyServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const isApi = url.pathname.startsWith("/api/");
      if (isApi && !isAuthorized(request, options.token, options.allowInsecure)) return unauthorized();

      if (url.pathname === "/") {
        return new Response(dashboardHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/api/v1/state") {
        return json({ ok: true, runs: options.db.listRuns(100), events: options.db.listEvents({ limit: 100 }) });
      }

      if (url.pathname === "/api/v1/runs") {
        return json({ runs: options.db.listRuns(100) });
      }

      if (url.pathname === "/api/v1/events") {
        return json({ events: options.db.listEvents({ limit: 200 }) });
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
        return json({ run, events: options.db.listEvents({ runId }), evidence: options.db.listEvidence(runId) });
      }

      if (url.pathname === "/api/v1/control/pause" && request.method === "POST") {
        options.orchestrator?.pause();
        if (typeof options.db.recordControlAction === "function") {
          options.db.recordControlAction({ actionId: randomUUID(), action: "pause", status: "completed", payload: {} });
        }
        return json({ ok: true, action: "pause" });
      }

      if (url.pathname === "/api/v1/control/resume" && request.method === "POST") {
        options.orchestrator?.resume();
        if (typeof options.db.recordControlAction === "function") {
          options.db.recordControlAction({ actionId: randomUUID(), action: "resume", status: "completed", payload: {} });
        }
        return json({ ok: true, action: "resume" });
      }

      if (url.pathname === "/api/v1/control/tick" && request.method === "POST") {
        const result = await options.orchestrator?.tick();
        if (typeof options.db.recordControlAction === "function") {
          options.db.recordControlAction({ actionId: randomUUID(), action: "tick", status: "completed", payload: { result } });
        }
        return json({ ok: true, result });
      }

      if (url.pathname === "/api/v1/control/retry" && request.method === "POST") {
        const result = await options.orchestrator?.tick();
        if (typeof options.db.recordControlAction === "function") {
          options.db.recordControlAction({ actionId: randomUUID(), action: "retry", status: "completed", payload: { result } });
        }
        return json({ ok: true, action: "retry", result });
      }

      // P1-B: renamed from /cancel — this endpoint only pauses dispatch, it does NOT
      // abort in-flight subprocesses. The name now honestly describes the behaviour.
      if (url.pathname === "/api/v1/control/pause-and-drain" && request.method === "POST") {
        options.orchestrator?.pause();
        if (typeof options.db.recordControlAction === "function") {
          options.db.recordControlAction({ actionId: randomUUID(), action: "pause-and-drain", status: "completed", payload: {} });
        }
        return json({
          ok: true,
          action: "pause-and-drain",
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
