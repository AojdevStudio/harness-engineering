from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from harness_engineering.models import Issue
from harness_engineering.workspace import WorkspaceManager, sanitize_workspace_key


class ExecutionStrategyError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class PreparedExecution:
    name: str
    workspace_path: Path
    metadata: dict[str, object]


class ExecutionStrategy(Protocol):
    name: str

    def prepare(self, issue: Issue) -> PreparedExecution:
        raise NotImplementedError


@dataclass(slots=True)
class PlainWorkspaceStrategy:
    workspace_manager: WorkspaceManager
    name: str = "plain_workspace"

    def prepare(self, issue: Issue) -> PreparedExecution:
        workspace = self.workspace_manager.create_for_issue(issue.identifier)
        workspace_key = sanitize_workspace_key(issue.identifier)
        return PreparedExecution(
            name=self.name,
            workspace_path=workspace.path,
            metadata={
                "execution_strategy": self.name,
                "workspace_key": workspace_key,
                "workspace_path": str(workspace.path),
                "created_now": workspace.created_now,
            },
        )


@dataclass(slots=True)
class GitWorktreeBranchStrategy:
    repo_path: Path
    worktree_root: Path
    branch_prefix: str = "harness"
    name: str = "git_worktree_branch"

    def prepare(self, issue: Issue) -> PreparedExecution:
        workspace_key = sanitize_workspace_key(issue.identifier)
        workspace_path = self.worktree_root / workspace_key
        branch_name = f"{self.branch_prefix}/{workspace_key}"

        if workspace_path.exists():
            if not workspace_path.is_dir():
                raise ExecutionStrategyError(
                    "worktree_path_not_directory", f"worktree path exists and is not a directory: {workspace_path}"
                )
            if _is_dirty(workspace_path):
                raise ExecutionStrategyError("dirty_worktree", f"managed worktree is dirty: {workspace_path}")
            return self._prepared(workspace_key, workspace_path, branch_name, created_now=False)

        self.worktree_root.mkdir(parents=True, exist_ok=True)
        if _branch_exists(self.repo_path, branch_name):
            _git(self.repo_path, "worktree", "add", str(workspace_path), branch_name)
        else:
            _git(self.repo_path, "worktree", "add", "-b", branch_name, str(workspace_path), "HEAD")
        return self._prepared(workspace_key, workspace_path, branch_name, created_now=True)

    def _prepared(self, workspace_key: str, workspace_path: Path, branch_name: str, *, created_now: bool) -> PreparedExecution:
        return PreparedExecution(
            name=self.name,
            workspace_path=workspace_path,
            metadata={
                "execution_strategy": self.name,
                "workspace_key": workspace_key,
                "workspace_path": str(workspace_path),
                "branch_name": branch_name,
                "created_now": created_now,
            },
        )


def _branch_exists(repo_path: Path, branch_name: str) -> bool:
    result = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch_name}"],
        cwd=repo_path,
        env=_git_env(),
        text=True,
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def _is_dirty(worktree_path: Path) -> bool:
    output = _git(worktree_path, "status", "--porcelain")
    return bool(output.strip())


def _git(cwd: Path, *args: str) -> str:
    try:
        result = subprocess.run(["git", *args], cwd=cwd, env=_git_env(), text=True, capture_output=True, check=True)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() if exc.stderr else str(exc)
        raise ExecutionStrategyError("git_command_failed", stderr) from exc
    return result.stdout


def _git_env() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
