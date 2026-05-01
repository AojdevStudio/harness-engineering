from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from harness_engineering.session_journal import SessionJournal


def test_worker_session_journal_appends_events_under_workspace() -> None:
    workspace = Path("/tmp/repo_1")
    journal = SessionJournal(workspace)

    event = journal.build_event(
        "attempt_started",
        issue_id="id-1",
        issue_identifier="repo#1",
        timestamp=datetime(2026, 1, 1, tzinfo=UTC),
        message="first run",
        payload={"attempt": {"number": 1, "reason": "first_run"}},
    )

    assert event["event"] == "attempt_started"
    assert event["workspace_path"] == "/tmp/repo_1"
    assert event["payload"]["attempt"]["reason"] == "first_run"


def test_worker_session_journal_writes_and_reads_jsonl(tmp_path: Path) -> None:
    workspace = tmp_path / "repo_1"
    journal = SessionJournal(workspace)

    journal.append(
        "session_started",
        issue_id="id-1",
        issue_identifier="repo#1",
        timestamp=datetime(2026, 1, 1, tzinfo=UTC),
        message="started",
        payload={"session_status": "running"},
    )

    assert journal.path == workspace / ".symphony" / "session.jsonl"
    events = journal.read_recent()
    assert events == [
        {
            "event": "session_started",
            "issue_id": "id-1",
            "issue_identifier": "repo#1",
            "workspace_path": str(workspace),
            "timestamp": "2026-01-01T00:00:00Z",
            "message": "started",
            "payload": {"session_status": "running"},
        }
    ]


def test_worker_session_journal_reader_ignores_malformed_lines(tmp_path: Path) -> None:
    workspace = tmp_path / "repo_1"
    journal = SessionJournal(workspace)
    journal.path.parent.mkdir(parents=True)
    journal.path.write_text(
        "\n".join(
            [
                "{not json",
                json.dumps(
                    {
                        "event": "attempt_finished",
                        "issue_id": "id-1",
                        "issue_identifier": "repo#1",
                        "workspace_path": str(workspace),
                        "timestamp": "2026-01-01T00:00:00Z",
                        "message": None,
                        "payload": {"status": "failed"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    assert journal.read_recent() == [
        {
            "event": "attempt_finished",
            "issue_id": "id-1",
            "issue_identifier": "repo#1",
            "workspace_path": str(workspace),
            "timestamp": "2026-01-01T00:00:00Z",
            "message": None,
            "payload": {"status": "failed"},
        }
    ]
