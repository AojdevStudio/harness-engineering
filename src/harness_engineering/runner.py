from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from harness_engineering.agent import AgentEvent, CodexAppServerClient
from harness_engineering.config import ServiceConfig
from harness_engineering.models import Issue
from harness_engineering.prompt import render_prompt
from harness_engineering.workflow import WorkflowDefinition
from harness_engineering.workspace import WorkspaceManager


@dataclass(slots=True)
class AgentRunner:
    config: ServiceConfig
    workflow: WorkflowDefinition
    workspace_manager: WorkspaceManager

    def run_attempt(self, issue: Issue, *, attempt: int | None, on_event: Callable[[AgentEvent], None]) -> None:
        workspace = self.workspace_manager.create_for_issue(issue.identifier)
        self.workspace_manager.run_hook("before_run", workspace.path, fatal=True)
        client = CodexAppServerClient(self.config.codex, self.workspace_manager)
        try:
            prompt = render_prompt(self.workflow.prompt_template, issue, attempt)
            client.run_turn(workspace_path=workspace.path, issue=issue, prompt=prompt, on_event=on_event)
        finally:
            self.workspace_manager.run_hook("after_run", workspace.path, fatal=False)

