from __future__ import annotations

import subprocess
from pathlib import Path

from harness_engineering.execution_primitives import PrimitiveStatus, detect_commits, record_handoff, summarize_diff


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
