from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class WorkflowLoadError(RuntimeError):
    def __init__(self, code: str, message: str, *, path: Path | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.path = path


@dataclass(frozen=True, slots=True)
class WorkflowDefinition:
    config: dict[str, Any]
    prompt_template: str
    path: Path


def select_workflow_path(explicit_path: str | None, *, cwd: Path | None = None) -> Path:
    base = cwd or Path.cwd()
    if explicit_path:
        return Path(explicit_path).expanduser().resolve()
    return (base / "WORKFLOW.md").resolve()


def load_workflow(path: str | Path) -> WorkflowDefinition:
    workflow_path = Path(path).expanduser().resolve()
    try:
        text = workflow_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise WorkflowLoadError(
            "missing_workflow_file",
            f"workflow file cannot be read: {workflow_path}",
            path=workflow_path,
        ) from exc

    config: dict[str, Any]
    body: str
    if text.startswith("---"):
        front_matter, body = _split_front_matter(text, workflow_path)
        try:
            decoded = yaml.safe_load(front_matter) if front_matter.strip() else {}
        except yaml.YAMLError as exc:
            raise WorkflowLoadError(
                "workflow_parse_error",
                f"workflow front matter is invalid YAML: {workflow_path}",
                path=workflow_path,
            ) from exc
        if decoded is None:
            decoded = {}
        if not isinstance(decoded, dict):
            raise WorkflowLoadError(
                "workflow_front_matter_not_a_map",
                "workflow front matter must decode to a map",
                path=workflow_path,
            )
        if any(not isinstance(key, str) for key in decoded):
            raise WorkflowLoadError(
                "workflow_parse_error",
                "workflow front matter keys must be strings",
                path=workflow_path,
            )
        config = decoded
    else:
        config = {}
        body = text

    return WorkflowDefinition(config=config, prompt_template=body.strip(), path=workflow_path)


def _split_front_matter(text: str, path: Path) -> tuple[str, str]:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return "", text
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "".join(lines[1:index]), "".join(lines[index + 1 :])
    raise WorkflowLoadError(
        "workflow_parse_error",
        f"workflow front matter is missing closing delimiter: {path}",
        path=path,
    )


class WorkflowReloader:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser().resolve()
        self.current: WorkflowDefinition | None = None
        self.last_error: WorkflowLoadError | None = None
        self._last_mtime_ns: int | None = None

    def load_initial(self) -> WorkflowDefinition:
        workflow = load_workflow(self.path)
        self.current = workflow
        self.last_error = None
        self._last_mtime_ns = self.path.stat().st_mtime_ns
        return workflow

    def reload_if_changed(self, *, force: bool = False) -> bool:
        try:
            mtime_ns = self.path.stat().st_mtime_ns
        except OSError:
            self.last_error = WorkflowLoadError(
                "missing_workflow_file",
                f"workflow file cannot be statted: {self.path}",
                path=self.path,
            )
            return False

        if not force and self._last_mtime_ns == mtime_ns:
            return False

        try:
            workflow = load_workflow(self.path)
        except WorkflowLoadError as exc:
            self.last_error = exc
            return False

        self.current = workflow
        self.last_error = None
        self._last_mtime_ns = mtime_ns
        return True
