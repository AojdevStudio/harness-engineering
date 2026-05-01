#!/usr/bin/env python3
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "harness_engineering"

LAYER_ORDER = {
    "models": 0,
    "workflow": 1,
    "config": 2,
    "prompt": 2,
    "session_journal": 3,
    "workspace": 3,
    "github_tracker": 3,
    "execution_strategy": 4,
    "execution_primitives": 4,
    "workflow_templates": 4,
    "orchestrator": 4,
    "http_server": 4,
    "agent": 5,
    "runner": 6,
    "service": 7,
    "cli": 8,
    "__main__": 8,
    "__init__": 8,
}

ERROR = (
    "Architecture rule violated: lower-level modules must not import higher-level runtime modules. "
    "Move shared contracts downward or inject the higher-level dependency from service/runner. "
    "See rules/architecture.md."
)


def module_name(path: Path) -> str:
    return path.relative_to(SRC).with_suffix("").as_posix().replace("/", ".")


def imported_harness_modules(tree: ast.AST) -> list[str]:
    imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("harness_engineering."):
                    imports.append(alias.name.removeprefix("harness_engineering.").split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("harness_engineering."):
            imports.append(node.module.removeprefix("harness_engineering.").split(".")[0])
    return imports


def main() -> int:
    failures: list[str] = []
    for path in sorted(SRC.glob("*.py")):
        current = module_name(path)
        current_layer = LAYER_ORDER.get(current)
        if current_layer is None:
            failures.append(f"{path}: unknown module layer for {current!r}. Add it to scripts/lint-architecture.py.")
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for imported in imported_harness_modules(tree):
            imported_layer = LAYER_ORDER.get(imported)
            if imported_layer is None:
                failures.append(f"{path}: unknown imported layer {imported!r}. Add it to scripts/lint-architecture.py.")
            elif imported_layer > current_layer:
                failures.append(f"{path}: imports harness_engineering.{imported}. {ERROR}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("architecture lint ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
