#!/usr/bin/env bash
set -euo pipefail

echo "running: uv run ruff check ."
uv run ruff check .

echo "running: uv run ruff format --check ."
uv run ruff format --check .

echo "running: uv run python scripts/lint-architecture.py"
uv run python scripts/lint-architecture.py

echo "running: uv run python scripts/lint-knowledge.py"
uv run python scripts/lint-knowledge.py

echo "running: uv run python scripts/lint-github-workflows.py"
uv run python scripts/lint-github-workflows.py

echo "running: uv run python scripts/pr-review.py --base origin/main"
uv run python scripts/pr-review.py --base origin/main
