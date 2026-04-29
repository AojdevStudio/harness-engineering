from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class BlockerRef:
    id: str | None = None
    identifier: str | None = None
    state: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "identifier": self.identifier, "state": self.state}


@dataclass(slots=True)
class Issue:
    id: str
    identifier: str
    title: str
    state: str
    description: str | None = None
    priority: int | None = None
    branch_name: str | None = None
    url: str | None = None
    labels: list[str] = field(default_factory=list)
    blocked_by: list[BlockerRef] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "identifier": self.identifier,
            "title": self.title,
            "description": self.description,
            "priority": self.priority,
            "state": self.state,
            "branch_name": self.branch_name,
            "url": self.url,
            "labels": list(self.labels),
            "blocked_by": [blocker.to_dict() for blocker in self.blocked_by],
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
