# Symphony

Symphony is a self-hosted TypeScript/Bun control plane for unattended ticket-level coding agents. It watches Linear, prepares isolated Git workspaces, runs Codex or Pi, validates the result, stores evidence, opens PR handoffs, and reconciles review feedback.

Status: v0.2 dogfood release. It is intended for one trusted team, local SQLite state, and token-protected local control plane APIs.

## Architecture

```text
apps/
  cli/              symphony command: init, doctor, validate, tick, serve
  server/           JSON API, minimal dashboard, evidence serving, controls
  dashboard/        operator dashboard shell for runs, events, evidence, health, controls

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

## Quick Start

This path starts Symphony from a fresh clone and gets you to one safe readiness check before any agent can touch a target repo.

Before a live ticket run, you need:

- a target Git repo Symphony is allowed to branch, commit, push, and open PRs against
- `gh` authenticated with push/PR access to that repo
- a Linear API key and the target Linear project slug
- Codex CLI or Pi CLI installed, depending on `SYMPHONY_RUNNER`
- target-repo install and validation commands that can run unattended

These examples assume you linked the source checkout once with `bun link`. If `symphony` is not found after linking, make sure `~/.bun/bin` is on `PATH`; if you skip linking, prefix Symphony commands with `bun run`.

### 1. Verify the Symphony checkout

Prerequisite: install [Bun](https://bun.sh/). Then run:

```bash
bun install
bun link
bun run verify
```

### 2. Generate local operator files

`symphony init` writes files wherever you point it. If you are only trying Symphony locally, using the repo root is fine:

```bash
symphony init
```

For a cleaner dogfood setup, create the operator files under ignored local state and pass that workflow path to later commands:

```bash
symphony init ./.symphony/local-run
```

This creates:

```text
WORKFLOW.md
.env
.symphony/
  workspaces/
  evidence/
```

The generated files are intentionally not dispatch-ready. They contain placeholders that must be filled before a real ticket run.

### 3. Fill in the parts Symphony cannot guess

Edit `.env`:

```bash
LINEAR_API_KEY=lin_api_...
SYMPHONY_AUTH_TOKEN=<random local token>
SYMPHONY_RUNNER=codex
SYMPHONY_WORKSPACE_MODE=worktree
SYMPHONY_SOURCE_REPO=/absolute/path/to/target-repo
SYMPHONY_BASE_REF=main
```

If Symphony should clone a repo instead of using a local worktree source, use this shape instead:

```bash
SYMPHONY_WORKSPACE_MODE=clone
SYMPHONY_REPO_URL=git@github.com:OWNER/REPO.git
SYMPHONY_BASE_REF=main
```

Edit `WORKFLOW.md`:

- replace `REPLACE_WITH_LINEAR_PROJECT_SLUG`
- set the Linear state names to match the target project
- set `hooks.after_create` and `hooks.after_run` to commands that work in the target repo
- leave PR self-review and UI evidence commented out until the target repo has those scripts

Important: in worktree mode, `SYMPHONY_SOURCE_REPO` defaults to the workflow directory. If your workflow file lives in the Symphony repo but the agent should work in another repo, set `SYMPHONY_SOURCE_REPO` explicitly.

### 4. Run the local doctor

The doctor is the first meaningful gate. Run it before `tick`:

```bash
symphony doctor WORKFLOW.md
```

Fix every failed check it reports. A placeholder Linear project slug, missing `gh` auth, missing runner command, missing base ref, or bad workspace source should stop here.

If you used a separate operator directory, pass that workflow path instead:

```bash
symphony doctor ./.symphony/local-run/WORKFLOW.md
```

### 5. Run live preflight

Only after `.env` has real credentials:

```bash
symphony doctor WORKFLOW.md --live-tracker
symphony validate WORKFLOW.md --live-tracker
```

This verifies that the Linear API key works, the project slug exists, and the configured Linear states exist.

### 6. Run one controlled tick

Do this only after doctor and live validation are clean:

```bash
symphony tick WORKFLOW.md
```

One tick either dispatches one eligible ticket or reconciles an existing PR/rework state.

### 7. Start the local API/dashboard

```bash
symphony serve WORKFLOW.md
```

Open:

```text
http://localhost:7331
```

Send API requests with `Authorization: Bearer <SYMPHONY_AUTH_TOKEN>`.

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
| `symphony init [DIR]` | Create `WORKFLOW.md`, `.env`, and local state directories. |
| `symphony doctor [WORKFLOW.md]` | Check Bun, `gh`, GitHub auth, workflow config, runner command, workspace inputs, base ref, server auth, and evidence command readiness. |
| `symphony doctor [WORKFLOW.md] --live-tracker` | Also call Linear and verify the project slug plus configured state names. |
| `symphony validate [WORKFLOW.md]` | Print resolved workflow config and dispatch readiness as JSON. |
| `symphony validate [WORKFLOW.md] --live-tracker` | Validate config plus live Linear project/state names. |
| `symphony tick [WORKFLOW.md]` | Run one poll, dispatch, or PR review reconciliation pass. |
| `symphony serve [WORKFLOW.md]` | Start the local control plane API/dashboard. |
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
symphony doctor WORKFLOW.md
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
