from __future__ import annotations

import json
import urllib.request
from datetime import UTC, datetime

from harness_engineering.http_server import build_state_payload, start_http_server
from harness_engineering.models import Issue
from harness_engineering.orchestrator import OrchestratorState, RecentEvent, RetryEntry, RunningEntry


def test_state_payload_contains_running_retry_totals_and_rate_limits() -> None:
    state = OrchestratorState(max_concurrent_agents=2, active_states={"open"}, terminal_states={"closed"})
    state.running["id-1"] = RunningEntry(
        issue=Issue(id="id-1", identifier="repo#1", title="One", state="open"),
        workspace_path="/tmp/work/repo_1",
        started_at=datetime(2026, 1, 1, tzinfo=UTC),
        session_id="thread-turn",
        turn_count=3,
        last_codex_event="notification",
        last_codex_message="Working",
        last_codex_timestamp=datetime(2026, 1, 1, 0, 1, tzinfo=UTC),
        codex_input_tokens=10,
        codex_output_tokens=20,
        codex_total_tokens=30,
    )
    state.codex_totals.input_tokens = 5
    state.codex_totals.output_tokens = 6
    state.codex_totals.total_tokens = 11
    state.codex_rate_limits = {"primary": {"remaining": 1}}
    state.retry_attempts["id-2"] = RetryEntry(
        issue_id="id-2",
        identifier="repo#2",
        attempt=1,
        due_at_ms=1000,
        continuation=True,
    )
    state.recent_events.append(
        RecentEvent(
            issue_id="id-1",
            issue_identifier="repo#1",
            event="notification",
            timestamp=datetime(2026, 1, 1, 0, 1, tzinfo=UTC),
            message="Working",
        )
    )

    payload = build_state_payload(state, now=datetime(2026, 1, 1, 0, 2, tzinfo=UTC))

    assert payload["counts"] == {"running": 1, "retrying": 1}
    assert payload["running"][0]["turn_count"] == 3
    assert payload["running"][0]["tokens"]["total_tokens"] == 30
    assert payload["retrying"][0]["continuation"] is True
    assert payload["recent_events"][0]["event"] == "notification"
    assert payload["codex_totals"]["total_tokens"] == 11
    assert payload["rate_limits"] == {"primary": {"remaining": 1}}


def test_status_server_reports_actual_ephemeral_port() -> None:
    state = OrchestratorState(max_concurrent_agents=1, active_states={"open"}, terminal_states={"closed"})
    server = start_http_server("127.0.0.1", 0, state_provider=lambda: state, refresh=lambda: None)
    try:
        host, port = server.server_address[:2]

        assert host == "127.0.0.1"
        assert port > 0

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/state", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))

        assert payload["counts"] == {"running": 0, "retrying": 0}
    finally:
        server.shutdown()
        server.server_close()
