# Harness Engineering

GitHub-control-plane implementation of the Symphony orchestration service for Codex workers.

This repository intentionally implements the Symphony scheduling/workspace model with GitHub as the tracker source of truth. Linear can sync upstream into GitHub as a team workflow detail, but the harness contract reads GitHub Issues and keeps Linear-specific behavior out of orchestration code.

## What Is Implemented

- `WORKFLOW.md` loader with YAML front matter and strict prompt body handling.
- Typed config resolution with defaults, `$VAR` secret indirection, path normalization, and dispatch validation.
- Dynamic workflow reload that keeps the last known good workflow after invalid edits.
- Elixir OTP tracer bullet that boots under supervision, loads and validates workflow config, and exits without dispatching workers.
- GitHub GraphQL tracker adapter for candidate fetch, terminal fetch, and issue-state refresh.
- Per-issue workspace manager with sanitized keys, root containment checks, and lifecycle hooks.
- Strict Liquid-like prompt rendering for variables and simple loops.
- Orchestrator state helpers for dispatch eligibility, concurrency, retry backoff, token totals, and snapshots.
- Codex app-server subprocess boundary using JSON-RPC over stdio.
- Optional loopback HTTP status surface at `/`, `/api/v1/state`, and `/api/v1/refresh`.

## Not Yet Implemented

- Linear tracker adapter. This is deliberate for this repo's first build.
- Durable retry/session persistence across process restarts.
- SSH worker extension.
- `linear_graphql` client-side tool extension.
- A rich dashboard beyond the baseline JSON-backed HTML surface.

## Quickstart

```bash
uv sync
cp WORKFLOW.example.md WORKFLOW.md
export GITHUB_TOKEN=...
uv run symphony-harness WORKFLOW.md --once
```

Run as a daemon:

```bash
uv run symphony-harness WORKFLOW.md --port 0
```

The HTTP status API is then available at:

```text
http://127.0.0.1:<printed-port>/api/v1/state
```

## Workflow Contract

`WORKFLOW.md` travels with the target repo and defines both runtime settings and the per-issue agent prompt. A minimal GitHub workflow looks like this:

```yaml
---
tracker:
  kind: github
  owner: AojdevStudio
  repo: harness-engineering
  api_key: $GITHUB_TOKEN
workspace:
  root: .symphony/workspaces
---
You are working on GitHub issue {{ issue.identifier }}.
Title: {{ issue.title }}
```

Unknown top-level front matter keys are ignored. Environment variables only resolve when a config value explicitly uses `$VAR_NAME`; they do not globally override workflow values.

## Verification

```bash
./scripts/test.sh
./scripts/test-elixir.sh
./scripts/lint.sh
./scripts/typecheck.sh
./scripts/validate-workflow.sh WORKFLOW.example.md
```

The Elixir tracer bullet requires Elixir/Mix. It uses the Python implementation as the workflow oracle in ExUnit tests:

```bash
GITHUB_TOKEN=... mix run -e 'System.halt(HarnessEngineering.CLI.main(["WORKFLOW.example.md", "--once"]))'
```
