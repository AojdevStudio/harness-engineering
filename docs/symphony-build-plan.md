# Symphony Build Plan

Status: Draft architecture plan

## Product decision

Build **Symphony** as a self-hosted team control plane first, not a true multi-tenant SaaS yet.

V1 should feel like a product/control plane, but target one trusted org/team with basic token auth. Multi-tenant SaaS, billing, org RBAC, and hosted operations are later concerns.

## Non-negotiable principle

**Observability above all:** every scheduling decision, agent action, retry, blocker, validation result, token/cost update, and evidence artifact should be inspectable.

v1 satisfies this via SQLite event log + JSON API endpoints; rich dashboard UI deferred to v2.

## Core choices

- Language/runtime: TypeScript on Bun
- Repo location: current repo root (`harness-building`)
- Package name/product name: `symphony`
- Architecture: monorepo packages
- Tracker v1: Linear, configured from `WORKFLOW.md`
- Tracker v2: GitHub Issues adapter
- Runner v1: Codex and Pi fully implemented before first dogfood
- Runner abstraction: generic runner interface with concrete Codex/Pi adapters
- Workspace strategy: adapter supporting git worktree and clone
- Default workspace: git worktree unless workflow selects clone
- State: SQLite scheduler/event/session store
- Temporal: later adapter, not required in v1
- Safety: configurable, default medium; basic auth/token auth for control plane
- PR ownership: orchestrator owns branch, push, and PR shell; agent edits/commits/fills evidence
- Success: workflow-defined predicate; default requires handoff state plus validation/evidence

## Future dashboard requirements (deferred from v1)

v1 ships with a minimal inline JSON dashboard at `apps/server`. The full SPA dashboard described below is deferred — track in a follow-up plan.

- issues by state: queued, running, retry, review, done
- per-run event timeline
- agent stdout/stderr tail
- evidence artifact links/viewer
- token/cost accounting
- manual controls: pause, retry, cancel
- config/workflow validation errors

## Key deviation from OpenAI reference

OpenAI's spec allows no persistent database and leaves most tracker writes to the agent. Our version will differ:

1. SQLite is required for run/event/debug state.
2. Orchestrator owns lifecycle-critical tracker writes.
3. Evidence is first-class, not just prompt convention.
4. Dashboard is core to the **product**; v1 ships a minimal JSON view, full SPA deferred to v2.
5. Runner adapters must support Codex and Pi before dogfood.

## System architecture

```text
apps/
  cli/                 # symphony command
  server/              # control plane API + dashboard host
  dashboard/           # web UI
packages/
  core/                # domain model, orchestrator state machine
  workflow/            # WORKFLOW.md parser, schema, validation, prompt render
  db/                  # SQLite schema, migrations, repositories
  tracker-linear/      # Linear adapter
  tracker-github/      # later adapter stub
  workspace-git/       # worktree/clone workspace manager
  runner-codex/        # Codex runner
  runner-pi/           # Pi runner
  evidence/            # artifact registry, screenshots/videos/log references
  observability/       # logs, event stream, token/cost accounting
  shared/              # shared types/utilities
```

## Core domain objects

- `WorkflowDefinition`
- `Issue`
- `IssueClaim`
- `Workspace`
- `Run`
- `RunAttempt`
- `RunnerSession`
- `RunnerEvent`
- `RetryEntry`
- `EvidenceArtifact`
- `TrackerWrite`
- `WorkflowSuccessPredicate`

## SQLite tables

Initial tables:

- `workflow_snapshots`
- `issues_seen`
- `claims`
- `runs`
- `run_attempts`
- `runner_sessions`
- `events`
- `retry_queue`
- `evidence_artifacts`
- `token_usage`
- `control_actions`

## `WORKFLOW.md` stance

Implement OpenAI-compatible core fields plus extension fields.

Core:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex`

Extensions:

- `server`
- `auth`
- `runner`
- `evidence`
- `github`
- `success`
- `safety`

Unknown keys should be ignored with warnings, not fatal errors.

## Orchestrator responsibilities

The orchestrator owns:

- workflow load/reload validation
- polling cadence
- candidate issue selection
- claiming/deduplication
- concurrency limits
- workspace creation
- branch naming and PR shell
- run lifecycle
- retry/backoff
- cancellation/pause/resume
- terminal cleanup
- lifecycle-critical tracker writes
- event persistence
- dashboard state projection

The agent owns:

- reading issue context
- implementation edits
- commits inside the workspace branch
- validation commands requested by workflow
- evidence content generation
- rich workpad details
- review feedback resolution details

## First implementation milestones

### Milestone 0 — Repo scaffold

- Bun workspace
- TypeScript config
- Biome/ESLint or equivalent
- test runner
- `make verify` or `bun run verify`
- basic `AGENTS.md`

### Milestone 1 — Workflow parser and config validation

- Parse Markdown + YAML front matter
- Typed schema with defaults
- `$VAR` resolution where allowed
- prompt rendering with issue/attempt variables
- validation error model

### Milestone 2 — SQLite state and event log

- Database setup
- migrations
- event append/query API
- run/attempt/session records
- JSON log sink

### Milestone 3 — Linear adapter

- Fetch candidate issues
- Fetch issues by states
- Fetch issue states by IDs
- Claim/state/workpad/attachment primitives where available
- Redacted auth handling

### Milestone 4 — Workspace adapter

- Safe path normalization
- sanitized workspace keys
- git worktree creation
- git clone fallback
- hooks with timeout
- workspace cleanup

### Milestone 5 — Runner adapters

- Generic runner interface
- Codex runner
- Pi runner
- stdout/stderr/event capture
- token usage extraction where possible
- cancellation semantics

### Milestone 6 — Orchestrator loop

- poll/reconcile/dispatch
- claims and retries
- pause/retry/cancel controls
- workflow success predicate
- terminal cleanup

### Milestone 7 — PR/evidence lifecycle

- branch/push/PR shell owned by orchestrator
- evidence artifact registry
- workpad/handoff summary
- validation/evidence gate before success

### Milestone 8 — Control plane dashboard

- HTTP API
- basic token auth
- issue state board
- run timeline
- log tail
- evidence viewer
- token/cost panel
- manual controls
- config errors

### Milestone 9 — Dogfood

- Real Linear project via `WORKFLOW.md`
- Real Codex and Pi runner tests
- One ticket through PR handoff
- Record gaps against OpenAI `SPEC.md` section 18.1

## First dogfood acceptance criteria

A real Linear ticket can be moved to an active state and Symphony will:

1. claim it without duplicate dispatch
2. create an isolated workspace
3. create/manage a branch
4. run Codex or Pi according to workflow config
5. stream events to SQLite/logs/dashboard
6. run validation requested by workflow
7. capture evidence artifacts/links
8. push branch and create/update PR shell
9. update tracker workpad/handoff state
10. expose full run timeline and logs in dashboard
11. support cancel/retry from dashboard
12. recover enough state after restart to explain what happened

## Explicit risks

- Codex/Pi runner protocols may be unstable or not cleanly automatable.
- Real Linear + real PR first dogfood increases integration debugging load.
- Hosted-control-plane ambition can cause v1 scope creep.
- Orchestrator-owned PR lifecycle requires careful git/credential handling.
- Evidence viewer can sprawl unless artifact model stays simple.
- Basic auth is not enough for public hosting.

## Scope guardrails

Not v1:

- true multi-tenant SaaS
- billing
- full RBAC
- Temporal production workflows
- Jira adapter
- distributed worker fleet
- Kubernetes deployment
- complex policy engine
- model/provider marketplace

V1 must prove one thing: **a team can manage tickets while Symphony manages unattended agent implementation with observable evidence.**

## Implementation deviations

The following deviations from this plan were made during initial implementation and are recorded here for traceability.

### Single `runner` package replaces planned `runner-codex` + `runner-pi`

The plan specifies separate `packages/runner-codex` and `packages/runner-pi` packages. The implementation consolidates both into a single `packages/runner` package with a `kind` discriminator field on the runner interface (`AgentRunner.kind`). Rationale: the two runners share significant shell-runner scaffolding (stdin write, stdout/stderr capture, token metric parsing, timeout semantics). A single package with a discriminated factory avoids duplication; runner selection is still workflow-configured.

### `observability/` and `shared/` packages not yet created

The plan calls for `packages/observability/` (logs, event stream, token/cost accounting) and `packages/shared/` (shared types/utilities). These do not exist in the current implementation. Observability is folded into `packages/db` via the `events` table and the `token_usage` table. Shared domain types live in `packages/core`. These packages can be extracted in a future refactor if the surface grows large enough to warrant dedicated boundaries.

### `tracker-github` adapter not yet created

The plan notes `packages/tracker-github/` as a later adapter stub. It has not been created. GitHub Issues support is planned for v2. The `TrackerAdapter` interface in `packages/orchestrator` is designed to accommodate a GitHub implementation without changes.

### Orchestrator owns `hooks.afterRun` validation

The plan states "the agent owns validation commands." The implementation deviates: the orchestrator enforces that `hooks.after_run` must be configured (throws at construction if absent) and runs it unconditionally before marking a run succeeded. Rationale: tying validation to the orchestrator lifecycle gives a deterministic, centrally observable gate — a run cannot succeed without validation passing, regardless of which agent runner is used. This is consistent with the plan's "Observability above all" principle even though it deviates from the letter of "agent owns validation."

### Dashboard SPA deferred to v2

v1 satisfies the observability principle via the SQLite event log and `apps/server` JSON API endpoints (`/api/v1/runs`, `/api/v1/events`, `/api/v1/state`, `/api/v1/runs/:id`, `/api/v1/evidence/:artifactId`). The 30-line inline HTML in `apps/server/src/index.ts` is the v1 "dashboard". A follow-up plan will design the full SPA (state-grouped runs, per-run timeline, live stdout tail, token/cost panel, control buttons).

### PR review and merge loop added to orchestrator

The orchestrator now polls issues in the configured `human_review` and `merging` states through the PR adapter. P0/P1/P2 findings from PR comments/reviews, `CHANGES_REQUESTED`, or failing checks create a rework run with the PR feedback appended to the agent prompt. Clean, passing PRs merge only when the issue is already in `merging` or GitHub reports an approved review decision, then the tracker moves to `done`.
