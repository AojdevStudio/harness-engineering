from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from harness_engineering.config import ConfigError, ServiceConfig
from harness_engineering.orchestrator import OrchestratorState
from harness_engineering.service import SymphonyService
from harness_engineering.workflow import (
    WorkflowLoadError,
    WorkflowReloader,
    load_workflow,
    select_workflow_path,
)


def test_loads_yaml_front_matter_and_trimmed_prompt(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(
        """---
tracker:
  kind: github
  owner: AojdevStudio
  repo: harness-engineering
---

Hello {{ issue.identifier }}
""",
        encoding="utf-8",
    )

    workflow = load_workflow(workflow_path)

    assert workflow.config["tracker"]["kind"] == "github"
    assert workflow.prompt_template == "Hello {{ issue.identifier }}"


def test_absent_front_matter_uses_empty_config(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text("Run the issue.\n", encoding="utf-8")

    workflow = load_workflow(workflow_path)

    assert workflow.config == {}
    assert workflow.prompt_template == "Run the issue."


def test_front_matter_must_be_a_map(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text("---\n- not\n- a\n- map\n---\nPrompt\n", encoding="utf-8")

    with pytest.raises(WorkflowLoadError) as exc:
        load_workflow(workflow_path)

    assert exc.value.code == "workflow_front_matter_not_a_map"


def test_select_workflow_path_prefers_explicit_path(tmp_path: Path) -> None:
    explicit = tmp_path / "custom.md"
    explicit.write_text("Prompt", encoding="utf-8")

    assert select_workflow_path(str(explicit), cwd=tmp_path) == explicit.resolve()
    assert select_workflow_path(None, cwd=tmp_path) == (tmp_path / "WORKFLOW.md").resolve()


def test_service_config_defaults_env_resolution_and_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_secret")
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(
        """---
tracker:
  kind: github
  owner: AojdevStudio
  repo: harness-engineering
  api_key: $GITHUB_TOKEN
workspace:
  root: .symphony
agent:
  max_concurrent_agents_by_state:
    OPEN: 2
    closed: 0
---
Prompt
""",
        encoding="utf-8",
    )

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path, env=os.environ)

    assert config.tracker.kind == "github"
    assert config.tracker.api_key == "ghp_secret"
    assert config.tracker.active_states == ["open"]
    assert config.tracker.terminal_states == ["closed"]
    assert config.workspace.root == (tmp_path / ".symphony").resolve()
    assert config.polling.interval_ms == 30_000
    assert config.agent.max_concurrent_agents == 10
    assert config.agent.max_concurrent_agents_by_state == {"open": 2}
    assert config.codex.driver == "app-server"
    assert config.codex.command == "codex app-server"


def test_dispatch_validation_requires_supported_tracker_auth_and_repo(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(
        """---
tracker:
  kind: github
  owner: AojdevStudio
  repo: harness-engineering
  api_key: $MISSING_TOKEN
---
Prompt
""",
        encoding="utf-8",
    )
    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path, env={})

    with pytest.raises(ConfigError) as exc:
        config.validate_dispatch()

    assert exc.value.code == "missing_tracker_api_key"


def test_stub_codex_driver_validates_without_real_command(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(
        """---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: literal-token
codex:
  driver: stub
  command: ""
  stub_exit: success
---
Prompt
""",
        encoding="utf-8",
    )
    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    config.validate_dispatch()

    assert config.codex.driver == "stub"


def test_reloader_keeps_last_good_config_after_invalid_reload(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text("---\npolling:\n  interval_ms: 1000\n---\nOne\n", encoding="utf-8")
    reloader = WorkflowReloader(workflow_path)

    first = reloader.load_initial()
    assert first.prompt_template == "One"

    time.sleep(0.01)
    workflow_path.write_text("---\n: bad yaml\n---\nTwo\n", encoding="utf-8")

    assert reloader.reload_if_changed(force=True) is False
    assert reloader.current is first
    assert reloader.last_error is not None
    assert reloader.last_error.code == "workflow_parse_error"


def test_service_reload_keeps_last_good_effective_config_after_invalid_config(tmp_path: Path) -> None:
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(
        """---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: literal-token
polling:
  interval_ms: 1000
---
One
""",
        encoding="utf-8",
    )
    service = SymphonyService(workflow_path)
    workflow = service.reloader.load_initial()
    config = ServiceConfig.from_workflow(workflow, workflow_path)
    service.workflow = workflow
    service.config = config
    service.state = OrchestratorState(max_concurrent_agents=1, active_states={"open"}, terminal_states={"closed"})

    time.sleep(0.01)
    workflow_path.write_text(
        """---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: literal-token
polling:
  interval_ms: 0
---
Two
""",
        encoding="utf-8",
    )

    service._reload_if_needed()

    assert service.workflow is workflow
    assert service.config is config
