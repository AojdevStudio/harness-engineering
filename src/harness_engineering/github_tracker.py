from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from harness_engineering.config import TrackerConfig
from harness_engineering.models import Issue


class TrackerError(RuntimeError):
    def __init__(self, code: str, message: str, *, payload: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.payload = payload


class GraphQLTransport(Protocol):
    def execute(self, query: str, variables: dict[str, Any], *, endpoint: str, api_key: str) -> dict[str, Any]: ...


@dataclass(slots=True)
class UrllibGraphQLTransport:
    timeout_seconds: float = 30.0

    def execute(self, query: str, variables: dict[str, Any], *, endpoint: str, api_key: str) -> dict[str, Any]:
        body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "harness-engineering/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                response_body = response.read()
        except urllib.error.HTTPError as exc:
            raise TrackerError("github_api_status", f"GitHub API returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise TrackerError("github_api_request", f"GitHub API request failed: {exc.reason}") from exc
        try:
            decoded = json.loads(response_body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise TrackerError("github_unknown_payload", "GitHub API returned invalid JSON") from exc
        if decoded.get("errors"):
            raise TrackerError("github_graphql_errors", "GitHub GraphQL response contained errors", payload=decoded)
        return decoded


class GitHubTracker:
    def __init__(self, config: TrackerConfig, *, transport: GraphQLTransport | None = None, page_size: int = 50) -> None:
        self.config = config
        self.transport = transport or UrllibGraphQLTransport()
        self.page_size = page_size

    def fetch_candidate_issues(self) -> list[Issue]:
        return self._fetch_by_states(self.config.active_states)

    def fetch_issues_by_states(self, state_names: list[str]) -> list[Issue]:
        if not state_names:
            return []
        return self._fetch_by_states([state.lower() for state in state_names])

    def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        if not issue_ids:
            return []
        payload = self._execute(
            _ISSUES_BY_ID_QUERY,
            {"ids": issue_ids},
        )
        nodes = payload.get("data", {}).get("nodes")
        if not isinstance(nodes, list):
            raise TrackerError("github_unknown_payload", "missing nodes in issue state response", payload=payload)
        return [self._normalize_issue_node(node) for node in nodes if isinstance(node, dict) and node.get("__typename") in {None, "Issue"}]

    def _fetch_by_states(self, states: list[str]) -> list[Issue]:
        issues: list[Issue] = []
        after: str | None = None
        graphql_states = [_github_state(state) for state in states]
        while True:
            payload = self._execute(
                _CANDIDATE_QUERY,
                {
                    "owner": self.config.owner,
                    "repo": self.config.repo,
                    "states": graphql_states,
                    "first": self.page_size,
                    "after": after,
                },
            )
            issue_connection = payload.get("data", {}).get("repository", {}).get("issues")
            if not isinstance(issue_connection, dict):
                raise TrackerError("github_unknown_payload", "missing repository.issues in GitHub response", payload=payload)
            nodes = issue_connection.get("nodes")
            if not isinstance(nodes, list):
                raise TrackerError("github_unknown_payload", "missing issue nodes in GitHub response", payload=payload)
            issues.extend(self._normalize_issue_node(node) for node in nodes if isinstance(node, dict))
            page_info = issue_connection.get("pageInfo")
            if not isinstance(page_info, dict):
                raise TrackerError("github_unknown_payload", "missing pageInfo in GitHub response", payload=payload)
            if not page_info.get("hasNextPage"):
                return issues
            after = page_info.get("endCursor")
            if not after:
                raise TrackerError("github_missing_end_cursor", "GitHub pagination reported next page without endCursor")

    def _execute(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        if not self.config.api_key:
            raise TrackerError("missing_tracker_api_key", "GitHub API key is required")
        payload = self.transport.execute(query, variables, endpoint=self.config.endpoint, api_key=self.config.api_key)
        if payload.get("errors"):
            raise TrackerError("github_graphql_errors", "GitHub GraphQL response contained errors", payload=payload)
        return payload

    def _normalize_issue_node(self, node: dict[str, Any]) -> Issue:
        number = node.get("number")
        labels = [
            str(label.get("name")).lower()
            for label in node.get("labels", {}).get("nodes", [])
            if isinstance(label, dict) and label.get("name")
        ]
        return Issue(
            id=str(node.get("id") or ""),
            identifier=f"{self.config.repo}#{number}",
            title=str(node.get("title") or ""),
            description=node.get("body") or None,
            priority=_priority_from_labels(labels),
            state=str(node.get("state") or "").lower(),
            branch_name=None,
            url=node.get("url") or None,
            labels=labels,
            blocked_by=[],
            created_at=_parse_datetime(node.get("createdAt")),
            updated_at=_parse_datetime(node.get("updatedAt")),
        )


def _github_state(state: str) -> str:
    normalized = state.lower()
    if normalized in {"open", "todo", "in progress", "in_progress"}:
        return "OPEN"
    if normalized in {"closed", "done", "cancelled", "canceled", "duplicate"}:
        return "CLOSED"
    return state.upper()


def _priority_from_labels(labels: list[str]) -> int | None:
    for label in labels:
        match = re.search(r"(?:^priority[:\s-]*|^p)(\d+)$", label)
        if match:
            return int(match.group(1))
    return None


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


_CANDIDATE_QUERY = """
query HarnessCandidateIssues($owner: String!, $repo: String!, $states: [IssueState!], $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: $first, after: $after, states: $states, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        id
        number
        title
        body
        state
        url
        createdAt
        updatedAt
        labels(first: 50) {
          nodes { name }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
""".strip()


_ISSUES_BY_ID_QUERY = """
query HarnessIssuesById($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      number
      title
      body
      state
      url
      createdAt
      updatedAt
      labels(first: 50) {
        nodes { name }
      }
    }
  }
}
""".strip()
