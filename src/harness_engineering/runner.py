from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from harness_engineering.agent import AgentEvent, create_codex_client
from harness_engineering.config import ServiceConfig
from harness_engineering.execution_primitives import PrimitiveOutcome, PrimitiveStatus, run_implement_attempt, run_review_attempt
from harness_engineering.execution_strategy import PlainWorkspaceStrategy
from harness_engineering.models import AttemptReason, AttemptStatus, Issue
from harness_engineering.session_journal import SessionJournal
from harness_engineering.workflow import WorkflowDefinition
from harness_engineering.workflow_templates import WorkflowTemplate, get_workflow_template
from harness_engineering.workspace import WorkspaceManager

logger = logging.getLogger(__name__)


class AgentRunCanceled(RuntimeError):
    pass


class AgentRunHandoff(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(slots=True)
class AgentRunner:
    config: ServiceConfig
    workflow: WorkflowDefinition
    workspace_manager: WorkspaceManager

    def run_attempt(
        self,
        issue: Issue,
        *,
        attempt: int | None,
        attempt_reason: str | None = None,
        on_event: Callable[[AgentEvent], None],
    ) -> None:
        prepared = PlainWorkspaceStrategy(self.workspace_manager).prepare(issue)
        template = _workflow_template(self.config.agent.workflow_template)
        journal = SessionJournal(prepared.workspace_path)
        attempt_number = 1 if attempt is None else attempt + 1
        reason = attempt_reason or (AttemptReason.FIRST_RUN if attempt is None else AttemptReason.ERROR_RETRY)
        _append_journal(
            journal,
            "session_started",
            issue=issue,
            message="worker session started",
            payload={"session_status": "running", "workflow_template": template.name, **prepared.metadata},
        )
        _append_journal(
            journal,
            "attempt_started",
            issue=issue,
            message=reason,
            payload={"attempt": {"number": attempt_number, "reason": reason, "status": AttemptStatus.RUNNING}},
        )

        def journaled_event(event: AgentEvent) -> None:
            _append_journal(
                journal,
                "agent_event",
                issue=issue,
                message=_summarize_payload(event.payload) or event.event,
                payload={
                    "event": event.event,
                    "usage": event.usage or {},
                    "codex_app_server_pid": event.codex_app_server_pid,
                },
            )
            on_event(event)

        try:
            self.workspace_manager.run_hook("before_run", prepared.workspace_path, fatal=True)
            client = create_codex_client(self.config.codex, self.workspace_manager)
            primitive_names = set(template.primitive_names)
            if "run_implement_attempt" in primitive_names:
                outcome = run_implement_attempt(
                    workspace_path=prepared.workspace_path,
                    issue=issue,
                    prompt_template=self.workflow.prompt_template,
                    attempt=attempt,
                    codex_client=client,
                    on_event=journaled_event,
                )
                _raise_for_unsuccessful_outcome(outcome, journal=journal, issue=issue, attempt_number=attempt_number, reason=reason)
            if "run_review_attempt" in primitive_names:
                outcome = run_review_attempt(
                    workspace_path=prepared.workspace_path,
                    issue=issue,
                    prompt_template=self.workflow.prompt_template,
                    attempt=attempt,
                    codex_client=client,
                    on_event=journaled_event,
                )
                _raise_for_unsuccessful_outcome(outcome, journal=journal, issue=issue, attempt_number=attempt_number, reason=reason)
            if template.handoff_state:
                _append_journal(
                    journal,
                    "attempt_finished",
                    issue=issue,
                    message=AttemptStatus.HANDOFF,
                    payload={
                        "attempt": {
                            "number": attempt_number,
                            "reason": reason,
                            "status": AttemptStatus.HANDOFF,
                            "handoff_reason": template.handoff_state,
                        },
                        "workflow_template": template.name,
                    },
                )
                raise AgentRunHandoff(template.handoff_state)
            _append_journal(
                journal,
                "attempt_finished",
                issue=issue,
                message=AttemptStatus.SUCCEEDED,
                payload={
                    "attempt": {"number": attempt_number, "reason": reason, "status": AttemptStatus.SUCCEEDED},
                    "workflow_template": template.name,
                },
            )
        except AgentRunHandoff:
            raise
        except AgentRunCanceled:
            raise
        except Exception as exc:
            _append_journal(
                journal,
                "attempt_finished",
                issue=issue,
                message=AttemptStatus.FAILED,
                payload={
                    "attempt": {"number": attempt_number, "reason": reason, "status": AttemptStatus.FAILED},
                    "error": str(exc),
                },
            )
            raise
        finally:
            self.workspace_manager.run_hook("after_run", prepared.workspace_path, fatal=False)


def _workflow_template(name: str) -> WorkflowTemplate:
    template = get_workflow_template(name)
    if template is None:
        raise RuntimeError(f"unknown workflow template: {name}")
    return template


def _raise_for_unsuccessful_outcome(
    outcome: PrimitiveOutcome,
    *,
    journal: SessionJournal,
    issue: Issue,
    attempt_number: int,
    reason: str,
) -> None:
    if outcome.status == PrimitiveStatus.SUCCEEDED:
        return
    if outcome.status == PrimitiveStatus.CANCELED:
        _append_journal(
            journal,
            "attempt_finished",
            issue=issue,
            message=AttemptStatus.CANCELED,
            payload={
                "attempt": {"number": attempt_number, "reason": reason, "status": AttemptStatus.CANCELED},
                "error": outcome.error,
            },
        )
        raise AgentRunCanceled(outcome.error or "agent run canceled")
    raise RuntimeError(outcome.error or f"primitive failed: {outcome.name}")


def _append_journal(
    journal: SessionJournal,
    event: str,
    *,
    issue: Issue,
    message: str,
    payload: dict[str, Any],
) -> None:
    try:
        journal.append(event, issue_id=issue.id, issue_identifier=issue.identifier, message=message, payload=payload)
    except OSError as exc:
        logger.warning("session_journal append failed issue_id=%s issue_identifier=%s reason=%s", issue.id, issue.identifier, exc)


def _summarize_payload(payload: dict[str, Any] | None) -> str | None:
    if not payload:
        return None
    for key in ("message", "text", "summary"):
        value = payload.get(key)
        if isinstance(value, str):
            return value[:300]
    return None
