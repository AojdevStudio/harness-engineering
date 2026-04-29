#!/usr/bin/env bash
set -euo pipefail

workflow_path="${1:-WORKFLOW.example.md}"

echo "validating workflow: ${workflow_path}"
uv run python - "$workflow_path" <<'PY'
from pathlib import Path
import sys

from harness_engineering.config import ServiceConfig
from harness_engineering.workflow import load_workflow

workflow_path = Path(sys.argv[1])
workflow = load_workflow(workflow_path)
config = ServiceConfig.from_workflow(workflow, workflow_path, env={"GITHUB_TOKEN": "validation-token"})
config.validate_dispatch()
print(f"workflow ok: {workflow_path}")
PY
