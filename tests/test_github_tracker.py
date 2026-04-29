from __future__ import annotations

from pathlib import Path

from harness_engineering.config import ServiceConfig
from harness_engineering.github_tracker import GitHubTracker
from harness_engineering.workflow import load_workflow


class FakeTransport:
    def __init__(self, *responses: dict) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []

    def execute(self, query: str, variables: dict, *, endpoint: str, api_key: str) -> dict:
        self.calls.append((query, variables))
        return self.responses.pop(0)


def config_from_text(tmp_path: Path, text: str) -> ServiceConfig:
    path = tmp_path / "WORKFLOW.md"
    path.write_text(text, encoding="utf-8")
    return ServiceConfig.from_workflow(load_workflow(path), path, env={"GITHUB_TOKEN": "token"})


def issue_node(number: int, *, label: str, cursor: str = "cursor") -> dict:
    return {
        "id": f"id-{number}",
        "number": number,
        "title": f"Issue {number}",
        "body": "body",
        "state": "OPEN",
        "url": f"https://github.com/acme/repo/issues/{number}",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-02T00:00:00Z",
        "labels": {"nodes": [{"name": label}, {"name": "Priority:2"}]},
    }


def test_candidate_query_uses_repository_owner_repo_and_open_state(tmp_path: Path) -> None:
    config = config_from_text(
        tmp_path,
        """---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: $GITHUB_TOKEN
---
Prompt
""",
    )
    transport = FakeTransport(
        {
            "data": {
                "repository": {
                    "issues": {
                        "nodes": [],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        }
    )
    tracker = GitHubTracker(config.tracker, transport=transport)

    assert tracker.fetch_candidate_issues() == []
    query, variables = transport.calls[0]
    assert "repository(owner: $owner, name: $repo)" in query
    assert variables["owner"] == "acme"
    assert variables["repo"] == "repo"
    assert variables["states"] == ["OPEN"]


def test_fetch_issues_by_empty_states_returns_empty_without_api_call(tmp_path: Path) -> None:
    config = config_from_text(
        tmp_path,
        """---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: $GITHUB_TOKEN
---
Prompt
""",
    )
    transport = FakeTransport()
    tracker = GitHubTracker(config.tracker, transport=transport)

    assert tracker.fetch_issues_by_states([]) == []
    assert transport.calls == []


def test_paginates_candidates_and_normalizes_labels_priority_and_dates(tmp_path: Path) -> None:
    config = config_from_text(
        tmp_path,
        """---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: $GITHUB_TOKEN
---
Prompt
""",
    )
    transport = FakeTransport(
        {
            "data": {
                "repository": {
                    "issues": {
                        "nodes": [issue_node(1, label="Backend")],
                        "pageInfo": {"hasNextPage": True, "endCursor": "c1"},
                    }
                }
            }
        },
        {
            "data": {
                "repository": {
                    "issues": {
                        "nodes": [issue_node(2, label="Frontend")],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        },
        {
            "data": {
                "repository": {
                    "pullRequests": {
                        "nodes": [],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        },
    )
    tracker = GitHubTracker(config.tracker, transport=transport)

    issues = tracker.fetch_candidate_issues()

    assert [issue.identifier for issue in issues] == ["repo#1", "repo#2"]
    assert issues[0].labels == ["backend", "priority:2"]
    assert issues[0].priority == 2
    assert issues[0].state == "open"
    assert issues[0].created_at is not None
    assert transport.calls[1][1]["after"] == "c1"


def test_candidate_fetch_excludes_open_issue_with_open_pr_handoff(tmp_path: Path) -> None:
    config = config_from_text(
        tmp_path,
        """---
tracker:
  kind: github
  owner: acme
  repo: repo
  api_key: $GITHUB_TOKEN
---
Prompt
""",
    )
    transport = FakeTransport(
        {
            "data": {
                "repository": {
                    "issues": {
                        "nodes": [issue_node(7, label="Backend")],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        },
        {
            "data": {
                "repository": {
                    "pullRequests": {
                        "nodes": [
                            {
                                "number": 16,
                                "title": "Spike the Codex app-server boundary",
                                "body": "Issue #7 is ready for review.",
                                "headRefName": "issue-7-codex-app-server",
                                "closingIssuesReferences": {"nodes": []},
                            }
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        },
    )
    tracker = GitHubTracker(config.tracker, transport=transport)

    assert tracker.fetch_candidate_issues() == []
