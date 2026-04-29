#!/usr/bin/env bash
set -euo pipefail

echo "running: uv run pytest -q ${*:-}"
uv run pytest -q "$@"
