from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any


class PrimitiveStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    HANDOFF = "handoff"
    CANCELED = "canceled"


@dataclass(frozen=True, slots=True)
class PrimitiveOutcome:
    name: str
    status: str
    metadata: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    handoff_reason: str | None = None


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


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=cwd, env=_git_env(), text=True, capture_output=True, check=False)


def _git_env() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
