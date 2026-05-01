from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class SessionJournal:
    def __init__(self, workspace_path: Path | str) -> None:
        self.workspace_path = Path(workspace_path)
        self.path = self.workspace_path / ".symphony" / "session.jsonl"

    def build_event(
        self,
        event: str,
        *,
        issue_id: str,
        issue_identifier: str,
        timestamp: datetime | None = None,
        message: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        current = timestamp or datetime.now(UTC)
        return {
            "event": event,
            "issue_id": issue_id,
            "issue_identifier": issue_identifier,
            "workspace_path": str(self.workspace_path),
            "timestamp": _iso(current),
            "message": message,
            "payload": payload or {},
        }

    def append(
        self,
        event: str,
        *,
        issue_id: str,
        issue_identifier: str,
        timestamp: datetime | None = None,
        message: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        entry = self.build_event(
            event,
            issue_id=issue_id,
            issue_identifier=issue_identifier,
            timestamp=timestamp,
            message=message,
            payload=payload,
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True))
            handle.write("\n")
        return entry

    def read_recent(self, *, limit: int | None = None) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        events: list[dict[str, Any]] = []
        with self.path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    decoded = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(decoded, dict):
                    events.append(decoded)
        if limit is None:
            return events
        return events[-limit:]


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
