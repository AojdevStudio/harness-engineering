from __future__ import annotations

from harness_engineering.workflow_templates import get_workflow_template, list_workflow_templates


def test_workflow_templates_declare_execution_primitives() -> None:
    templates = {template.name: template for template in list_workflow_templates()}

    assert templates["simple_attempt"].primitive_names == ("prepare_workspace", "run_implement_attempt")
    assert templates["implement_then_pr"].primitive_names == (
        "prepare_workspace",
        "run_implement_attempt",
        "detect_commits",
        "summarize_diff",
        "create_pr_handoff",
        "record_handoff",
    )
    assert templates["implement_review_then_pr"].handoff_state == "pr_opened"
    assert templates["implement_review_merge"].trusted_auto_merge is True


def test_unknown_workflow_template_returns_none() -> None:
    assert get_workflow_template("missing") is None
