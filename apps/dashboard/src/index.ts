export interface DashboardRoute {
  readonly path: string;
  readonly label: string;
}

export const dashboardRoutes: readonly DashboardRoute[] = [
  { path: "/runs", label: "Runs" },
  { path: "/events", label: "Events" },
  { path: "/evidence", label: "Evidence" },
  { path: "/health", label: "Health" },
  { path: "/control", label: "Control" },
];

export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Symphony Control Plane</title>
<style>
:root {
  color-scheme: light;
  --bg: #f4f5f1;
  --ink: #1c2429;
  --muted: #66727a;
  --line: #cfd5d2;
  --panel: #ffffff;
  --panel-2: #ecefeb;
  --accent: #245f8f;
  --accent-ink: #ffffff;
  --green: #1f7a4c;
  --amber: #a86500;
  --red: #b12b2b;
  --blue-soft: #dbeaf5;
  --green-soft: #dff1e7;
  --amber-soft: #f5e8cc;
  --red-soft: #f2d9d9;
  --shadow: 0 1px 2px rgb(24 36 42 / 0.08);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-width: 320px;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
}

button,
input,
select {
  font: inherit;
}

button {
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink);
  padding: 0 12px;
  cursor: pointer;
}

button:hover { border-color: var(--accent); }

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

button.danger {
  border-color: #d6a0a0;
  color: var(--red);
}

input,
select {
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink);
  padding: 0 10px;
}

a { color: var(--accent); }

.shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 4;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto;
  gap: 16px;
  align-items: center;
  border-bottom: 1px solid var(--line);
  background: rgb(244 245 241 / 0.96);
  padding: 12px 20px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--ink);
  border-radius: 6px;
  font-weight: 800;
}

.brand strong { display: block; font-size: 15px; }
.brand span { display: block; color: var(--muted); font-size: 12px; }

.token {
  display: flex;
  gap: 8px;
  align-items: center;
}

.token input { width: min(340px, 38vw); }

.layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  padding: 20px;
}

.nav {
  align-self: start;
  position: sticky;
  top: 76px;
  display: grid;
  gap: 6px;
}

.nav a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  border-radius: 6px;
  color: var(--ink);
  padding: 0 10px;
  text-decoration: none;
}

.nav a.active {
  background: var(--ink);
  color: #fff;
}

.main {
  min-width: 0;
  display: grid;
  gap: 16px;
}

.overview {
  display: grid;
  grid-template-columns: repeat(5, minmax(130px, 1fr));
  gap: 10px;
}

.metric {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: var(--shadow);
  padding: 12px;
  min-height: 76px;
}

.metric span {
  display: block;
  color: var(--muted);
  font-size: 12px;
}

.metric strong {
  display: block;
  margin-top: 6px;
  font-size: 22px;
  line-height: 1;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.toolbar .grow { flex: 1 1 240px; }

.split {
  display: grid;
  grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
  gap: 14px;
}

.panel {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: var(--shadow);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--line);
  padding: 12px;
}

.panel-header h2,
.panel-header h3 {
  margin: 0;
  font-size: 14px;
}

.panel-body { padding: 12px; }

.list {
  display: grid;
  gap: 8px;
  max-height: 680px;
  overflow: auto;
  padding: 10px;
}

.row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  padding: 10px;
  text-align: left;
}

.row.active { border-color: var(--accent); background: #f4f9fc; }
.row-title { min-width: 0; font-weight: 700; overflow-wrap: anywhere; }
.row-meta { margin-top: 3px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }

.status,
.level,
.kind {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.status.running,
.status.workspace_ready,
.status.preparing_workspace,
.status.launching_agent_process,
.status.initializing_session,
.status.streaming_turn,
.status.finishing { color: var(--accent); background: var(--blue-soft); }
.status.succeeded { color: var(--green); background: var(--green-soft); }
.status.failed,
.status.timed_out,
.status.review_blocked,
.status.canceled_by_reconciliation { color: var(--red); background: var(--red-soft); }
.status.created,
.status.stalled { color: var(--amber); background: var(--amber-soft); }

.level.info { color: var(--accent); background: var(--blue-soft); }
.level.debug { color: var(--muted); background: var(--panel-2); }
.level.warn { color: var(--amber); background: var(--amber-soft); }
.level.error { color: var(--red); background: var(--red-soft); }

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.fact {
  border-bottom: 1px solid var(--line);
  padding: 8px 0;
  min-width: 0;
}

.fact span { display: block; color: var(--muted); font-size: 12px; }
.fact strong { display: block; overflow-wrap: anywhere; }

.timeline {
  display: grid;
  gap: 10px;
}

.event {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 10px;
  border-left: 3px solid var(--line);
  padding-left: 10px;
}

.event.error { border-color: var(--red); }
.event.warn { border-color: var(--amber); }
.event.info { border-color: var(--accent); }
.event-time { color: var(--muted); font-size: 12px; }
.event-title { font-weight: 700; overflow-wrap: anywhere; }
.event-message { color: var(--muted); overflow-wrap: anywhere; }

.evidence-grid {
  display: grid;
  grid-template-columns: minmax(260px, 420px) minmax(0, 1fr);
  gap: 14px;
}

.preview {
  min-height: 360px;
  display: grid;
  place-items: center;
  border: 1px dashed var(--line);
  border-radius: 6px;
  background: #fafbf8;
  padding: 12px;
}

.preview img,
.preview video {
  max-width: 100%;
  max-height: 640px;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.preview pre {
  width: 100%;
  max-height: 640px;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.control-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(150px, 1fr));
  gap: 10px;
}

.control-grid button {
  min-height: 72px;
  text-align: left;
  padding: 10px;
}

.control-grid strong { display: block; }
.control-grid span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; }

.notice {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  padding: 12px;
  color: var(--muted);
}

.error-box {
  border-color: #d6a0a0;
  background: var(--red-soft);
  color: var(--red);
}

.muted { color: var(--muted); }
.empty { padding: 18px; color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }

@media (max-width: 960px) {
  .topbar,
  .layout,
  .split,
  .evidence-grid {
    grid-template-columns: 1fr;
  }

  .nav {
    position: static;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    overflow-x: auto;
  }

  .nav a { justify-content: center; }
  .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .control-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .token input { width: 100%; }
}

@media (max-width: 540px) {
  .topbar,
  .layout { padding: 12px; }
  .overview,
  .control-grid,
  .detail-grid { grid-template-columns: 1fr; }
  .nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .event { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand">
      <div class="mark" aria-hidden="true">S</div>
      <div>
        <strong>Symphony</strong>
        <span>Agent run control plane</span>
      </div>
    </div>
    <form class="token" id="token-form">
      <input id="token-input" type="password" autocomplete="off" placeholder="Bearer token" aria-label="Bearer token" />
      <button type="submit">Save</button>
      <button type="button" id="refresh-button" class="primary">Refresh</button>
    </form>
  </header>
  <div class="layout">
    <nav class="nav" id="nav" aria-label="Dashboard views"></nav>
    <main class="main" id="app" aria-live="polite"></main>
  </div>
</div>
<script>
(function () {
  var routes = ${JSON.stringify(dashboardRoutes)};
  var state = {
    route: "/runs",
    token: localStorage.getItem("symphonyToken") || "",
    runs: [],
    events: [],
    evidence: [],
    controls: [],
    health: null,
    selectedRunId: null,
    selectedRun: null,
    selectedEvents: [],
    selectedEvidence: [],
    preview: null,
    statusFilter: "all",
    eventLevelFilter: "all",
    query: "",
    loading: false,
    error: null,
    lastControlResult: null
  };

  var app = document.getElementById("app");
  var nav = document.getElementById("nav");
  var tokenInput = document.getElementById("token-input");
  tokenInput.value = state.token;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function asText(value) {
    if (value == null || value === "") return "none";
    return String(value);
  }

  function fmtDate(value) {
    if (!value) return "none";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function fmtShortTime(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function authHeaders() {
    var headers = { accept: "application/json" };
    if (state.token) headers.authorization = "Bearer " + state.token;
    return headers;
  }

  async function api(path, options) {
    var requestOptions = options || {};
    requestOptions.headers = Object.assign({}, authHeaders(), requestOptions.headers || {});
    var response = await fetch(path, requestOptions);
    if (response.status === 401) {
      state.error = "API rejected the bearer token. Update it in the top bar and refresh.";
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      var text = await response.text();
      throw new Error(text || "Request failed with status " + response.status);
    }
    return response.json();
  }

  async function fetchEvidenceBlob(artifactId) {
    var response = await fetch("/api/v1/evidence/" + encodeURIComponent(artifactId), { headers: authHeaders() });
    if (response.status === 401) {
      state.error = "API rejected the bearer token. Update it in the top bar and refresh.";
      throw new Error("unauthorized");
    }
    if (!response.ok) throw new Error(await response.text());
    return { blob: await response.blob(), contentType: response.headers.get("content-type") || "application/octet-stream" };
  }

  function counts() {
    var totals = { active: 0, succeeded: 0, blocked: 0, failed: 0, total: state.runs.length };
    state.runs.forEach(function (run) {
      if (run.status === "succeeded") totals.succeeded += 1;
      else if (run.status === "review_blocked") totals.blocked += 1;
      else if (run.status === "failed" || run.status === "timed_out" || run.status === "canceled_by_reconciliation") totals.failed += 1;
      else totals.active += 1;
    });
    return totals;
  }

  function routeFromHash() {
    var path = window.location.pathname === "/" ? "/runs" : window.location.pathname;
    var candidate = window.location.hash.replace(/^#/, "") || path || "/runs";
    state.route = routes.some(function (route) { return route.path === candidate; }) ? candidate : "/runs";
  }

  function renderNav() {
    nav.innerHTML = routes.map(function (route) {
      var active = state.route === route.path ? " class=\\"active\\"" : "";
      return "<a" + active + " href=\\"" + escapeHtml(route.path) + "\\" data-route=\\"" + escapeHtml(route.path) + "\\">" + escapeHtml(route.label) + "</a>";
    }).join("");
  }

  function renderOverview() {
    var c = counts();
    return "<section class=\\"overview\\">" +
      metric("Runs", c.total) +
      metric("Active", c.active) +
      metric("Succeeded", c.succeeded) +
      metric("Review blocked", c.blocked) +
      metric("Evidence", state.evidence.length) +
      "</section>";
  }

  function metric(label, value) {
    return "<div class=\\"metric\\"><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>";
  }

  function statusBadge(status) {
    return "<span class=\\"status " + escapeHtml(status) + "\\">" + escapeHtml(status) + "</span>";
  }

  function levelBadge(level) {
    return "<span class=\\"level " + escapeHtml(level) + "\\">" + escapeHtml(level) + "</span>";
  }

  function evidenceKind(kind) {
    return "<span class=\\"kind\\">" + escapeHtml(kind) + "</span>";
  }

  function matchesQuery(values) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    return values.some(function (value) {
      return String(value == null ? "" : value).toLowerCase().includes(q);
    });
  }

  function filteredRuns() {
    return state.runs.filter(function (run) {
      var statusOk = state.statusFilter === "all" || run.status === state.statusFilter;
      return statusOk && matchesQuery([run.runId, run.issueId, run.identifier, run.status, run.lastError]);
    });
  }

  function filteredEvents(events) {
    return events.filter(function (event) {
      var levelOk = state.eventLevelFilter === "all" || event.level === state.eventLevelFilter;
      return levelOk && matchesQuery([event.type, event.message, event.identifier, event.runId, event.issueId]);
    });
  }

  function runRows(runs) {
    if (runs.length === 0) return "<div class=\\"empty\\">No runs match the current filters.</div>";
    return runs.map(function (run) {
      var active = state.selectedRunId === run.runId ? " active" : "";
      return "<button class=\\"row" + active + "\\" data-run-id=\\"" + escapeHtml(run.runId) + "\\">" +
        "<span><span class=\\"row-title\\">" + escapeHtml(run.identifier) + "</span>" +
        "<span class=\\"row-meta\\">" + escapeHtml(run.runId) + " - " + escapeHtml(fmtDate(run.startedAt)) + "</span></span>" +
        statusBadge(run.status) +
        "</button>";
    }).join("");
  }

  function renderRunDetail() {
    var run = state.selectedRun;
    if (!run) return "<div class=\\"empty\\">Select a run to inspect its lifecycle, events, and evidence.</div>";
    return "<div class=\\"panel-body\\">" +
      "<div class=\\"detail-grid\\">" +
      fact("Run", run.runId) +
      fact("Issue", run.identifier + " / " + run.issueId) +
      fact("Status", run.status) +
      fact("Started", fmtDate(run.startedAt)) +
      fact("Finished", fmtDate(run.finishedAt)) +
      fact("Workspace", run.workspacePath) +
      "</div>" +
      (run.lastError ? "<div class=\\"notice error-box\\">" + escapeHtml(run.lastError) + "</div>" : "") +
      "<h3>Recent lifecycle events</h3>" +
      renderEventsList(state.selectedEvents.slice(-8)) +
      "<h3>Evidence</h3>" +
      renderEvidenceRows(state.selectedEvidence) +
      "</div>";
  }

  function fact(label, value) {
    return "<div class=\\"fact\\"><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(asText(value)) + "</strong></div>";
  }

  function renderRuns() {
    var statuses = Array.from(new Set(state.runs.map(function (run) { return run.status; }))).sort();
    var statusOptions = ["all"].concat(statuses).map(function (status) {
      var selected = state.statusFilter === status ? " selected" : "";
      return "<option" + selected + " value=\\"" + escapeHtml(status) + "\\">" + escapeHtml(status) + "</option>";
    }).join("");
    return renderOverview() +
      "<section class=\\"toolbar\\">" +
      "<input class=\\"grow\\" id=\\"query-input\\" value=\\"" + escapeHtml(state.query) + "\\" placeholder=\\"Filter runs, events, evidence\\" />" +
      "<select id=\\"status-filter\\">" + statusOptions + "</select>" +
      "<button id=\\"clear-filter\\">Clear</button>" +
      "</section>" +
      "<section class=\\"split\\">" +
      "<div class=\\"panel\\"><div class=\\"panel-header\\"><h2>Runs</h2><span class=\\"muted\\">" + filteredRuns().length + " shown</span></div><div class=\\"list\\">" + runRows(filteredRuns()) + "</div></div>" +
      "<div class=\\"panel\\"><div class=\\"panel-header\\"><h2>Run detail</h2>" + (state.selectedRun ? statusBadge(state.selectedRun.status) : "") + "</div>" + renderRunDetail() + "</div>" +
      "</section>";
  }

  function renderEventsList(events) {
    var visible = filteredEvents(events);
    if (visible.length === 0) return "<div class=\\"empty\\">No events match the current filters.</div>";
    return "<div class=\\"timeline\\">" + visible.map(function (event) {
      return "<article class=\\"event " + escapeHtml(event.level) + "\\">" +
        "<div class=\\"event-time\\">" + escapeHtml(fmtShortTime(event.createdAt)) + "</div>" +
        "<div><div>" + levelBadge(event.level) + "</div>" +
        "<div class=\\"event-title\\">" + escapeHtml(event.type) + "</div>" +
        "<div class=\\"event-message\\">" + escapeHtml(event.message) + "</div>" +
        "<div class=\\"row-meta\\">" + escapeHtml(event.identifier || event.runId || "system") + "</div></div>" +
        "</article>";
    }).join("") + "</div>";
  }

  function renderEvents() {
    var levels = ["all", "debug", "info", "warn", "error"];
    var levelOptions = levels.map(function (level) {
      var selected = state.eventLevelFilter === level ? " selected" : "";
      return "<option" + selected + " value=\\"" + escapeHtml(level) + "\\">" + escapeHtml(level) + "</option>";
    }).join("");
    return renderOverview() +
      "<section class=\\"toolbar\\">" +
      "<input class=\\"grow\\" id=\\"query-input\\" value=\\"" + escapeHtml(state.query) + "\\" placeholder=\\"Filter event text, issue, run\\" />" +
      "<select id=\\"event-filter\\">" + levelOptions + "</select>" +
      "<button id=\\"clear-filter\\">Clear</button>" +
      "</section>" +
      "<section class=\\"panel\\"><div class=\\"panel-header\\"><h2>Event timeline</h2><span class=\\"muted\\">" + filteredEvents(state.events).length + " shown</span></div><div class=\\"panel-body\\">" + renderEventsList(state.events) + "</div></section>";
  }

  function renderEvidenceRows(items) {
    if (items.length === 0) return "<div class=\\"empty\\">No evidence artifacts recorded.</div>";
    return "<div class=\\"list\\">" + items.map(function (artifact) {
      return "<button class=\\"row\\" data-evidence-id=\\"" + escapeHtml(artifact.artifactId) + "\\">" +
        "<span><span class=\\"row-title\\">" + escapeHtml(artifact.label) + "</span>" +
        "<span class=\\"row-meta\\">" + escapeHtml(artifact.identifier || artifact.runId) + " - " + escapeHtml(fmtDate(artifact.createdAt)) + "</span></span>" +
        evidenceKind(artifact.kind) +
        "</button>";
    }).join("") + "</div>";
  }

  function renderPreview() {
    if (!state.preview) return "<div class=\\"preview\\"><span class=\\"muted\\">Select evidence to preview it with the configured API token.</span></div>";
    if (state.preview.error) return "<div class=\\"preview error-box\\">" + escapeHtml(state.preview.error) + "</div>";
    if (state.preview.text != null) return "<div class=\\"preview\\"><pre class=\\"mono\\">" + escapeHtml(state.preview.text) + "</pre></div>";
    if (state.preview.contentType && state.preview.contentType.indexOf("image/") === 0) {
      return "<div class=\\"preview\\"><img src=\\"" + escapeHtml(state.preview.url) + "\\" alt=\\"Evidence preview\\" /></div>";
    }
    if (state.preview.contentType && state.preview.contentType.indexOf("video/") === 0) {
      return "<div class=\\"preview\\"><video controls src=\\"" + escapeHtml(state.preview.url) + "\\"></video></div>";
    }
    return "<div class=\\"preview\\"><a class=\\"primary\\" href=\\"" + escapeHtml(state.preview.url) + "\\" target=\\"_blank\\" rel=\\"noreferrer\\">Open artifact</a></div>";
  }

  function renderEvidence() {
    var visible = state.evidence.filter(function (artifact) {
      return matchesQuery([artifact.artifactId, artifact.runId, artifact.issueId, artifact.kind, artifact.label]);
    });
    return renderOverview() +
      "<section class=\\"toolbar\\">" +
      "<input class=\\"grow\\" id=\\"query-input\\" value=\\"" + escapeHtml(state.query) + "\\" placeholder=\\"Filter evidence\\" />" +
      "<button id=\\"clear-filter\\">Clear</button>" +
      "</section>" +
      "<section class=\\"evidence-grid\\">" +
      "<div class=\\"panel\\"><div class=\\"panel-header\\"><h2>Evidence artifacts</h2><span class=\\"muted\\">" + visible.length + " shown</span></div>" + renderEvidenceRows(visible) + "</div>" +
      "<div class=\\"panel\\"><div class=\\"panel-header\\"><h2>Preview</h2><span class=\\"muted\\">token-aware fetch</span></div><div class=\\"panel-body\\">" + renderPreview() + "</div></div>" +
      "</section>";
  }

  function renderHealth() {
    var health = state.health || {};
    var counts = health.counts || {};
    return renderOverview() +
      "<section class=\\"split\\">" +
      "<div class=\\"panel\\"><div class=\\"panel-header\\"><h2>API health</h2><span class=\\"status succeeded\\">" + escapeHtml(health.ok ? "ok" : "unknown") + "</span></div><div class=\\"panel-body\\">" +
      fact("Generated", fmtDate(health.generatedAt)) +
      fact("Auth mode", health.authMode || "unknown") +
      fact("Runs", counts.runs || 0) +
      fact("Events", counts.events || 0) +
      fact("Evidence", counts.evidence || 0) +
      fact("Control actions", counts.controlActions || 0) +
      "</div></div>" +
      "<div class=\\"panel\\"><div class=\\"panel-header\\"><h2>Latest signal</h2></div><div class=\\"panel-body\\">" +
      (health.recentEvent ? renderEventsList([health.recentEvent]) : "<div class=\\"empty\\">No events recorded yet.</div>") +
      "<h3>Latest control action</h3>" +
      (health.recentControlAction ? renderControlRows([health.recentControlAction]) : "<div class=\\"empty\\">No control actions recorded yet.</div>") +
      "</div></div>" +
      "</section>";
  }

  function renderControlRows(actions) {
    if (!actions || actions.length === 0) return "<div class=\\"empty\\">No control actions recorded yet.</div>";
    return "<div class=\\"timeline\\">" + actions.map(function (action) {
      return "<article class=\\"event info\\">" +
        "<div class=\\"event-time\\">" + escapeHtml(fmtShortTime(action.createdAt)) + "</div>" +
        "<div><div class=\\"event-title\\">" + escapeHtml(action.action) + "</div>" +
        "<div class=\\"event-message\\">" + escapeHtml(action.status) + "</div>" +
        "<div class=\\"row-meta\\">" + escapeHtml(action.actionId) + "</div></div>" +
        "</article>";
    }).join("") + "</div>";
  }

  function renderControl() {
    return renderOverview() +
      "<section class=\\"panel\\"><div class=\\"panel-header\\"><h2>Controls</h2><span class=\\"muted\\">guarded POST actions</span></div><div class=\\"panel-body\\">" +
      "<div class=\\"control-grid\\">" +
      controlButton("pause", "Pause", "Stop new dispatch") +
      controlButton("resume", "Resume", "Allow dispatch") +
      controlButton("tick", "Tick", "Run one scheduler cycle") +
      controlButton("pause-and-drain", "Pause and drain", "Let active work finish") +
      "</div>" +
      (state.lastControlResult ? "<div class=\\"notice\\"><strong>Last control result</strong><pre class=\\"mono\\">" + escapeHtml(JSON.stringify(state.lastControlResult, null, 2)) + "</pre></div>" : "") +
      "</div></section>" +
      "<section class=\\"panel\\"><div class=\\"panel-header\\"><h2>Control history</h2><span class=\\"muted\\">" + state.controls.length + " recorded</span></div><div class=\\"panel-body\\">" + renderControlRows(state.controls) + "</div></section>";
  }

  function controlButton(action, label, description) {
    var danger = action === "pause-and-drain" ? " danger" : "";
    return "<button class=\\"" + danger + "\\" data-control-action=\\"" + escapeHtml(action) + "\\"><strong>" + escapeHtml(label) + "</strong><span>" + escapeHtml(description) + "</span></button>";
  }

  function render() {
    var focusedId = document.activeElement ? document.activeElement.id : "";
    renderNav();
    var content = "";
    if (state.error) content += "<div class=\\"notice error-box\\">" + escapeHtml(state.error) + "</div>";
    if (state.loading) content += "<div class=\\"notice\\">Refreshing dashboard data...</div>";
    if (state.route === "/events") content += renderEvents();
    else if (state.route === "/evidence") content += renderEvidence();
    else if (state.route === "/health") content += renderHealth();
    else if (state.route === "/control") content += renderControl();
    else content += renderRuns();
    app.innerHTML = content;
    if (focusedId === "query-input") {
      var input = document.getElementById("query-input");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  async function loadRun(runId) {
    if (!runId) return;
    var detail = await api("/api/v1/runs/" + encodeURIComponent(runId));
    state.selectedRunId = runId;
    state.selectedRun = detail.run || null;
    state.selectedEvents = detail.events || [];
    state.selectedEvidence = detail.evidence || [];
  }

  async function refresh() {
    state.loading = true;
    state.error = null;
    render();
    try {
      var results = await Promise.all([
        api("/api/v1/state"),
        api("/api/v1/evidence"),
        api("/api/v1/health"),
        api("/api/v1/control/actions")
      ]);
      state.runs = results[0].runs || [];
      state.events = results[0].events || [];
      state.evidence = results[1].evidence || [];
      state.health = results[2];
      state.controls = results[3].actions || [];
      if (!state.selectedRunId && state.runs.length > 0) state.selectedRunId = state.runs[0].runId;
      if (state.selectedRunId) await loadRun(state.selectedRunId);
    } catch (error) {
      if (!state.error) state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function previewEvidence(artifactId) {
    if (state.preview && state.preview.url) URL.revokeObjectURL(state.preview.url);
    state.preview = { artifactId: artifactId };
    render();
    try {
      var result = await fetchEvidenceBlob(artifactId);
      if (result.contentType.indexOf("text/") === 0 || result.contentType.indexOf("application/json") === 0) {
        state.preview = { artifactId: artifactId, contentType: result.contentType, text: await result.blob.text() };
      } else {
        state.preview = { artifactId: artifactId, contentType: result.contentType, url: URL.createObjectURL(result.blob) };
      }
    } catch (error) {
      state.preview = { artifactId: artifactId, error: error instanceof Error ? error.message : String(error) };
    }
    render();
  }

  async function runControl(action) {
    var labels = {
      pause: "pause new dispatch",
      resume: "resume dispatch",
      tick: "run one scheduler tick",
      "pause-and-drain": "pause dispatch and drain active work"
    };
    if (!window.confirm("Run control action: " + (labels[action] || action) + "?")) return;
    try {
      state.lastControlResult = await api("/api/v1/control/" + action, { method: "POST" });
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  document.getElementById("token-form").addEventListener("submit", function (event) {
    event.preventDefault();
    state.token = tokenInput.value.trim();
    if (state.token) localStorage.setItem("symphonyToken", state.token);
    else localStorage.removeItem("symphonyToken");
    refresh();
  });

  document.getElementById("refresh-button").addEventListener("click", function () {
    refresh();
  });

  nav.addEventListener("click", function (event) {
    var target = event.target.closest("a[data-route]");
    if (!target) return;
    event.preventDefault();
    state.route = target.dataset.route;
    window.history.pushState(null, "", state.route);
    render();
  });

  app.addEventListener("click", function (event) {
    var target = event.target.closest("[data-run-id], [data-evidence-id], [data-control-action], #clear-filter");
    if (!target) return;
    if (target.id === "clear-filter") {
      state.query = "";
      state.statusFilter = "all";
      state.eventLevelFilter = "all";
      render();
      return;
    }
    if (target.dataset.runId) {
      loadRun(target.dataset.runId).then(render).catch(function (error) {
        state.error = error instanceof Error ? error.message : String(error);
        render();
      });
      return;
    }
    if (target.dataset.evidenceId) {
      previewEvidence(target.dataset.evidenceId);
      return;
    }
    if (target.dataset.controlAction) {
      runControl(target.dataset.controlAction);
    }
  });

  app.addEventListener("input", function (event) {
    if (event.target.id === "query-input") {
      state.query = event.target.value;
      render();
    }
  });

  app.addEventListener("change", function (event) {
    if (event.target.id === "status-filter") {
      state.statusFilter = event.target.value;
      render();
    }
    if (event.target.id === "event-filter") {
      state.eventLevelFilter = event.target.value;
      render();
    }
  });

  window.addEventListener("hashchange", function () {
    routeFromHash();
    render();
  });

  window.addEventListener("popstate", function () {
    routeFromHash();
    render();
  });

  routeFromHash();
  render();
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}
