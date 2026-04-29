from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


class WorkspaceError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class Workspace:
    path: Path
    workspace_key: str
    created_now: bool


def sanitize_workspace_key(identifier: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", identifier)


class WorkspaceManager:
    def __init__(self, root: str | Path, *, hooks: dict[str, str] | None = None, hook_timeout_ms: int = 60_000) -> None:
        self.root = Path(root).expanduser().resolve()
        self.hooks = hooks or {}
        self.hook_timeout_ms = hook_timeout_ms

    def create_for_issue(self, identifier: str) -> Workspace:
        key = sanitize_workspace_key(identifier)
        workspace_path = (self.root / key).resolve(strict=False)
        self.validate_workspace_path(workspace_path)
        self.root.mkdir(parents=True, exist_ok=True)

        if workspace_path.exists() and not workspace_path.is_dir():
            raise WorkspaceError("workspace_path_not_directory", f"workspace path is not a directory: {workspace_path}")

        created_now = not workspace_path.exists()
        workspace_path.mkdir(parents=True, exist_ok=True)
        workspace = Workspace(path=workspace_path, workspace_key=key, created_now=created_now)

        if created_now:
            self.run_hook("after_create", workspace_path, fatal=True)
        return workspace

    def remove_for_issue(self, identifier: str) -> None:
        key = sanitize_workspace_key(identifier)
        workspace_path = (self.root / key).resolve(strict=False)
        self.validate_workspace_path(workspace_path)
        if not workspace_path.exists():
            return
        self.run_hook("before_remove", workspace_path, fatal=False)
        shutil.rmtree(workspace_path)

    def validate_workspace_path(self, workspace_path: str | Path) -> None:
        candidate = Path(workspace_path).expanduser().resolve(strict=False)
        try:
            common = os.path.commonpath([str(self.root), str(candidate)])
        except ValueError as exc:
            raise WorkspaceError("workspace_outside_root", f"workspace path is outside root: {candidate}") from exc
        if common != str(self.root):
            raise WorkspaceError("workspace_outside_root", f"workspace path is outside root: {candidate}")

    def assert_agent_cwd(self, cwd: str | Path, workspace_path: str | Path) -> None:
        cwd_path = Path(cwd).expanduser().resolve(strict=False)
        expected = Path(workspace_path).expanduser().resolve(strict=False)
        self.validate_workspace_path(expected)
        if cwd_path != expected:
            raise WorkspaceError("invalid_workspace_cwd", f"agent cwd must be workspace path: cwd={cwd_path} workspace={expected}")

    def run_hook(self, name: str, workspace_path: str | Path, *, fatal: bool) -> None:
        script = self.hooks.get(name)
        if not script:
            return
        cwd = Path(workspace_path).expanduser().resolve(strict=False)
        self.validate_workspace_path(cwd)
        logger.info("hook starting hook=%s cwd=%s", name, cwd)
        try:
            result = subprocess.run(
                ["sh", "-lc", script],
                cwd=cwd,
                text=True,
                capture_output=True,
                timeout=self.hook_timeout_ms / 1000,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            logger.warning("hook timed_out hook=%s cwd=%s", name, cwd)
            if fatal:
                raise WorkspaceError("hook_timeout", f"hook {name} timed out") from exc
            return

        if result.returncode != 0:
            logger.warning(
                "hook failed hook=%s cwd=%s returncode=%s stderr=%s",
                name,
                cwd,
                result.returncode,
                _truncate(result.stderr),
            )
            if fatal:
                raise WorkspaceError("hook_failed", f"hook {name} failed with exit code {result.returncode}")
            return
        logger.info("hook completed hook=%s cwd=%s", name, cwd)


def _truncate(value: str, limit: int = 2000) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "...[truncated]"
