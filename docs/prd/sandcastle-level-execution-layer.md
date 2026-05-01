---
title: Sandcastle-Level Execution Layer
type: prd
status: accepted
updated: 2026-04-30
---

# Sandcastle-Level Execution Layer PRD

## Problem Statement

Operators can run the current Symphony Harness against GitHub Issues, but the runtime still feels opaque and too attempt-shaped. When the terminal moves, it is hard to understand which issue owns the work, why the current attempt started, whether the issue is retrying or handed off, and what the next action is.

The harness also does not yet have a strong execution-layer vocabulary for Sandcastle-style capabilities such as branch/worktree strategies, implement/review flows, PR handoff, and merge flows. Without that boundary, future improvements risk either staying too primitive or accidentally moving scheduler authority into workflow scripts.

## Solution

Build a Sandcastle-inspired Execution Layer under the existing harness scheduler.

The Symphony Harness remains the authoritative daemon for polling, issue eligibility, claims, retries, reconciliation, workflow reloads, and runtime state. The Execution Layer gains Worker Sessions, disposable Agent Attempts, append-only Worker Session Journals, Execution Strategies, typed Execution Primitives, and Workflow Templates. The Operator Console then presents Worker Sessions in human-readable terms so an operator can see what is happening without reading raw logs.

## User Stories

1. As an operator, I want each active issue to have a Worker Session, so that I can understand the durable story of the work.
2. As an operator, I want each Agent Attempt to record why it started, so that retry behavior is explainable.
3. As an operator, I want a Worker Session Journal under the workspace, so that I can inspect session history after a process exits.
4. As an operator, I want live scheduling authority to stay in memory, so that the filesystem journal does not become a hidden database.
5. As an operator, I want the dashboard to show sessions, attempts, handoffs, retries, next actions, and logs, so that I can understand what the harness is doing.
6. As an operator, I want PR handoff to stop redispatch, so that the harness does not rerun work that is waiting for review.
7. As a workflow author, I want branches and worktrees to be Execution Strategy data, so that scheduler identity remains issue plus workspace.
8. As a workflow author, I want `plain_workspace` to remain supported, so that existing workflows keep working.
9. As a workflow author, I want a `git_worktree_branch` strategy, so that issues can run on isolated branches.
10. As a workflow author, I want typed Execution Primitives, so that implement/review/merge flows are reliable and testable.
11. As a workflow author, I want Workflow Templates, so that teams can choose simple attempts, PR handoff, implement-review, or trusted auto-merge without changing scheduler code.
12. As a maintainer, I want the Python implementation to remain the oracle, so that Elixir parity work does not become a second scheduler prematurely.
13. As a maintainer, I want tests around Worker Session behavior, so that retries and handoffs remain safe under refactor.
14. As a maintainer, I want tests around journal parsing and malformed lines, so that operator history cannot crash the daemon.
15. As a maintainer, I want tests around Execution Strategy boundaries, so that branch/worktree behavior does not leak into scheduler identity.
16. As a maintainer, I want docs to use shared domain language, so that future agents do not re-litigate the Sandcastle boundary.
17. As a maintainer, I want roadmap slices to be issue-ready, so that the harness can execute them as AFK work.

## Implementation Decisions

- The harness scheduler remains authoritative for polling, claims, retries, reconciliation, reloads, and runtime state.
- Worker Session identity is issue plus workspace.
- Agent Attempts are disposable records inside a Worker Session.
- Worker Session history is stored as an append-only filesystem journal under the issue workspace.
- The journal is evidence and debug history; it is not the source of truth for live claims or retry timers.
- The first Execution Strategy is `plain_workspace`, matching current behavior.
- Branch and worktree behavior enters through a later `git_worktree_branch` Execution Strategy.
- Implement/review/merge flows are Workflow Template policy, not hardcoded scheduler behavior.
- The Operator Console is the first dashboard target; analytics and charts are out of scope for the first wave.
- Elixir parity tracks named behavior after Python proves it.

## Testing Decisions

- Prefer behavior tests through public service, runner, HTTP payload, and workspace/journal interfaces.
- Avoid tests that lock in private helper names or internal data plumbing unless the helper is intentionally a public deep module.
- Test Worker Session state through orchestrator/service behavior and snapshot output.
- Test Worker Session Journal append/read behavior directly because it is a deep module with a stable interface.
- Test Operator Console payloads and HTML for user-visible states, not CSS details.
- Test Execution Strategy behavior with temporary workspaces and fixture Git repos.
- Keep Python tests as the first oracle. Extend Elixir parity only after Python behavior is named and stable.

## Out Of Scope

- Replacing the Python scheduler with Sandcastle or Elixir.
- Restoring live retry timers after process restart.
- Making Git branch/worktree identity replace issue/workspace identity.
- Building analytics before the Operator Console.
- Hardcoding implement/review/merge policy in the daemon core.
- Adding Linear as the primary runtime tracker.
- Shipping an SSH worker extension in this wave.

## Further Notes

The source reference for Sandcastle is cached locally at `opensrc/repos/github.com/mattpocock/sandcastle`. The most relevant files are the run/orchestrator, sandbox factory, worktree manager, agent provider, sandbox provider, prompt preprocessor, and parallel planner templates.

This PRD is backed by `CONTEXT.md`, `docs/adr/0001-scheduler-authority-and-execution-layer.md`, and `docs/sandcastle-roadmap.md`.
