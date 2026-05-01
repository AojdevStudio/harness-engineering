from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from harness_engineering.execution_strategy import ExecutionStrategyError, GitWorktreeBranchStrategy, PlainWorkspaceStrategy
from harness_engineering.models import Issue
from harness_engineering.workspace import WorkspaceManager


def test_plain_workspace_strategy_prepares_workspace_and_reports_metadata(tmp_path: Path) -> None:
    manager = WorkspaceManager(tmp_path)
    strategy = PlainWorkspaceStrategy(manager)
    issue = Issue(id="id-1", identifier="repo#1", title="One", state="open")

    prepared = strategy.prepare(issue)

    assert prepared.name == "plain_workspace"
    assert prepared.workspace_path == tmp_path / "repo_1"
    assert prepared.metadata == {
        "execution_strategy": "plain_workspace",
        "workspace_key": "repo_1",
        "workspace_path": str(tmp_path / "repo_1"),
        "created_now": True,
    }
    assert prepared.workspace_path.is_dir()


def test_git_worktree_branch_strategy_creates_issue_branch_worktree(tmp_path: Path) -> None:
    repo = init_repo(tmp_path / "repo")
    strategy = GitWorktreeBranchStrategy(repo_path=repo, worktree_root=tmp_path / "worktrees")
    issue = Issue(id="id-1", identifier="repo#1", title="One", state="open")

    prepared = strategy.prepare(issue)

    assert prepared.name == "git_worktree_branch"
    assert prepared.workspace_path == tmp_path / "worktrees" / "repo_1"
    assert prepared.metadata["execution_strategy"] == "git_worktree_branch"
    assert prepared.metadata["workspace_key"] == "repo_1"
    assert prepared.metadata["branch_name"] == "harness/repo_1"
    assert prepared.metadata["created_now"] is True
    assert (prepared.workspace_path / ".git").exists()
    assert git(repo, "show-ref", "--verify", "refs/heads/harness/repo_1").strip()


def test_git_worktree_branch_strategy_reuses_clean_managed_worktree(tmp_path: Path) -> None:
    repo = init_repo(tmp_path / "repo")
    strategy = GitWorktreeBranchStrategy(repo_path=repo, worktree_root=tmp_path / "worktrees")
    issue = Issue(id="id-1", identifier="repo#1", title="One", state="open")

    first = strategy.prepare(issue)
    second = strategy.prepare(issue)

    assert second.workspace_path == first.workspace_path
    assert second.metadata["created_now"] is False


def test_git_worktree_branch_strategy_rejects_dirty_reused_worktree(tmp_path: Path) -> None:
    repo = init_repo(tmp_path / "repo")
    strategy = GitWorktreeBranchStrategy(repo_path=repo, worktree_root=tmp_path / "worktrees")
    issue = Issue(id="id-1", identifier="repo#1", title="One", state="open")
    prepared = strategy.prepare(issue)
    (prepared.workspace_path / "dirty.txt").write_text("dirty", encoding="utf-8")

    with pytest.raises(ExecutionStrategyError, match="dirty"):
        strategy.prepare(issue)


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
