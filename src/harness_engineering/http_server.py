from __future__ import annotations

import json
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any, Callable

from harness_engineering.orchestrator import OrchestratorState, RunningEntry


def build_state_payload(state: OrchestratorState, *, now: datetime | None = None) -> dict[str, Any]:
    current = now or datetime.now(UTC)
    running = []
    active_seconds = 0.0
    for issue_id, entry in state.running.items():
        if not isinstance(entry, RunningEntry):
            continue
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
        }
        for entry in state.retry_attempts.values()
    ]
    return {
        "generated_at": _iso(current),
        "counts": {"running": len(state.running), "retrying": len(state.retry_attempts)},
        "running": running,
        "retrying": retrying,
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


def _dashboard_html(payload: dict[str, Any]) -> str:
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Symphony Harness</title></head>
<body>
<h1>Symphony Harness</h1>
<pre>{json.dumps(payload, indent=2, sort_keys=True)}</pre>
</body>
</html>"""


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")

