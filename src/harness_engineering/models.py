from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


@dataclass(slots=True)
class BlockerRef:
    id: str | None = None
    identifier: str | None = None
    state: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "identifier": self.identifier, "state": self.state}


@dataclass(slots=True)
class Issue:
    id: str
    identifier: str
    title: str
    state: str
    description: str | None = None
    priority: int | None = None
    branch_name: str | None = None
    url: str | None = None
    labels: list[str] = field(default_factory=list)
    blocked_by: list[BlockerRef] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "identifier": self.identifier,
            "title": self.title,
            "description": self.description,
            "priority": self.priority,
            "state": self.state,
            "branch_name": self.branch_name,
            "url": self.url,
            "labels": list(self.labels),
            "blocked_by": [blocker.to_dict() for blocker in self.blocked_by],
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class SessionStatus(StrEnum):
    PREPARING = "preparing"
    RUNNING = "running"
    HANDOFF = "handoff"
    RETRYING = "retrying"
    CANCELED = "canceled"
    FAILED = "failed"
    SUCCEEDED = "succeeded"


class AttemptReason(StrEnum):
    FIRST_RUN = "first_run"
    CONTINUATION = "continuation"
    ERROR_RETRY = "error_retry"
    STALLED_RETRY = "stalled_retry"
    OPERATOR_REFRESH = "operator_refresh"


class AttemptStatus(StrEnum):
    PREPARING = "preparing"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    CANCELED = "canceled"
    HANDOFF = "handoff"


class HandoffReason(StrEnum):
    PR_OPENED = "pr_opened"
    ISSUE_CLOSED = "issue_closed"
    NON_ACTIVE_STATE = "non_active_state"
    MAX_TURNS = "max_turns"
    COMPLETION_SIGNAL = "completion_signal"


@dataclass(slots=True)
class AgentAttempt:
    number: int
    reason: str
    status: str = AttemptStatus.RUNNING
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    error: str | None = None
    handoff_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "number": self.number,
            "reason": self.reason,
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "error": self.error,
            "handoff_reason": self.handoff_reason,
        }


@dataclass(slots=True)
class WorkerSession:
    issue_id: str
    issue_identifier: str
    workspace_path: str
    session_status: str = SessionStatus.RUNNING
    execution_strategy: str = "plain_workspace"
    current_attempt: AgentAttempt | None = None
    handoff_reason: str | None = None
    last_error: str | None = None
    last_event_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "issue_id": self.issue_id,
            "issue_identifier": self.issue_identifier,
            "workspace_path": self.workspace_path,
            "session_status": self.session_status,
            "execution_strategy": self.execution_strategy,
            "current_attempt": self.current_attempt.to_dict() if self.current_attempt else None,
            "handoff_reason": self.handoff_reason,
            "last_error": self.last_error,
            "last_event_at": self.last_event_at.isoformat() if self.last_event_at else None,
        }
