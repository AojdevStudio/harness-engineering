from __future__ import annotations

import os
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from harness_engineering.execution_strategy import ExecutionStrategy
from harness_engineering.models import Issue
from harness_engineering.prompt import render_prompt


class PrimitiveStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    HANDOFF = "handoff"
    CANCELED = "canceled"


class PrimitiveAction(StrEnum):
    CONTINUE = "continue"
    RETRY = "retry"
    HANDOFF = "handoff"
    CANCEL = "cancel"
    FAIL = "fail"


@dataclass(frozen=True, slots=True)
class PrimitiveOutcome:
    name: str
    status: str
    metadata: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    handoff_reason: str | None = None


@dataclass(frozen=True, slots=True)
class PrimitiveResolution:
    action: PrimitiveAction
    reason: str | None = None


class PrimitiveCodexClient(Protocol):
    def run_turn(
        self,
        *,
        workspace_path: Path,
        issue: Issue,
        prompt: str,
        on_event: Callable[[Any], None],
    ) -> None: ...


def resolve_primitive_outcome(outcome: PrimitiveOutcome) -> PrimitiveResolution:
    if outcome.status == PrimitiveStatus.SUCCEEDED:
        return PrimitiveResolution(action=PrimitiveAction.CONTINUE)
    if outcome.status == PrimitiveStatus.HANDOFF:
        return PrimitiveResolution(action=PrimitiveAction.HANDOFF, reason=outcome.handoff_reason or outcome.error)
    if outcome.status == PrimitiveStatus.CANCELED:
        return PrimitiveResolution(action=PrimitiveAction.CANCEL, reason=outcome.error)
    if outcome.status == PrimitiveStatus.FAILED:
        action = PrimitiveAction.RETRY if outcome.metadata.get("retryable", True) else PrimitiveAction.FAIL
        return PrimitiveResolution(action=action, reason=outcome.error)
    return PrimitiveResolution(action=PrimitiveAction.FAIL, reason=f"unknown primitive status: {outcome.status}")


def detect_commits(workspace_path: Path | str, *, base_ref: str) -> PrimitiveOutcome:
    workspace = Path(workspace_path)
    result = _git(workspace, "rev-list", "--reverse", f"{base_ref}..HEAD")
    if result.returncode != 0:
        return PrimitiveOutcome(name="detect_commits", status=PrimitiveStatus.FAILED, error=result.stderr.strip())
    commits = [line for line in result.stdout.splitlines() if line]
    return PrimitiveOutcome(
        name="detect_commits",
        status=PrimitiveStatus.SUCCEEDED,
        metadata={"has_commits": bool(commits), "commit_count": len(commits), "commits": commits},
    )


def summarize_diff(workspace_path: Path | str, *, base_ref: str) -> PrimitiveOutcome:
    workspace = Path(workspace_path)
    result = _git(workspace, "diff", "--stat", f"{base_ref}..HEAD")
    if result.returncode != 0:
        return PrimitiveOutcome(name="summarize_diff", status=PrimitiveStatus.FAILED, error=result.stderr.strip())
    return PrimitiveOutcome(name="summarize_diff", status=PrimitiveStatus.SUCCEEDED, metadata={"stat": result.stdout.strip()})


def record_handoff(*, handoff_type: str, target_url: str | None, reason: str) -> PrimitiveOutcome:
    return PrimitiveOutcome(
        name="record_handoff",
        status=PrimitiveStatus.HANDOFF,
        handoff_reason=reason,
        metadata={"handoff_type": handoff_type, "target_url": target_url},
    )


def create_pr_handoff(*, target_url: str, branch_name: str | None = None, reason: str = "pr_opened") -> PrimitiveOutcome:
    return PrimitiveOutcome(
        name="create_pr_handoff",
        status=PrimitiveStatus.SUCCEEDED,
        metadata={
            "handoff_type": "pull_request",
            "target_url": target_url,
            "branch_name": branch_name,
            "handoff_reason": reason,
        },
    )


def prepare_workspace(*, issue: Issue, strategy: ExecutionStrategy) -> PrimitiveOutcome:
    try:
        prepared = strategy.prepare(issue)
    except Exception as exc:
        return PrimitiveOutcome(name="prepare_workspace", status=PrimitiveStatus.FAILED, error=str(exc))
    return PrimitiveOutcome(
        name="prepare_workspace",
        status=PrimitiveStatus.SUCCEEDED,
        metadata={
            **prepared.metadata,
            "execution_strategy": prepared.name,
            "workspace_path": str(prepared.workspace_path),
        },
    )


def run_implement_attempt(
    *,
    workspace_path: Path | str,
    issue: Issue,
    prompt_template: str,
    attempt: int | None,
    codex_client: PrimitiveCodexClient,
    on_event: Callable[[Any], None],
) -> PrimitiveOutcome:
    return _run_agent_attempt(
        name="run_implement_attempt",
        turn_kind="implement",
        workspace_path=workspace_path,
        issue=issue,
        prompt_template=prompt_template,
        attempt=attempt,
        codex_client=codex_client,
        on_event=on_event,
    )


def run_review_attempt(
    *,
    workspace_path: Path | str,
    issue: Issue,
    prompt_template: str,
    attempt: int | None,
    codex_client: PrimitiveCodexClient,
    on_event: Callable[[Any], None],
) -> PrimitiveOutcome:
    return _run_agent_attempt(
        name="run_review_attempt",
        turn_kind="review",
        workspace_path=workspace_path,
        issue=issue,
        prompt_template=prompt_template,
        attempt=attempt,
        codex_client=codex_client,
        on_event=on_event,
    )


def _run_agent_attempt(
    *,
    name: str,
    turn_kind: str,
    workspace_path: Path | str,
    issue: Issue,
    prompt_template: str,
    attempt: int | None,
    codex_client: PrimitiveCodexClient,
    on_event: Callable[[Any], None],
) -> PrimitiveOutcome:
    workspace = Path(workspace_path)
    try:
        prompt = render_prompt(prompt_template, issue, attempt)
        codex_client.run_turn(workspace_path=workspace, issue=issue, prompt=prompt, on_event=on_event)
    except Exception as exc:
        return PrimitiveOutcome(
            name=name,
            status=PrimitiveStatus.FAILED,
            metadata={"turn_kind": turn_kind, "workspace_path": str(workspace)},
            error=str(exc),
        )
    return PrimitiveOutcome(
        name=name,
        status=PrimitiveStatus.SUCCEEDED,
        metadata={"turn_kind": turn_kind, "workspace_path": str(workspace)},
    )


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=cwd, env=_git_env(), text=True, capture_output=True, check=False)


def _git_env() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
