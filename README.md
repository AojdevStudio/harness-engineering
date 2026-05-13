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

This path starts Symphony from a fresh source checkout and gets you to one safe readiness check before any agent can touch a target repo.

For v0.2, Symphony is a source-linked operator tool. It is not published as an npm package yet, so the supported install path is `git clone`, `bun install`, and `bun link`.

### Recommended Layout

Keep Symphony, operator state, and the target repo separate:

```text
~/tools/symphony              # Symphony source checkout
~/code/my-app                 # target repo agents will edit
~/symphony-runs/my-app        # operator config, SQLite state, evidence, workspaces
```

Do not clone Symphony inside the target repo by default. The target repo should contain product code and its own agent-facing docs. Symphony's `.env`, SQLite database, evidence files, and temporary workspaces belong in an operator directory that stays out of the target repo's commits.

You can run `symphony init` inside the Symphony checkout for a quick local dogfood run, but the cleaner default is one operator directory per target repo.

### 1. Install Symphony

Install [Bun](https://bun.sh/), then clone and link Symphony:

```bash
mkdir -p ~/tools
git clone git@github.com:AojdevStudio/harness-engineering.git ~/tools/symphony
cd ~/tools/symphony
bun install
bun link
bun run verify
```

After linking, `symphony` should resolve from your shell:

```bash
symphony --help
```

If `symphony` is not found, make sure `~/.bun/bin` is on `PATH`. If you skip `bun link`, run commands from the Symphony checkout with `bun run symphony ...`.

### 2. Prepare Accounts And CLIs

Symphony needs access to the systems it will operate:

| Need | How to prepare it | How to check it |
| --- | --- | --- |
| GitHub push and PR access | Install GitHub CLI, then authenticate the account that can push to the target repo. | `gh auth status` |
| Linear project access | Create a Linear API key and identify the target project slug plus workflow state names. | `symphony doctor WORKFLOW.md --live-tracker` after config |
| Coding runner | Install and authenticate the runner you choose with `SYMPHONY_RUNNER=codex` or `SYMPHONY_RUNNER=pi`. | `codex --help` or `pi --help` |
| Local API auth | Generate a local bearer token for the dashboard/API. | `openssl rand -hex 24` |

Do not put API keys in the target repo. Put them in the operator directory `.env` generated below.

### 3. Prepare The Target Repo

The target repo is the repo Symphony will branch, edit, test, push, and open PRs against. Before the first real `tick`, make sure it has:

- a clean local checkout or a cloneable GitHub URL
- a base ref such as `main` or `develop`
- push permission for the authenticated `gh` user
- one unattended install command, such as `bun install`, `npm install`, or `uv sync`
- one unattended validation command, such as `bun run verify`, `npm test`, or `pytest`
- agent-readable project instructions, usually `AGENTS.md` or `CLAUDE.md`
- a narrow Linear ticket with acceptance criteria

Optional for Ossie's operator stack: if you have the skills repo installed, run the `harness-audit` skill against the target repo first. It checks whether the repo is agent-ready across cold-start docs, rules, tests, PR review, repo skills, worktree safety, and issue/spec handoff. Treat that as target-repo preparation; Symphony itself does not require the skills repo to run.

### 4. Generate Operator Files

Create one operator directory per target repo:

```bash
mkdir -p ~/symphony-runs/my-app
cd ~/symphony-runs/my-app
symphony init .
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

If you are only trying Symphony locally inside the Symphony checkout, use an ignored local operator directory instead:

```bash
cd ~/tools/symphony
symphony init ./.symphony/local-run
```

Then pass that workflow path to later commands:

```bash
symphony doctor ./.symphony/local-run/WORKFLOW.md
```

### 5. Fill In The Parts Symphony Cannot Guess

Edit `.env`:

```bash
LINEAR_API_KEY=lin_api_...
SYMPHONY_AUTH_TOKEN=<random local token>
SYMPHONY_RUNNER=codex
SYMPHONY_WORKSPACE_MODE=worktree
SYMPHONY_SOURCE_REPO=/Users/you/code/my-app
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

### 6. Run The Local Doctor

The doctor is the first meaningful gate. Run it before `tick`:

```bash
symphony doctor WORKFLOW.md
```

Fix every failed check it reports. A placeholder Linear project slug, missing `gh` auth, missing runner command, missing base ref, or bad workspace source should stop here.

### 7. Run Live Preflight

Only after `.env` has real credentials:

```bash
symphony doctor WORKFLOW.md --live-tracker
symphony validate WORKFLOW.md --live-tracker
```

This verifies that the Linear API key works, the project slug exists, and the configured Linear states exist.

### 8. Run One Controlled Tick

Do this only after doctor and live validation are clean:

```bash
symphony tick WORKFLOW.md
```

One tick either dispatches one eligible ticket or reconciles an existing PR/rework state.

### 9. Start The Local API/Dashboard

```bash
symphony serve WORKFLOW.md
```

Open:

```text
http://localhost:7331
```

Send API requests with `Authorization: Bearer <SYMPHONY_AUTH_TOKEN>`.

## Required Tools

- Bun for the Symphony source checkout
- Git for target repo workspaces
- GitHub CLI (`gh`) authenticated for PR creation, push access, and merge checks
- Linear API key for live issue polling and state writes
- Codex CLI or Pi CLI, depending on `SYMPHONY_RUNNER`
- target-repo install and validation commands that can run unattended

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
| Worktree source is not a Git repo | Set `SYMPHONY_SOURCE_REPO` to the target repo path. |
| Base ref not found | Set `SYMPHONY_BASE_REF` to an existing branch/ref in the target repo. |
| Server returns 401 | Set `SYMPHONY_AUTH_TOKEN` and send `Authorization: Bearer <token>`. |
| UI evidence command missing artifacts | Fix the target repo evidence script to write every configured artifact glob. |
