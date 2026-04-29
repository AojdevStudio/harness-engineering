#!/usr/bin/env bash
set -euo pipefail

echo "running: HARNESS_CODEX_APP_SERVER_SMOKE=1 mix test --include codex_smoke --only codex_smoke"
HARNESS_CODEX_APP_SERVER_SMOKE=1 mix test --include codex_smoke --only codex_smoke

