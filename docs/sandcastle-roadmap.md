---
title: Sandcastle-Level Roadmap
type: roadmap
updated: 2026-04-30
---

# Sandcastle-Level Roadmap

This roadmap captures the agreed direction for bringing Sandcastle-grade execution ergonomics into the Symphony Harness without replacing the harness control plane.

## Target Shape

The Symphony Harness remains the daemonized scheduler. It continues to own polling, issue eligibility, claims, retries, reconciliation, workflow reloads, and operator-visible state.

Sandcastle is used as execution-layer source material. Its useful ideas are sandbox/worktree lifecycle, agent-provider boundaries, prompt-file ergonomics, branch-oriented implementation flows, review passes, and merger flows. Those ideas should enter the harness as typed Execution Primitives and Workflow Templates under Worker Sessions, not as a replacement scheduler.

## Accepted Decisions

1. **Scheduler authority stays in the harness.**
   The harness is not becoming a Sandcastle script runner. See [ADR 0001](./adr/0001-scheduler-authority-and-execution-layer.md).

2. **Worker Session identity is issue plus workspace.**
   Branches, worktrees, containers, or remote hosts are Execution Strategy details. They do not define scheduler identity.

3. **Agent Attempts are disposable.**
   A Worker Session is the durable story for an issue. Individual attempts start, fail, hand off, retry, or complete inside that story.

4. **Session history is a filesystem journal.**
   The Worker Session Journal is append-only evidence under the issue workspace. Live claims and retry authority remain in memory.

5. **The dashboard becomes an Operator Console first.**
   The first human-friendly UI should explain Worker Sessions, attempts, handoffs, retries, next actions, and logs. Charts and analytics can come later.

6. **Implement/review/merge is workflow policy.**
   The Execution Layer provides reliable primitives. WORKFLOW-owned templates decide whether to use implement-only, implement-plus-review, PR handoff, or auto-merge flows.

## Ordered Issue Series

Current implementation status:

- [#18](https://github.com/AojdevStudio/harness-engineering/issues/18) has an initial implementation in this branch.
- [#19](https://github.com/AojdevStudio/harness-engineering/issues/19) has an initial implementation in this branch.
- [#20](https://github.com/AojdevStudio/harness-engineering/issues/20) has an initial Operator Console/API implementation in this branch.
- [#21](https://github.com/AojdevStudio/harness-engineering/issues/21) has `plain_workspace` strategy support in this branch.
- [#22](https://github.com/AojdevStudio/harness-engineering/issues/22) has a tested git worktree strategy module in this branch, but workflow config does not select it yet.
- [#23](https://github.com/AojdevStudio/harness-engineering/issues/23) has typed primitive foundations in this branch, but implement/review agent primitives are not runtime-wired yet.
- [#24](https://github.com/AojdevStudio/harness-engineering/issues/24) has declarative template foundations in this branch, but runtime template selection/execution is not wired yet.
- [#25](https://github.com/AojdevStudio/harness-engineering/issues/25) has documentation updates in this branch.

### 1. Model Worker Sessions And Agent Attempts

GitHub issue: [#18](https://github.com/AojdevStudio/harness-engineering/issues/18)

Goal: introduce explicit domain objects for Worker Session and Agent Attempt without changing runtime behavior yet.

Scope:

- Add a Worker Session model keyed by issue ID plus workspace path.
- Add Agent Attempt records with attempt number, reason, status, timestamps, and error/handoff fields.
- Map current running/retry/completed state into the new vocabulary.
- Keep the current orchestrator state authority unchanged.

Acceptance checks:

- Existing tests still pass.
- State snapshot can show session status and current attempt reason.
- CONTEXT language is used consistently in docs and code comments.

### 2. Add Worker Session Journal

GitHub issue: [#19](https://github.com/AojdevStudio/harness-engineering/issues/19)

Goal: persist session history as append-only evidence without introducing a scheduler database.

Scope:

- Write `<workspace>/.symphony/session.jsonl`.
- Record events for session start, attempt start, agent event summary, attempt finish, retry scheduled, handoff detected, cancellation, and cleanup.
- Make journal writes best-effort but operator-visible on failure.
- Add a reader that can reconstruct recent session history for the Operator Console.

Acceptance checks:

- Journal survives process restart.
- Retry timers are not restored from the journal.
- Malformed or partially written journal lines do not crash the service.

### 3. Upgrade The Operator Console

GitHub issue: [#20](https://github.com/AojdevStudio/harness-engineering/issues/20)

Goal: replace the current JSON-in-HTML page with a human-readable Worker Session console.

Scope:

- Show running sessions, retrying sessions, handoff sessions, and recent completed/failed sessions.
- For each session, show issue, workspace, attempt number, attempt reason, last event, last error, next action, PR/handoff link when known, and journal/log path.
- Keep `/api/v1/state` stable.
- Add issue-specific details at `/api/v1/<issue_identifier>` using live state plus journal history.

Acceptance checks:

- A user can explain what the harness is doing without reading terminal logs.
- Refresh button triggers `/api/v1/refresh`.
- Empty state, running state, retry state, and failure state are all readable.

### 4. Introduce Execution Strategy Interface

GitHub issue: [#21](https://github.com/AojdevStudio/harness-engineering/issues/21)

Goal: separate how work is prepared/run from scheduler identity.

Scope:

- Define an Execution Strategy contract.
- Implement `plain_workspace` as the existing behavior.
- Keep workspace safety invariants: sanitized keys, root containment, agent cwd equals workspace path.
- Route AgentRunner through the strategy without broad scheduler rewrites.

Acceptance checks:

- Current behavior is preserved through `plain_workspace`.
- Strategy can report structured metadata to the Worker Session Journal.
- Strategy failures become attempt failures with retry behavior unchanged.

### 5. Add Git Worktree Branch Strategy

GitHub issue: [#22](https://github.com/AojdevStudio/harness-engineering/issues/22)

Goal: bring in the first Sandcastle-style execution strategy.

Scope:

- Create issue-scoped git worktrees under a managed directory.
- Generate sanitized branch names from issue identifiers or workflow config.
- Detect existing checked-out branches and dirty worktrees safely.
- Preserve the per-issue workspace identity while storing branch/worktree metadata as strategy data.
- Use Sandcastle as source material for branch naming, worktree reuse, and git config race avoidance.

Acceptance checks:

- Parallel issues can run on separate worktree branches.
- Reused worktrees are not destructively reset.
- Dirty or externally checked-out branch states fail safely.
- Journal records branch and worktree metadata.

### 6. Add Execution Primitives

GitHub issue: [#23](https://github.com/AojdevStudio/harness-engineering/issues/23)

Goal: expose reliable typed worker capabilities that Workflow Templates can compose.

Scope:

- Implement primitives for prepare workspace, run implement attempt, detect commits, run review attempt, summarize diff, create PR handoff, and record handoff.
- Keep tracker writes out of scheduler core unless explicitly introduced by a later decision.
- Emit structured events for each primitive.

Acceptance checks:

- Primitives can be tested without running a full daemon loop.
- Failures map to retry, handoff, or cancellation reasons consistently.
- Prompt policy stays in `WORKFLOW.md` or template files.

### 7. Add Workflow Templates

GitHub issue: [#24](https://github.com/AojdevStudio/harness-engineering/issues/24)

Goal: offer Sandcastle-style repeatable flows while keeping policy in repo-owned templates.

Initial templates:

- `simple_attempt`: current behavior.
- `implement_then_pr`: implement work, open PR, enter Handoff State.
- `implement_review_then_pr`: implement, review, open PR, enter Handoff State.
- `implement_review_merge`: trusted mode for auto-merge after checks.

Acceptance checks:

- Core scheduler does not hardcode review or merge behavior.
- Templates declare which Execution Primitives they use.
- Handoff State prevents redispatch while PR review is pending.

### 8. Clarify Elixir Parity Path

GitHub issue: [#25](https://github.com/AojdevStudio/harness-engineering/issues/25)

Goal: keep the Elixir port honest while the Python implementation remains the behavioral oracle.

Scope:

- Extend `docs/elixir-port-notes.md` with Worker Session, Agent Attempt, Worker Session Journal, and Execution Strategy parity targets.
- Add fixture-backed parity tests for journal event shapes before porting runtime behavior.
- Keep Elixir as tracer-bullet/parity work until an explicit port-readiness decision is made.

Acceptance checks:

- Elixir notes distinguish implemented behavior from future parity targets.
- Python-backed fixtures remain the oracle.
- No second scheduler is introduced in Elixir.

## Non-Goals For This Wave

- Replacing the Python scheduler with Sandcastle or Elixir.
- Restoring live retry timers after process restart.
- Making Git branches the scheduler identity.
- Building analytics before the Operator Console.
- Hardcoding implement/review/merge policy in the daemon core.

## Source Material

Sandcastle source is cached locally at:

`/Users/ossieirondi/Projects/harness-engineering/opensrc/repos/github.com/mattpocock/sandcastle`

Especially relevant files:

- `src/run.ts`
- `src/Orchestrator.ts`
- `src/SandboxFactory.ts`
- `src/WorktreeManager.ts`
- `src/AgentProvider.ts`
- `src/SandboxProvider.ts`
- `src/PromptPreprocessor.ts`
- `src/templates/parallel-planner-with-review/main.mts`
- `src/templates/parallel-planner-with-review/plan-prompt.md`
- `src/templates/parallel-planner-with-review/merge-prompt.md`

## Recommended Next Issue

Start with [#18 Model Worker Sessions And Agent Attempts](https://github.com/AojdevStudio/harness-engineering/issues/18). It is the smallest slice that makes every later Sandcastle-inspired capability easier to reason about, and it does not force a branch/worktree strategy before the current plain-workspace behavior is named and stabilized.
