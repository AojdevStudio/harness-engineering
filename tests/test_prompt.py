from __future__ import annotations

from datetime import UTC, datetime

import pytest

from harness_engineering.models import Issue
from harness_engineering.prompt import PromptRenderError, render_prompt


def test_renders_issue_and_attempt_with_strict_liquid_semantics() -> None:
    issue = Issue(
        id="issue-1",
        identifier="HE-1",
        title="Build service",
        state="open",
        labels=["backend", "codex"],
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )

    prompt = render_prompt(
        "Work on {{ issue.identifier }}: {{ issue.title }} attempt={{ attempt }} "
        "{% for label in issue.labels %}[{{ label }}]{% endfor %}",
        issue,
        attempt=2,
    )

    assert "HE-1: Build service attempt=2" in prompt
    assert "[backend][codex]" in prompt


def test_unknown_prompt_variable_fails_rendering() -> None:
    issue = Issue(id="issue-1", identifier="HE-1", title="Build service", state="open")

    with pytest.raises(PromptRenderError) as exc:
        render_prompt("{{ issue.identifier }} {{ missing.value }}", issue, attempt=None)

    assert exc.value.code == "template_render_error"
