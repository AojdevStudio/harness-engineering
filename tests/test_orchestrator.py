from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from harness_engineering.config import ServiceConfig
from harness_engineering.models import BlockerRef, Issue
from harness_engineering.orchestrator import (
    OrchestratorState,
    RetryEntry,
    RetryScheduler,
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
