#!/usr/bin/env bash
set -euo pipefail

echo "running: mix format --check-formatted"
mix format --check-formatted

echo "running: mix test"
mix test
