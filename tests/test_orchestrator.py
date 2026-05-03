from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from harness_engineering.agent import AgentError, AgentEvent
from harness_engineering.config import ServiceConfig
from harness_engineering.http_server import build_state_payload
from harness_engineering.models import BlockerRef, Issue
from harness_engineering.orchestrator import (
    OrchestratorState,
    RetryEntry,
    RetryScheduler,
    RunningEntry,
    available_slots,
    should_dispatch,
    sort_for_dispatch,
)
from harness_engineering.service import SymphonyService
from harness_engineering.workflow import load_workflow


def issue(identifier: str, *, priority: int | None, created_at: datetime, state: str = "open") -> Issue:
    return Issue(
        id=identifier,
        identifier=identifier,
        title=identifier,
        state=state,
        priority=priority,
        created_at=created_at,
    )


def test_dispatch_sort_order_is_priority_then_oldest_then_identifier() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    issues = [
        issue("HE-3", priority=None, created_at=now),
        issue("HE-2", priority=2, created_at=now + timedelta(minutes=1)),
        issue("HE-1", priority=2, created_at=now),
        issue("HE-0", priority=1, created_at=now + timedelta(days=1)),
    ]

    assert [item.identifier for item in sort_for_dispatch(issues)] == ["HE-0", "HE-1", "HE-2", "HE-3"]


def test_todo_issue_with_non_terminal_blocker_is_not_dispatchable() -> None:
    candidate = issue("HE-1", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC), state="Todo")
    candidate.blocked_by.append(BlockerRef(identifier="HE-0", state="In Progress"))
    state = OrchestratorState(max_concurrent_agents=2, active_states={"todo"}, terminal_states={"done"})

    assert should_dispatch(candidate, state) is False


def test_global_and_per_state_slots_are_enforced() -> None:
    state = OrchestratorState(
        max_concurrent_agents=3,
        active_states={"open"},
        terminal_states={"closed"},
        max_concurrent_agents_by_state={"open": 1},
    )
    state.running["HE-1"] = issue("HE-1", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC))

    assert available_slots(state, state_name="open") == 0


def test_retry_scheduler_uses_short_continuation_and_capped_exponential_backoff() -> None:
    scheduler = RetryScheduler(max_backoff_ms=25_000)

    assert scheduler.delay_ms(attempt=1, continuation=True) == 1_000
    assert scheduler.delay_ms(attempt=1, continuation=False) == 10_000
    assert scheduler.delay_ms(attempt=2, continuation=False) == 20_000
    assert scheduler.delay_ms(attempt=3, continuation=False) == 25_000


def test_retry_entries_include_due_time_identifier_and_error() -> None:
    scheduler = RetryScheduler(max_backoff_ms=300_000)

    entry = scheduler.create_entry(
        issue_id="id-1",
        identifier="repo#1",
        attempt=2,
        now_ms=1_000,
        error="turn failed",
    )

    assert entry.issue_id == "id-1"
    assert entry.identifier == "repo#1"
    assert entry.attempt == 2
    assert entry.due_at_ms == 21_000
    assert entry.error == "turn failed"


def service_for_retry_tests(tmp_path: Path) -> SymphonyService:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(
        """---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: literal-token
workspace:
  root: workspaces
---
Prompt
""",
        encoding="utf-8",
    )
    workflow = load_workflow(workflow_path)
    config = ServiceConfig.from_workflow(workflow, workflow_path)
    service = SymphonyService(workflow_path)
    service.workflow = workflow
    service.config = config
    service.state = OrchestratorState(max_concurrent_agents=1, active_states={"open"}, terminal_states={"closed"})
    return service


def stub_workflow_path(tmp_path: Path, *, stub_exit: str = "success", stub_delay_ms: int = 0) -> Path:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(
        f"""---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: literal-token
workspace:
  root: workspaces
agent:
  max_concurrent_agents: 1
codex:
  driver: stub
  stub_exit: {stub_exit}
  stub_delay_ms: {stub_delay_ms}
---
Work on {{{{ issue.identifier }}}}: {{{{ issue.title }}}} attempt={{{{ attempt }}}}
""",
        encoding="utf-8",
    )
    return workflow_path


def install_fake_tracker(monkeypatch: pytest.MonkeyPatch, candidate: Issue) -> None:
    class FakeGitHubTracker:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def fetch_candidate_issues(self) -> list[Issue]:
            return [candidate]

        def fetch_issues_by_states(self, _states: list[str]) -> list[Issue]:
            return []

        def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
            return [candidate] if candidate.id in issue_ids else []

    monkeypatch.setattr("harness_engineering.service.GitHubTracker", FakeGitHubTracker)


def wait_for_retry(service: SymphonyService, issue_id: str) -> RetryEntry:
    assert service.state is not None
    for _ in range(100):
        service.tick()
        retry = service.state.retry_attempts.get(issue_id)
        if retry:
            return retry
        time.sleep(0.01)
    raise AssertionError(f"retry was not scheduled for {issue_id}")


def shutdown_service(service: SymphonyService) -> None:
    if service.executor:
        service.executor.shutdown(wait=True, cancel_futures=False)


def test_due_retry_dispatches_with_recorded_attempt_and_clears_retry_claim(tmp_path: Path) -> None:
    service = service_for_retry_tests(tmp_path)
    dispatched: list[tuple[Issue, int | None]] = []
    candidate = issue("id-1", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC))
    service.state.claimed.add("id-1")  # type: ignore[union-attr]
    service.state.retry_attempts["id-1"] = RetryEntry(  # type: ignore[union-attr]
        issue_id="id-1",
        identifier="id-1",
        attempt=3,
        due_at_ms=100,
        error="turn failed",
    )
    service._dispatch = lambda issue, *, attempt: dispatched.append((issue, attempt))  # type: ignore[method-assign]

    service._dispatch_due_retries([candidate], now_ms=100)

    assert dispatched == [(candidate, 3)]
    assert "id-1" not in service.state.retry_attempts  # type: ignore[union-attr]
    assert "id-1" not in service.state.claimed  # type: ignore[union-attr]


def test_due_retry_requeues_when_slots_are_exhausted(tmp_path: Path) -> None:
    service = service_for_retry_tests(tmp_path)
    candidate = issue("id-1", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC))
    service.state.running["busy"] = issue("busy", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC))  # type: ignore[union-attr]
    service.state.claimed.add("id-1")  # type: ignore[union-attr]
    service.state.retry_attempts["id-1"] = RetryEntry(  # type: ignore[union-attr]
        issue_id="id-1",
        identifier="id-1",
        attempt=2,
        due_at_ms=100,
        error="previous failure",
    )

    service._dispatch_due_retries([candidate], now_ms=100)

    retry = service.state.retry_attempts["id-1"]  # type: ignore[union-attr]
    assert retry.attempt == 3
    assert retry.error == "no available orchestrator slots"
    assert "id-1" in service.state.claimed  # type: ignore[union-attr]


def test_due_retry_releases_claim_when_issue_is_no_longer_candidate(tmp_path: Path) -> None:
    service = service_for_retry_tests(tmp_path)
    service.state.claimed.add("id-1")  # type: ignore[union-attr]
    service.state.retry_attempts["id-1"] = RetryEntry(  # type: ignore[union-attr]
        issue_id="id-1",
        identifier="id-1",
        attempt=2,
        due_at_ms=100,
        error="previous failure",
    )

    service._dispatch_due_retries([], now_ms=100)

    assert "id-1" not in service.state.retry_attempts  # type: ignore[union-attr]
    assert "id-1" not in service.state.claimed  # type: ignore[union-attr]


def test_worker_events_wait_for_orchestrator_drain(tmp_path: Path) -> None:
    service = service_for_retry_tests(tmp_path)
    candidate = issue("id-1", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC))
    entry = RunningEntry(issue=candidate, workspace_path=str(tmp_path / "workspaces" / "id-1"))
    service.state.running["id-1"] = entry  # type: ignore[union-attr]

    service._queue_agent_event(
        "id-1",
        AgentEvent(event="notification", timestamp=datetime(2026, 1, 1, tzinfo=UTC), payload={"message": "queued"}),
    )

    assert entry.last_codex_event is None

    service._drain_worker_events()

    assert entry.last_codex_event == "notification"
    assert entry.last_codex_message == "queued"
    assert service.state.recent_events[-1].event == "notification"  # type: ignore[union-attr]


def test_successful_stub_attempt_is_supervised_and_schedules_continuation_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    candidate = issue("id-1", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC))
    install_fake_tracker(monkeypatch, candidate)
    service = SymphonyService(stub_workflow_path(tmp_path, stub_delay_ms=25))
    try:
        service.start()
        service.tick()

        assert service.state is not None
        assert "id-1" in service.futures
        assert "id-1" in service.state.running
        running_payload = build_state_payload(service.state)
        assert running_payload["running"][0]["session_status"] == "running"
        assert running_payload["running"][0]["attempt"]["reason"] == "first_run"

        retry = wait_for_retry(service, "id-1")

        assert "id-1" not in service.state.running
        assert retry.attempt == 1
        assert retry.attempt_reason == "continuation"
        assert retry.continuation is True
        assert retry.error is None
        payload = build_state_payload(service.state)
        assert payload["retrying"][0]["continuation"] is True
        assert payload["retrying"][0]["attempt_reason"] == "continuation"
        assert payload["codex_totals"]["total_tokens"] > 0
        journal_path = tmp_path / "workspaces" / "id-1" / ".symphony" / "session.jsonl"
        journal_events = [json.loads(line) for line in journal_path.read_text(encoding="utf-8").splitlines()]
        assert [event["event"] for event in journal_events] == [
            "session_started",
            "attempt_started",
            "agent_event",
            "agent_event",
            "agent_event",
            "agent_event",
            "attempt_finished",
            "retry_scheduled",
        ]
        assert journal_events[0]["payload"]["execution_strategy"] == "plain_workspace"
        assert journal_events[1]["payload"]["attempt"]["reason"] == "first_run"
        assert [event["event"] for event in payload["recent_events"]] == [
            "session_started",
            "notification",
            "thread_tokenUsage_updated",
            "turn_completed",
        ]
    finally:
        shutdown_service(service)


def test_failed_stub_attempt_is_supervised_and_schedules_backoff_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    candidate = issue("id-1", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC))
    install_fake_tracker(monkeypatch, candidate)
    service = SymphonyService(stub_workflow_path(tmp_path, stub_exit="failure"))
    try:
        service.start()
        service.tick()

        retry = wait_for_retry(service, "id-1")

        assert retry.attempt == 1
        assert retry.attempt_reason == "error_retry"
        assert retry.continuation is False
        assert retry.error == "stub codex failure for id-1"
        assert "id-1" not in service.state.running  # type: ignore[union-attr]
    finally:
        shutdown_service(service)


def test_cancelled_agent_attempt_finishes_without_error_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    candidate = issue("id-1", priority=1, created_at=datetime(2026, 1, 1, tzinfo=UTC))
    install_fake_tracker(monkeypatch, candidate)
    monkeypatch.setattr("harness_engineering.runner.create_codex_client", lambda *_args: CancelingCodexClient())
    service = SymphonyService(stub_workflow_path(tmp_path))
    try:
        service.start()
        service.tick()

        for _ in range(100):
            future = service.futures.get("id-1")
            if future and future.done():
                break
            time.sleep(0.01)
        service._reap_finished_workers()

        assert "id-1" not in service.state.running  # type: ignore[union-attr]
        assert "id-1" not in service.state.retry_attempts  # type: ignore[union-attr]
        assert "id-1" not in service.state.claimed  # type: ignore[union-attr]
        journal_path = tmp_path / "workspaces" / "id-1" / ".symphony" / "session.jsonl"
        journal_events = [json.loads(line) for line in journal_path.read_text(encoding="utf-8").splitlines()]
        assert "retry_scheduled" not in [event["event"] for event in journal_events]
        assert any(event["event"] == "attempt_finished" and event["payload"]["attempt"]["status"] == "canceled" for event in journal_events)
    finally:
        shutdown_service(service)


class CancelingCodexClient:
    def run_turn(self, **_kwargs: object) -> None:
        raise AgentError("turn_cancelled", "codex turn was interrupted")
