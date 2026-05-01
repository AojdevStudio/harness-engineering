from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class WorkflowTemplate:
    name: str
    description: str
    primitive_names: tuple[str, ...]
    handoff_state: str | None = None
    trusted_auto_merge: bool = False


TEMPLATES: tuple[WorkflowTemplate, ...] = (
    WorkflowTemplate(
        name="simple_attempt",
        description="Run the existing single implement attempt behavior.",
        primitive_names=("prepare_workspace", "run_implement_attempt"),
    ),
    WorkflowTemplate(
        name="implement_then_pr",
        description="Implement work, summarize commits, open a pull request, and enter PR handoff.",
        primitive_names=(
            "prepare_workspace",
            "run_implement_attempt",
            "detect_commits",
            "summarize_diff",
            "create_pr_handoff",
            "record_handoff",
        ),
        handoff_state="pr_opened",
    ),
    WorkflowTemplate(
        name="implement_review_then_pr",
        description="Implement work, review the branch, summarize commits, open a pull request, and enter PR handoff.",
        primitive_names=(
            "prepare_workspace",
            "run_implement_attempt",
            "detect_commits",
            "run_review_attempt",
            "summarize_diff",
            "create_pr_handoff",
            "record_handoff",
        ),
        handoff_state="pr_opened",
    ),
    WorkflowTemplate(
        name="implement_review_merge",
        description="Trusted mode: implement, review, merge, and record completion as workflow policy.",
        primitive_names=(
            "prepare_workspace",
            "run_implement_attempt",
            "detect_commits",
            "run_review_attempt",
            "summarize_diff",
            "merge_branch",
            "record_handoff",
        ),
        handoff_state="merged",
        trusted_auto_merge=True,
    ),
)


def list_workflow_templates() -> tuple[WorkflowTemplate, ...]:
    return TEMPLATES


def get_workflow_template(name: str) -> WorkflowTemplate | None:
    return next((template for template in TEMPLATES if template.name == name), None)
