# Symphony

Symphony is a self-hosted TypeScript/Bun control plane for unattended ticket-level coding agents. It watches Linear, prepares isolated Git workspaces, runs Codex or Pi, validates the result, stores evidence, opens PR handoffs, and reconciles review feedback.

Status: early dogfood harness. It is intended for one trusted team, local SQLite state, and token-protected local control plane APIs.

## Quick Start

Install dependencies and run the verification spine:

```bash
bun install
bun run verify
```

Create local first-run files:

```bash
bun run symphony init
```

This creates:

```text
WORKFLOW.md
.env
.symphony/
  workspaces/
  evidence/
```

Edit `.env` and `WORKFLOW.md`, then diagnose the setup:

```bash
bun run symphony doctor WORKFLOW.md
```

When credentials are configured, run the live Linear preflight:

```bash
bun run symphony doctor WORKFLOW.md --live-tracker
bun run symphony validate WORKFLOW.md --live-tracker
```

Run one controlled dispatch or PR-reconciliation tick:

```bash
bun run symphony tick WORKFLOW.md
```

Start the local API/dashboard:

```bash
export SYMPHONY_AUTH_TOKEN="$(openssl rand -hex 24)"
bun run symphony serve WORKFLOW.md
```

Open:

```text
http://localhost:7331
```

## Required Tools

- Bun
- Git
- GitHub CLI (`gh`) authenticated for PR creation and merge checks
- Linear API key for real dispatch
- Codex CLI or Pi CLI, depending on `SYMPHONY_RUNNER`

Optional for UI tickets:

- Playwright browsers in the target repo evidence script

## Configuration

`symphony init` writes a starter `.env` beside `WORKFLOW.md`. The CLI also reads that workflow-local `.env` for `doctor`, `validate`, `tick`, and `serve`; exported environment variables still take precedence. The committed [.env.example](.env.example) documents the same variables.

Important values:

| Variable | Purpose |
| --- | --- |
| `LINEAR_API_KEY` | Linear GraphQL API key. |
| `SYMPHONY_AUTH_TOKEN` | Bearer token for `/api/*` routes. |
| `SYMPHONY_ALLOW_INSECURE` | Explicit local opt-in to unauthenticated APIs. |
| `SYMPHONY_DB_PATH` | SQLite database path. |
| `SYMPHONY_EVIDENCE_DIR` | Evidence artifact root. |
| `SYMPHONY_RUNNER` | `codex` or `pi`. |
| `SYMPHONY_CODEX_COMMAND` | Shell command for Codex runner. |
| `SYMPHONY_PI_COMMAND` | Shell command for Pi runner. |
| `SYMPHONY_WORKSPACE_MODE` | `worktree` or `clone`. |
| `SYMPHONY_SOURCE_REPO` | Source repo path for worktree mode. Defaults to the workflow directory. |
| `SYMPHONY_REPO_URL` | Repo URL for clone mode. |
| `SYMPHONY_BASE_REF` | Base ref for workspaces, PR target, and handoff diffs. |

`WORKFLOW.md` owns tracker, polling, workspace root, hooks, state names, runner prompt, server host/port, and UI evidence requirements. Start from [WORKFLOW.example.md](WORKFLOW.example.md) or generate a local copy with `symphony init`.

Use `review.self.command` when the target repo has a deterministic PR review command. Symphony runs it after PR creation, records the output as evidence, and keeps blocking `P0`/`P1`/`P2` findings in `Rework` instead of moving the issue to human review.

The generated workflow leaves UI evidence commented out. Enable that block only after the target repo has a matching evidence script.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run symphony init [DIR]` | Create `WORKFLOW.md`, `.env`, and local state directories. |
| `bun run symphony doctor [WORKFLOW.md]` | Check Bun, `gh`, GitHub auth, workflow config, runner command, workspace inputs, base ref, server auth, and evidence command readiness. |
| `bun run symphony doctor [WORKFLOW.md] --live-tracker` | Also call Linear and verify the project slug plus configured state names. |
| `bun run symphony validate [WORKFLOW.md]` | Print resolved workflow config and dispatch readiness as JSON. |
| `bun run symphony validate [WORKFLOW.md] --live-tracker` | Validate config plus live Linear project/state names. |
| `bun run symphony tick [WORKFLOW.md]` | Run one poll, dispatch, or PR review reconciliation pass. |
| `bun run symphony serve [WORKFLOW.md]` | Start the local control plane API/dashboard. |
| `bun run smoke:ui-evidence` | Run the disposable UI evidence smoke. |
| `bun run verify` | Typecheck and run the full test suite. |

## What The Orchestrator Owns

- Candidate issue polling and dedupe
- SQLite claim/run/attempt/session/event state
- Workspace creation through worktree or clone
- Runner invocation for Codex or Pi
- Required validation hooks
- Required UI evidence capture and artifact registration
- Branch push and PR handoff
- Configured PR self-review before human review handoff
- Linear state and workpad writes
- PR inspection, blocking review feedback, rework prompts, merge, and done transitions

The agent owns the implementation patch inside the isolated workspace. Symphony owns the lifecycle around that patch.

## Dogfood Path

Use [docs/symphony-dogfood-runbook.md](docs/symphony-dogfood-runbook.md) for the full procedure. The short version is:

1. Pick a target repo with deterministic install/test commands and GitHub push access.
2. Create one narrow Linear ticket with exact acceptance criteria.
3. Run `symphony doctor WORKFLOW.md --live-tracker`.
4. Run one `symphony tick WORKFLOW.md`.
5. Inspect `/api/v1/runs`, `/api/v1/events`, the PR, and evidence artifacts before polling again.

## Troubleshooting

Run the doctor first:

```bash
bun run symphony doctor WORKFLOW.md
```

Common failures:

| Failure | Fix |
| --- | --- |
| Missing `LINEAR_API_KEY` | Fill `.env` or export the variable before running Symphony. |
| `tracker.project_slug` missing | Set the Linear project slug in `WORKFLOW.md`. |
| GitHub auth failed | Run `gh auth login`. |
| Codex or Pi command missing | Install the selected CLI or change `SYMPHONY_CODEX_COMMAND` / `SYMPHONY_PI_COMMAND`. |
| Worktree source is not a Git repo | Set `SYMPHONY_SOURCE_REPO` to the target repo path or run from that repo. |
| Base ref not found | Set `SYMPHONY_BASE_REF` to an existing branch/ref in the target repo. |
| Server returns 401 | Set `SYMPHONY_AUTH_TOKEN` and send `Authorization: Bearer <token>`. |
| UI evidence command missing artifacts | Fix the target repo evidence script to write every configured artifact glob. |

## Architecture

```text
apps/
  cli/              symphony command: init, doctor, validate, tick, serve
  server/           JSON API, minimal dashboard, evidence serving, controls
  dashboard/        dashboard package, currently route metadata only

packages/
  core/             domain types and issue/workspace helpers
  workflow/         WORKFLOW.md parser, config resolver, prompt renderer
  db/               SQLite schema, migrations, run/event/evidence repositories
  tracker-linear/   Linear GraphQL client and issue adapter
  workspace-git/    safe worktree/clone manager and GitHub PR helper
  runner/           shell-backed Codex and Pi runner factories
  evidence/         artifact storage and path safety
  orchestrator/     poll, dispatch, retry, evidence, PR handoff, review loop
```

Design notes live in [docs/symphony-build-plan.md](docs/symphony-build-plan.md). UI evidence details live in [docs/symphony-ui-evidence.md](docs/symphony-ui-evidence.md).
