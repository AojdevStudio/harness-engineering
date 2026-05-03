from __future__ import annotations

import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from harness_engineering.agent import AgentError, AgentEvent
from harness_engineering.execution_primitives import (
    PrimitiveAction,
    PrimitiveOutcome,
    PrimitiveStatus,
    create_pr_handoff,
    detect_commits,
    prepare_workspace,
    record_handoff,
    resolve_primitive_outcome,
    run_implement_attempt,
    run_review_attempt,
    summarize_diff,
)
from harness_engineering.execution_strategy import PlainWorkspaceStrategy
from harness_engineering.models import Issue
from harness_engineering.workspace import WorkspaceManager


def test_detect_commits_reports_commits_since_base_ref(tmp_path: Path) -> None:
    repo = init_repo(tmp_path / "repo")
    git(repo, "checkout", "-b", "feature")
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")

    outcome = detect_commits(repo, base_ref="main")

    assert outcome.name == "detect_commits"
    assert outcome.status == PrimitiveStatus.SUCCEEDED
    assert outcome.metadata["has_commits"] is True
    assert outcome.metadata["commit_count"] == 1
    assert len(outcome.metadata["commits"]) == 1


def test_detect_commits_returns_failed_outcome_for_non_git_workspace(tmp_path: Path) -> None:
    outcome = detect_commits(tmp_path, base_ref="main")

    assert outcome.status == PrimitiveStatus.FAILED
    assert outcome.error is not None


def test_summarize_diff_returns_stat_text(tmp_path: Path) -> None:
    repo = init_repo(tmp_path / "repo")
    git(repo, "checkout", "-b", "feature")
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")

    outcome = summarize_diff(repo, base_ref="main")

    assert outcome.status == PrimitiveStatus.SUCCEEDED
    assert "feature.txt" in outcome.metadata["stat"]


def test_record_handoff_returns_typed_handoff_outcome() -> None:
    outcome = record_handoff(handoff_type="pull_request", target_url="https://github.com/acme/repo/pull/1", reason="pr_opened")

    assert outcome.name == "record_handoff"
    assert outcome.status == PrimitiveStatus.HANDOFF
    assert outcome.handoff_reason == "pr_opened"
    assert outcome.metadata["target_url"] == "https://github.com/acme/repo/pull/1"


def test_create_pr_handoff_represents_pull_request_without_tracker_write() -> None:
    outcome = create_pr_handoff(
        target_url="https://github.com/acme/repo/pull/1",
        branch_name="harness/repo_1",
        reason="pr_opened",
    )

    assert outcome.name == "create_pr_handoff"
    assert outcome.status == PrimitiveStatus.HANDOFF
    assert outcome.handoff_reason == "pr_opened"
    assert resolve_primitive_outcome(outcome).action == PrimitiveAction.HANDOFF
    assert outcome.metadata == {
        "handoff_type": "pull_request",
        "target_url": "https://github.com/acme/repo/pull/1",
        "branch_name": "harness/repo_1",
    }


def test_primitive_outcomes_map_to_template_actions() -> None:
    assert resolve_primitive_outcome(PrimitiveOutcome(name="ok", status=PrimitiveStatus.SUCCEEDED)).action == PrimitiveAction.CONTINUE

    retry = resolve_primitive_outcome(PrimitiveOutcome(name="retry", status=PrimitiveStatus.FAILED, error="temporary"))
    assert retry.action == PrimitiveAction.RETRY
    assert retry.reason == "temporary"

    failure = resolve_primitive_outcome(
        PrimitiveOutcome(name="fail", status=PrimitiveStatus.FAILED, error="bad prompt", metadata={"retryable": False})
    )
    assert failure.action == PrimitiveAction.FAIL
    assert failure.reason == "bad prompt"

    handoff = resolve_primitive_outcome(PrimitiveOutcome(name="handoff", status=PrimitiveStatus.HANDOFF, handoff_reason="pr_opened"))
    assert handoff.action == PrimitiveAction.HANDOFF
    assert handoff.reason == "pr_opened"

    canceled = resolve_primitive_outcome(PrimitiveOutcome(name="cancel", status=PrimitiveStatus.CANCELED, error="non_active_state"))
    assert canceled.action == PrimitiveAction.CANCEL
    assert canceled.reason == "non_active_state"


def test_prepare_workspace_uses_execution_strategy_metadata(tmp_path: Path) -> None:
    issue = Issue(id="id-1", identifier="repo#1", title="Add primitive", state="open")
    strategy = PlainWorkspaceStrategy(WorkspaceManager(tmp_path))

    outcome = prepare_workspace(issue=issue, strategy=strategy)

    assert outcome.name == "prepare_workspace"
    assert outcome.status == PrimitiveStatus.SUCCEEDED
    assert outcome.metadata["execution_strategy"] == "plain_workspace"
    assert outcome.metadata["workspace_key"] == "repo_1"
    assert Path(str(outcome.metadata["workspace_path"])).is_dir()


def test_run_implement_attempt_renders_policy_prompt_and_runs_client(tmp_path: Path) -> None:
    client = RecordingClient()
    issue = Issue(id="id-1", identifier="repo#1", title="Add primitive", state="open")
    events: list[AgentEvent] = []

    outcome = run_implement_attempt(
        workspace_path=tmp_path,
        issue=issue,
        prompt_template="Work on {{ issue.identifier }} attempt={{ attempt }}",
        attempt=2,
        codex_client=client,
        on_event=events.append,
    )

    assert outcome.name == "run_implement_attempt"
    assert outcome.status == PrimitiveStatus.SUCCEEDED
    assert outcome.metadata["turn_kind"] == "implement"
    assert client.calls == [
        {
            "workspace_path": tmp_path,
            "issue_identifier": "repo#1",
            "prompt": "Work on repo#1 attempt=2",
        }
    ]
    assert [event.event for event in events] == ["turn_completed"]


def test_run_implement_attempt_returns_failed_outcome_when_client_fails(tmp_path: Path) -> None:
    issue = Issue(id="id-1", identifier="repo#1", title="Add primitive", state="open")

    outcome = run_implement_attempt(
        workspace_path=tmp_path,
        issue=issue,
        prompt_template="Work on {{ issue.identifier }}",
        attempt=None,
        codex_client=FailingClient("codex failed"),
        on_event=lambda _event: None,
    )

    assert outcome.name == "run_implement_attempt"
    assert outcome.status == PrimitiveStatus.FAILED
    assert outcome.error == "codex failed"


def test_run_implement_attempt_returns_canceled_outcome_when_client_cancels(tmp_path: Path) -> None:
    issue = Issue(id="id-1", identifier="repo#1", title="Add primitive", state="open")

    outcome = run_implement_attempt(
        workspace_path=tmp_path,
        issue=issue,
        prompt_template="Work on {{ issue.identifier }}",
        attempt=None,
        codex_client=CancelingClient(),
        on_event=lambda _event: None,
    )

    assert outcome.name == "run_implement_attempt"
    assert outcome.status == PrimitiveStatus.CANCELED
    assert resolve_primitive_outcome(outcome).action == PrimitiveAction.CANCEL
    assert outcome.error == "codex turn was interrupted"


def test_run_review_attempt_uses_review_prompt_and_reports_review_kind(tmp_path: Path) -> None:
    client = RecordingClient()
    issue = Issue(id="id-1", identifier="repo#1", title="Add primitive", state="open")

    outcome = run_review_attempt(
        workspace_path=tmp_path,
        issue=issue,
        prompt_template="Review {{ issue.title }}",
        attempt=1,
        codex_client=client,
        on_event=lambda _event: None,
    )

    assert outcome.name == "run_review_attempt"
    assert outcome.status == PrimitiveStatus.SUCCEEDED
    assert outcome.metadata["turn_kind"] == "review"
    assert client.calls[0]["prompt"] == "Review Add primitive"


def init_repo(path: Path) -> Path:
    path.mkdir()
    git(path, "init", "-b", "main")
    git(path, "config", "user.email", "test@example.com")
    git(path, "config", "user.name", "Test User")
    (path / "README.md").write_text("# Test\n", encoding="utf-8")
    git(path, "add", "README.md")
    git(path, "commit", "-m", "initial")
    return path


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=True)
    return result.stdout


class RecordingClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def run_turn(
        self,
        *,
        workspace_path: Path,
        issue: Issue,
        prompt: str,
        on_event: Any,
    ) -> None:
        self.calls.append(
            {
                "workspace_path": workspace_path,
                "issue_identifier": issue.identifier,
                "prompt": prompt,
            }
        )
        on_event(AgentEvent(event="turn_completed", timestamp=datetime(2026, 1, 1, tzinfo=UTC)))


class FailingClient:
    def __init__(self, message: str) -> None:
        self.message = message

    def run_turn(
        self,
        *,
        workspace_path: Path,
        issue: Issue,
        prompt: str,
        on_event: Any,
    ) -> None:
        raise RuntimeError(self.message)


class CancelingClient:
    def run_turn(
        self,
        *,
        workspace_path: Path,
        issue: Issue,
        prompt: str,
        on_event: Any,
    ) -> None:
        raise AgentError("turn_cancelled", "codex turn was interrupted")
