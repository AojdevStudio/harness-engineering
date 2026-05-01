from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from harness_engineering.models import AgentAttempt, AttemptReason, AttemptStatus, Issue, SessionStatus, WorkerSession


@dataclass(slots=True)
class TokenTotals:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    seconds_running: float = 0.0


@dataclass(slots=True)
class RetryEntry:
    issue_id: str
    identifier: str
    attempt: int
    due_at_ms: int
    timer_handle: Any | None = None
    error: str | None = None
    continuation: bool = False
    attempt_reason: str | None = None
    session_status: str = SessionStatus.RETRYING
    last_error: str | None = None

    def __post_init__(self) -> None:
        if self.attempt_reason is None:
            self.attempt_reason = AttemptReason.CONTINUATION if self.continuation else AttemptReason.ERROR_RETRY
        if self.last_error is None:
            self.last_error = self.error


@dataclass(slots=True)
class RecentEvent:
    issue_id: str
    issue_identifier: str
    event: str
    timestamp: datetime
    message: str | None = None


@dataclass(slots=True)
class RunningEntry:
    issue: Issue
    workspace_path: str
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    attempt_number: int = 1
    attempt_reason: str = AttemptReason.FIRST_RUN
    session_status: str = SessionStatus.RUNNING
    execution_strategy: str = "plain_workspace"
    session_id: str | None = None
    codex_app_server_pid: str | None = None
    last_codex_event: str | None = None
    last_codex_timestamp: datetime | None = None
    last_codex_message: str | None = None
    codex_input_tokens: int = 0
    codex_output_tokens: int = 0
    codex_total_tokens: int = 0
    last_reported_input_tokens: int = 0
    last_reported_output_tokens: int = 0
    last_reported_total_tokens: int = 0
    turn_count: int = 0
    retry_attempt: int | None = None
    handoff_reason: str | None = None
    last_error: str | None = None
    worker_session: WorkerSession | None = None

    def __post_init__(self) -> None:
        if self.worker_session is not None:
            return
        self.worker_session = WorkerSession(
            issue_id=self.issue.id,
            issue_identifier=self.issue.identifier,
            workspace_path=self.workspace_path,
            session_status=self.session_status,
            execution_strategy=self.execution_strategy,
            current_attempt=AgentAttempt(
                number=self.attempt_number,
                reason=self.attempt_reason,
                status=AttemptStatus.RUNNING,
                started_at=self.started_at,
            ),
            handoff_reason=self.handoff_reason,
            last_error=self.last_error,
            last_event_at=self.last_codex_timestamp,
        )


@dataclass(slots=True)
class OrchestratorState:
    max_concurrent_agents: int
    active_states: set[str]
    terminal_states: set[str]
    poll_interval_ms: int = 30_000
    running: dict[str, RunningEntry | Issue] = field(default_factory=dict)
    claimed: set[str] = field(default_factory=set)
    retry_attempts: dict[str, RetryEntry] = field(default_factory=dict)
    completed: set[str] = field(default_factory=set)
    codex_totals: TokenTotals = field(default_factory=TokenTotals)
    codex_rate_limits: dict[str, Any] | None = None
    max_concurrent_agents_by_state: dict[str, int] = field(default_factory=dict)
    recent_events: list[RecentEvent] = field(default_factory=list)


class RetryScheduler:
    def __init__(self, *, max_backoff_ms: int) -> None:
        self.max_backoff_ms = max_backoff_ms

    def delay_ms(self, *, attempt: int, continuation: bool) -> int:
        if continuation:
            return 1_000
        return min(10_000 * (2 ** max(attempt - 1, 0)), self.max_backoff_ms)

    def create_entry(
        self,
        *,
        issue_id: str,
        identifier: str,
        attempt: int,
        now_ms: int,
        error: str | None = None,
        continuation: bool = False,
        attempt_reason: str | None = None,
        timer_handle: Any | None = None,
    ) -> RetryEntry:
        delay = self.delay_ms(attempt=attempt, continuation=continuation)
        return RetryEntry(
            issue_id=issue_id,
            identifier=identifier,
            attempt=attempt,
            due_at_ms=now_ms + delay,
            timer_handle=timer_handle,
            error=error,
            continuation=continuation,
            attempt_reason=attempt_reason,
        )


def sort_for_dispatch(issues: list[Issue]) -> list[Issue]:
    far_future = datetime.max.replace(tzinfo=UTC)
    return sorted(
        issues,
        key=lambda issue: (
            issue.priority if issue.priority is not None else 999_999,
            issue.created_at or far_future,
            issue.identifier,
        ),
    )


def available_slots(state: OrchestratorState, *, state_name: str | None = None) -> int:
    global_slots = max(state.max_concurrent_agents - len(state.running), 0)
    if state_name is None:
        return global_slots
    normalized = state_name.lower()
    per_state_limit = state.max_concurrent_agents_by_state.get(normalized, state.max_concurrent_agents)
    running_in_state = sum(1 for entry in state.running.values() if _entry_state(entry) == normalized)
    return min(global_slots, max(per_state_limit - running_in_state, 0))


def should_dispatch(issue: Issue, state: OrchestratorState) -> bool:
    if not issue.id or not issue.identifier or not issue.title or not issue.state:
        return False
    issue_state = issue.state.lower()
    if issue_state not in state.active_states:
        return False
    if issue_state in state.terminal_states:
        return False
    if issue.id in state.running or issue.id in state.claimed:
        return False
    if available_slots(state, state_name=issue_state) <= 0:
        return False
    if issue_state == "todo":
        for blocker in issue.blocked_by:
            blocker_state = (blocker.state or "").lower()
            if blocker_state not in state.terminal_states:
                return False
    return True


def _entry_state(entry: RunningEntry | Issue) -> str:
    if isinstance(entry, RunningEntry):
        return entry.issue.state.lower()
    return entry.state.lower()
