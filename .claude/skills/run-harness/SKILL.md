---
name: run-harness
description: Start harness-engineering safely for a one-tick smoke run or local status-server session.
allowed-tools: Bash, Read
---

# Run Harness

Use this skill when an agent needs to smoke-test the service locally.

## One-Tick Smoke Run

```bash
GITHUB_TOKEN="${GITHUB_TOKEN:?set GITHUB_TOKEN}" uv run symphony-harness WORKFLOW.example.md --once
```

## Status Server

Use an ephemeral port in worktrees:

```bash
GITHUB_TOKEN="${GITHUB_TOKEN:?set GITHUB_TOKEN}" uv run symphony-harness WORKFLOW.example.md --port 0
```

Do not run a fixed port in multiple worktrees at the same time.
