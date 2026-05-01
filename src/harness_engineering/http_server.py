from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from html import escape
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any
from urllib.parse import unquote

from harness_engineering.orchestrator import OrchestratorState, RunningEntry
from harness_engineering.session_journal import SessionJournal


def build_state_payload(state: OrchestratorState, *, now: datetime | None = None) -> dict[str, Any]:
    current = now or datetime.now(UTC)
    running = []
    active_seconds = 0.0
    for issue_id, entry in state.running.items():
        if not isinstance(entry, RunningEntry):
            continue
        session = entry.worker_session
        attempt = session.current_attempt if session else None
        active_seconds += max((current - entry.started_at).total_seconds(), 0.0)
        running.append(
            {
                "issue_id": issue_id,
                "issue_identifier": entry.issue.identifier,
                "state": entry.issue.state,
                "session_id": entry.session_id,
                "turn_count": entry.turn_count,
                "last_event": entry.last_codex_event,
                "last_message": entry.last_codex_message or "",
                "started_at": _iso(entry.started_at),
                "last_event_at": _iso(entry.last_codex_timestamp),
                "session_status": session.session_status if session else entry.session_status,
                "execution_strategy": session.execution_strategy if session else entry.execution_strategy,
                "handoff_reason": session.handoff_reason if session else entry.handoff_reason,
                "last_error": session.last_error if session else entry.last_error,
                "attempt": {
                    "number": attempt.number if attempt else entry.attempt_number,
                    "reason": attempt.reason if attempt else entry.attempt_reason,
                    "status": attempt.status if attempt else "running",
                    "started_at": _iso(attempt.started_at) if attempt else _iso(entry.started_at),
                    "finished_at": _iso(attempt.finished_at) if attempt else None,
                    "error": attempt.error if attempt else entry.last_error,
                    "handoff_reason": attempt.handoff_reason if attempt else entry.handoff_reason,
                },
                "tokens": {
                    "input_tokens": entry.codex_input_tokens,
                    "output_tokens": entry.codex_output_tokens,
                    "total_tokens": entry.codex_total_tokens,
                },
            }
        )

    retrying = [
        {
            "issue_id": entry.issue_id,
            "issue_identifier": entry.identifier,
            "attempt": entry.attempt,
            "due_at_ms": entry.due_at_ms,
            "error": entry.error,
            "continuation": entry.continuation,
            "session_status": entry.session_status,
            "attempt_reason": entry.attempt_reason,
            "last_error": entry.last_error,
        }
        for entry in state.retry_attempts.values()
    ]
    recent_events = [
        {
            "issue_id": entry.issue_id,
            "issue_identifier": entry.issue_identifier,
            "event": entry.event,
            "message": entry.message or "",
            "at": _iso(entry.timestamp),
        }
        for entry in state.recent_events[-50:]
    ]
    return {
        "generated_at": _iso(current),
        "counts": {"running": len(state.running), "retrying": len(state.retry_attempts)},
        "running": running,
        "retrying": retrying,
        "recent_events": recent_events,
        "codex_totals": {
            "input_tokens": state.codex_totals.input_tokens,
            "output_tokens": state.codex_totals.output_tokens,
            "total_tokens": state.codex_totals.total_tokens,
            "seconds_running": state.codex_totals.seconds_running + active_seconds,
        },
        "rate_limits": state.codex_rate_limits,
    }


def start_http_server(
    host: str,
    port: int,
    *,
    state_provider: Callable[[], OrchestratorState],
    refresh: Callable[[], None],
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/":
                payload = build_state_payload(state_provider())
                html = _dashboard_html(payload)
                self._send(HTTPStatus.OK, "text/html; charset=utf-8", html.encode("utf-8"))
                return
            if self.path == "/api/v1/state":
                self._send_json(HTTPStatus.OK, build_state_payload(state_provider()))
                return
            if self.path.startswith("/api/v1/"):
                identifier = unquote(self.path.removeprefix("/api/v1/"))
                issue_payload = build_issue_payload(state_provider(), identifier)
                if issue_payload is not None:
                    self._send_json(HTTPStatus.OK, issue_payload)
                    return
                self._send_json(
                    HTTPStatus.NOT_FOUND,
                    {"error": {"code": "issue_not_found", "message": "issue is not tracked in memory"}},
                )
                return
            self._send_json(HTTPStatus.NOT_FOUND, {"error": {"code": "not_found", "message": "route not found"}})

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/api/v1/refresh":
                refresh()
                self._send_json(
                    HTTPStatus.ACCEPTED,
                    {
                        "queued": True,
                        "coalesced": False,
                        "requested_at": _iso(datetime.now(UTC)),
                        "operations": ["poll", "reconcile"],
                    },
                )
                return
            self._send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": {"code": "method_not_allowed", "message": "unsupported method"}})

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            self._send(status, "application/json", json.dumps(payload, sort_keys=True).encode("utf-8"))

        def _send(self, status: HTTPStatus, content_type: str, body: bytes) -> None:
            self.send_response(status.value)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer((host, port), Handler)
    thread = Thread(target=server.serve_forever, name="symphony-http", daemon=True)
    thread.start()
    return server


def build_issue_payload(state: OrchestratorState, issue_identifier: str) -> dict[str, Any] | None:
    for issue_id, entry in state.running.items():
        if not isinstance(entry, RunningEntry) or entry.issue.identifier != issue_identifier:
            continue
        session = entry.worker_session
        attempt = session.current_attempt if session else None
        journal_events = SessionJournal(entry.workspace_path).read_recent(limit=25)
        return {
            "issue_identifier": entry.issue.identifier,
            "issue_id": issue_id,
            "status": session.session_status if session else entry.session_status,
            "workspace": {"path": entry.workspace_path},
            "attempts": {
                "current_attempt_number": attempt.number if attempt else entry.attempt_number,
                "current_attempt_reason": attempt.reason if attempt else entry.attempt_reason,
            },
            "running": {
                "session_id": entry.session_id,
                "turn_count": entry.turn_count,
                "state": entry.issue.state,
                "started_at": _iso(entry.started_at),
                "last_event": entry.last_codex_event,
                "last_message": entry.last_codex_message or "",
                "last_event_at": _iso(entry.last_codex_timestamp),
                "execution_strategy": session.execution_strategy if session else entry.execution_strategy,
                "attempt": {
                    "number": attempt.number if attempt else entry.attempt_number,
                    "reason": attempt.reason if attempt else entry.attempt_reason,
                    "status": attempt.status if attempt else "running",
                    "started_at": _iso(attempt.started_at) if attempt else _iso(entry.started_at),
                    "finished_at": _iso(attempt.finished_at) if attempt else None,
                    "error": attempt.error if attempt else entry.last_error,
                    "handoff_reason": attempt.handoff_reason if attempt else entry.handoff_reason,
                },
                "tokens": {
                    "input_tokens": entry.codex_input_tokens,
                    "output_tokens": entry.codex_output_tokens,
                    "total_tokens": entry.codex_total_tokens,
                },
            },
            "retry": None,
            "logs": {"worker_session_journal": str(SessionJournal(entry.workspace_path).path)},
            "recent_events": journal_events,
            "last_error": session.last_error if session else entry.last_error,
            "tracked": {},
        }

    for retry in state.retry_attempts.values():
        if retry.identifier != issue_identifier:
            continue
        return {
            "issue_identifier": retry.identifier,
            "issue_id": retry.issue_id,
            "status": retry.session_status,
            "workspace": {"path": None},
            "attempts": {
                "current_retry_attempt": retry.attempt,
                "current_attempt_reason": retry.attempt_reason,
            },
            "running": None,
            "retry": {
                "attempt": retry.attempt,
                "due_at_ms": retry.due_at_ms,
                "error": retry.error,
                "continuation": retry.continuation,
                "attempt_reason": retry.attempt_reason,
            },
            "logs": {"worker_session_journal": None},
            "recent_events": [
                {
                    "issue_id": event.issue_id,
                    "issue_identifier": event.issue_identifier,
                    "event": event.event,
                    "message": event.message or "",
                    "at": _iso(event.timestamp),
                }
                for event in state.recent_events
                if event.issue_identifier == issue_identifier
            ],
            "last_error": retry.last_error,
            "tracked": {},
        }

    return None


def _dashboard_html(payload: dict[str, Any]) -> str:
    running_rows = "\n".join(_running_row(row) for row in payload["running"]) or '<tr><td colspan="8">No running sessions</td></tr>'
    retry_rows = "\n".join(_retry_row(row) for row in payload["retrying"]) or '<tr><td colspan="6">No retrying sessions</td></tr>'
    event_rows = "\n".join(_event_row(row) for row in payload["recent_events"][-10:]) or '<tr><td colspan="4">No recent events</td></tr>'
    totals = payload["codex_totals"]
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Symphony Harness Operator Console</title>
<style>
body {{ font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #17202a; background: #f8fafc; }}
h1 {{ margin-bottom: 4px; }}
h2 {{ margin-top: 28px; }}
.summary {{ display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0; }}
.metric {{ border: 1px solid #d7dee8; background: white; border-radius: 6px; padding: 10px 12px; min-width: 150px; }}
.metric strong {{ display: block; font-size: 22px; }}
table {{ width: 100%; border-collapse: collapse; background: white; border: 1px solid #d7dee8; }}
th, td {{ text-align: left; border-bottom: 1px solid #e6ecf2; padding: 8px; vertical-align: top; }}
th {{ font-size: 12px; text-transform: uppercase; color: #526173; background: #edf2f7; }}
code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }}
</style>
</head>
<body>
<h1>Symphony Harness Operator Console</h1>
<p>Generated at {escape(str(payload["generated_at"]))}. This surface explains Worker Sessions, Agent Attempts, retries, and recent events.</p>
<div class="summary">
  <div class="metric"><span>Running</span><strong>{payload["counts"]["running"]}</strong></div>
  <div class="metric"><span>Retrying</span><strong>{payload["counts"]["retrying"]}</strong></div>
  <div class="metric"><span>Total tokens</span><strong>{totals["total_tokens"]}</strong></div>
  <div class="metric"><span>Runtime seconds</span><strong>{round(totals["seconds_running"], 1)}</strong></div>
</div>
<h2>Worker Sessions</h2>
<table>
<thead><tr><th>Issue</th><th>Status</th><th>Attempt</th><th>Reason</th><th>Strategy</th><th>Last Event</th><th>Last Message</th><th>Workspace</th></tr></thead>
<tbody>{running_rows}</tbody>
</table>
<h2>Retry Queue</h2>
<table>
<thead><tr><th>Issue</th><th>Status</th><th>Attempt</th><th>Reason</th><th>Error</th><th>Due</th></tr></thead>
<tbody>{retry_rows}</tbody>
</table>
<h2>Recent Events</h2>
<table>
<thead><tr><th>At</th><th>Issue</th><th>Event</th><th>Message</th></tr></thead>
<tbody>{event_rows}</tbody>
</table>
</body>
</html>"""


def _running_row(row: dict[str, Any]) -> str:
    attempt = row.get("attempt") or {}
    return (
        "<tr>"
        f"<td>{escape(row['issue_identifier'])}</td>"
        f"<td>{escape(str(row.get('session_status') or 'running'))}</td>"
        f"<td>{escape(str(attempt.get('number', '')))}</td>"
        f"<td>{escape(str(attempt.get('reason', '')))}</td>"
        f"<td>{escape(str(row.get('execution_strategy') or ''))}</td>"
        f"<td>{escape(str(row.get('last_event') or ''))}</td>"
        f"<td>{escape(str(row.get('last_message') or ''))}</td>"
        f"<td><code>{escape(str(row.get('workspace_path') or ''))}</code></td>"
        "</tr>"
    )


def _retry_row(row: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td>{escape(row['issue_identifier'])}</td>"
        f"<td>{escape(str(row.get('session_status') or 'retrying'))}</td>"
        f"<td>{escape(str(row.get('attempt') or ''))}</td>"
        f"<td>{escape(str(row.get('attempt_reason') or ''))}</td>"
        f"<td>{escape(str(row.get('last_error') or row.get('error') or ''))}</td>"
        f"<td>{escape(str(row.get('due_at_ms') or ''))}</td>"
        "</tr>"
    )


def _event_row(row: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td>{escape(str(row.get('at') or ''))}</td>"
        f"<td>{escape(str(row.get('issue_identifier') or ''))}</td>"
        f"<td>{escape(str(row.get('event') or ''))}</td>"
        f"<td>{escape(str(row.get('message') or ''))}</td>"
        "</tr>"
    )


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
