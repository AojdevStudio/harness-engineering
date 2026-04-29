#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
REQUIRED_FRONTMATTER = {"title", "type", "updated"}
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def parse_frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}
    fields: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip()
    return fields


def main() -> int:
    failures: list[str] = []
    for path in sorted(DOCS.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        fields = parse_frontmatter(text)
        missing = REQUIRED_FRONTMATTER - set(fields)
        if missing:
            failures.append(
                f"{path}: missing frontmatter {sorted(missing)}. "
                "Knowledge docs need title/type/updated so agents can judge freshness. See docs/golden-principles.md."
            )
        for match in WIKILINK_RE.finditer(text):
            target = match.group(1).split("#", 1)[0]
            target_path = DOCS / f"{target}.md"
            if not target_path.exists():
                failures.append(
                    f"{path}: broken wikilink [[{match.group(1)}]]. Fix the link or add the target doc so agent context does not dead-end."
                )
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("knowledge lint ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
