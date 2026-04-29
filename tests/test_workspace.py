from __future__ import annotations

from pathlib import Path

import pytest

from harness_engineering.workspace import WorkspaceError, WorkspaceManager, sanitize_workspace_key


def test_workspace_keys_are_deterministically_sanitized() -> None:
    assert sanitize_workspace_key("HE/123 bad:chars") == "HE_123_bad_chars"
    assert sanitize_workspace_key("ABC-1.ok") == "ABC-1.ok"


def test_create_reuses_workspace_and_runs_after_create_once(tmp_path: Path) -> None:
    manager = WorkspaceManager(
        tmp_path / "root",
        hooks={"after_create": "printf created >> marker.txt"},
        hook_timeout_ms=5_000,
    )

    first = manager.create_for_issue("HE-1")
    second = manager.create_for_issue("HE-1")

    assert first.path == second.path
    assert first.created_now is True
    assert second.created_now is False
    assert (first.path / "marker.txt").read_text(encoding="utf-8") == "created"


def test_before_run_hook_failure_aborts_attempt(tmp_path: Path) -> None:
    manager = WorkspaceManager(
        tmp_path / "root",
        hooks={"before_run": "exit 42"},
        hook_timeout_ms=5_000,
    )
    workspace = manager.create_for_issue("HE-2")

    with pytest.raises(WorkspaceError) as exc:
        manager.run_hook("before_run", workspace.path, fatal=True)

    assert exc.value.code == "hook_failed"


def test_cleanup_runs_before_remove_best_effort_and_removes_workspace(tmp_path: Path) -> None:
    manager = WorkspaceManager(
        tmp_path / "root",
        hooks={"before_remove": "printf removing >> cleanup.txt; exit 10"},
        hook_timeout_ms=5_000,
    )
    workspace = manager.create_for_issue("HE-3")

    manager.remove_for_issue("HE-3")

    assert not workspace.path.exists()


def test_workspace_path_must_stay_under_root(tmp_path: Path) -> None:
    manager = WorkspaceManager(tmp_path / "root")

    with pytest.raises(WorkspaceError) as exc:
        manager.validate_workspace_path((tmp_path / "outside").resolve())

    assert exc.value.code == "workspace_outside_root"
