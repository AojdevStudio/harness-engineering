from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from harness_engineering.workflow import WorkflowDefinition


class ConfigError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class TrackerConfig:
    kind: str
    endpoint: str
    api_key: str | None
    active_states: list[str]
    terminal_states: list[str]
    owner: str | None = None
    repo: str | None = None
    project_slug: str | None = None


@dataclass(frozen=True, slots=True)
class PollingConfig:
    interval_ms: int = 30_000


@dataclass(frozen=True, slots=True)
class WorkspaceConfig:
    root: Path


@dataclass(frozen=True, slots=True)
class HooksConfig:
    after_create: str | None = None
    before_run: str | None = None
    after_run: str | None = None
    before_remove: str | None = None
    timeout_ms: int = 60_000

    def as_scripts(self) -> dict[str, str]:
        return {
            name: script
            for name, script in {
                "after_create": self.after_create,
                "before_run": self.before_run,
                "after_run": self.after_run,
                "before_remove": self.before_remove,
            }.items()
            if script
        }


@dataclass(frozen=True, slots=True)
class AgentConfig:
    max_concurrent_agents: int = 10
    max_turns: int = 20
    max_retry_backoff_ms: int = 300_000
    max_concurrent_agents_by_state: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class CodexConfig:
    command: str = "codex app-server"
    approval_policy: str | None = None
    thread_sandbox: str | None = None
    turn_sandbox_policy: Any | None = None
    turn_timeout_ms: int = 3_600_000
    read_timeout_ms: int = 5_000
    stall_timeout_ms: int = 300_000


@dataclass(frozen=True, slots=True)
class ServerConfig:
    port: int | None = None
    host: str = "127.0.0.1"


@dataclass(frozen=True, slots=True)
class ServiceConfig:
    tracker: TrackerConfig
    polling: PollingConfig
    workspace: WorkspaceConfig
    hooks: HooksConfig
    agent: AgentConfig
    codex: CodexConfig
    server: ServerConfig = field(default_factory=ServerConfig)

    @classmethod
    def from_workflow(
        cls,
        workflow: WorkflowDefinition,
        workflow_path: str | Path,
        *,
        env: Mapping[str, str] | None = None,
    ) -> "ServiceConfig":
        environment = env if env is not None else os.environ
        root = workflow.config
        workflow_dir = Path(workflow_path).expanduser().resolve().parent

        tracker_raw = _object(root.get("tracker"))
        kind = str(tracker_raw.get("kind", "")).lower()
        endpoint = _tracker_endpoint(kind, tracker_raw.get("endpoint"))
        api_key = _resolve_secret(tracker_raw.get("api_key"), environment)
        if not api_key and kind == "github":
            api_key = _empty_to_none(environment.get("GITHUB_TOKEN"))
        if not api_key and kind == "linear":
            api_key = _empty_to_none(environment.get("LINEAR_API_KEY"))

        if kind == "github":
            active_states = _string_list(tracker_raw.get("active_states"), default=["open"])
            terminal_states = _string_list(tracker_raw.get("terminal_states"), default=["closed"])
        else:
            active_states = _string_list(tracker_raw.get("active_states"), default=["Todo", "In Progress"])
            terminal_states = _string_list(
                tracker_raw.get("terminal_states"),
                default=["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
            )

        tracker = TrackerConfig(
            kind=kind,
            endpoint=endpoint,
            api_key=api_key,
            owner=_optional_string(tracker_raw.get("owner")),
            repo=_optional_string(tracker_raw.get("repo")),
            project_slug=_optional_string(tracker_raw.get("project_slug")),
            active_states=[state.lower() for state in active_states],
            terminal_states=[state.lower() for state in terminal_states],
        )

        polling_raw = _object(root.get("polling"))
        polling = PollingConfig(interval_ms=_positive_int(polling_raw.get("interval_ms"), 30_000, "polling.interval_ms"))

        workspace_raw = _object(root.get("workspace"))
        workspace_root = _resolve_path(
            workspace_raw.get("root", str(Path(tempfile.gettempdir()) / "symphony_workspaces")),
            workflow_dir,
            environment,
        )
        workspace = WorkspaceConfig(root=workspace_root)

        hooks_raw = _object(root.get("hooks"))
        hooks = HooksConfig(
            after_create=_optional_string(hooks_raw.get("after_create")),
            before_run=_optional_string(hooks_raw.get("before_run")),
            after_run=_optional_string(hooks_raw.get("after_run")),
            before_remove=_optional_string(hooks_raw.get("before_remove")),
            timeout_ms=_positive_int(hooks_raw.get("timeout_ms"), 60_000, "hooks.timeout_ms"),
        )

        agent_raw = _object(root.get("agent"))
        by_state = {}
        for key, value in _object(agent_raw.get("max_concurrent_agents_by_state")).items():
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                continue
            if parsed > 0:
                by_state[str(key).lower()] = parsed
        agent = AgentConfig(
            max_concurrent_agents=_positive_int(agent_raw.get("max_concurrent_agents"), 10, "agent.max_concurrent_agents"),
            max_turns=_positive_int(agent_raw.get("max_turns"), 20, "agent.max_turns"),
            max_retry_backoff_ms=_positive_int(
                agent_raw.get("max_retry_backoff_ms"),
                300_000,
                "agent.max_retry_backoff_ms",
            ),
            max_concurrent_agents_by_state=by_state,
        )

        codex_raw = _object(root.get("codex"))
        codex = CodexConfig(
            command=str(codex_raw.get("command", "codex app-server")).strip(),
            approval_policy=_optional_string(codex_raw.get("approval_policy")),
            thread_sandbox=_optional_string(codex_raw.get("thread_sandbox")),
            turn_sandbox_policy=codex_raw.get("turn_sandbox_policy"),
            turn_timeout_ms=_positive_int(codex_raw.get("turn_timeout_ms"), 3_600_000, "codex.turn_timeout_ms"),
            read_timeout_ms=_positive_int(codex_raw.get("read_timeout_ms"), 5_000, "codex.read_timeout_ms"),
            stall_timeout_ms=_int(codex_raw.get("stall_timeout_ms"), 300_000, "codex.stall_timeout_ms"),
        )

        server_raw = _object(root.get("server"))
        server_port = server_raw.get("port")
        server = ServerConfig(
            port=None if server_port is None else _int(server_port, 0, "server.port"),
            host=str(server_raw.get("host", "127.0.0.1")),
        )

        return cls(tracker=tracker, polling=polling, workspace=workspace, hooks=hooks, agent=agent, codex=codex, server=server)

    def validate_dispatch(self) -> None:
        if not self.tracker.kind:
            raise ConfigError("missing_tracker_kind", "tracker.kind is required")
        if self.tracker.kind != "github":
            raise ConfigError("unsupported_tracker_kind", f"unsupported tracker.kind={self.tracker.kind!r}")
        if not self.tracker.api_key:
            raise ConfigError("missing_tracker_api_key", "tracker.api_key or GITHUB_TOKEN is required")
        if not self.tracker.owner or not self.tracker.repo:
            raise ConfigError("missing_tracker_repository", "tracker.owner and tracker.repo are required for GitHub")
        if not self.codex.command:
            raise ConfigError("missing_codex_command", "codex.command is required")


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _string_list(value: Any, *, default: list[str]) -> list[str]:
    if value is None:
        return list(default)
    if not isinstance(value, list):
        return list(default)
    return [str(item) for item in value if str(item).strip()]


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    parsed = str(value)
    return parsed if parsed else None


def _empty_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _resolve_secret(value: Any, env: Mapping[str, str]) -> str | None:
    if value is None:
        return None
    parsed = str(value)
    if parsed.startswith("$") and len(parsed) > 1:
        return _empty_to_none(env.get(parsed[1:]))
    return _empty_to_none(parsed)


def _resolve_path(value: Any, workflow_dir: Path, env: Mapping[str, str]) -> Path:
    raw = str(value)
    if raw.startswith("$") and len(raw) > 1:
        raw = env.get(raw[1:], "")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = workflow_dir / path
    return path.resolve()


def _tracker_endpoint(kind: str, configured: Any) -> str:
    if configured:
        return str(configured)
    if kind == "linear":
        return "https://api.linear.app/graphql"
    return "https://api.github.com/graphql"


def _positive_int(value: Any, default: int, field_name: str) -> int:
    parsed = _int(value, default, field_name)
    if parsed <= 0:
        raise ConfigError("invalid_config", f"{field_name} must be positive")
    return parsed


def _int(value: Any, default: int, field_name: str) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError("invalid_config", f"{field_name} must be an integer") from exc

