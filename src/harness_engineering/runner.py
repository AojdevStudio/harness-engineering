from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from harness_engineering.agent import AgentEvent, create_codex_client
from harness_engineering.config import ServiceConfig
from harness_engineering.execution_strategy import PlainWorkspaceStrategy
from harness_engineering.models import AttemptReason, AttemptStatus, Issue
from harness_engineering.prompt import render_prompt
from harness_engineering.session_journal import SessionJournal
from harness_engineering.workflow import WorkflowDefinition
from harness_engineering.workspace import WorkspaceManager

logger = logging.getLogger(__name__)


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
        journal = SessionJournal(prepared.workspace_path)
        attempt_number = 1 if attempt is None else attempt + 1
        reason = attempt_reason or (AttemptReason.FIRST_RUN if attempt is None else AttemptReason.ERROR_RETRY)
        _append_journal(
            journal,
            "session_started",
            issue=issue,
            message="worker session started",
            payload={"session_status": "running", **prepared.metadata},
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
            prompt = render_prompt(self.workflow.prompt_template, issue, attempt)
            client.run_turn(workspace_path=prepared.workspace_path, issue=issue, prompt=prompt, on_event=journaled_event)
            _append_journal(
                journal,
                "attempt_finished",
                issue=issue,
                message=AttemptStatus.SUCCEEDED,
                payload={"attempt": {"number": attempt_number, "reason": reason, "status": AttemptStatus.SUCCEEDED}},
            )
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
