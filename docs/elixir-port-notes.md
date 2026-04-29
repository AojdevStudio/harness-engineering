---
title: Elixir Port Notes
type: design
updated: 2026-04-29
---

# Elixir Port Notes

## Position

Keep the Python implementation as the spec-proving harness while using Elixir as the likely long-term orchestration runtime.

Python is the fastest surface for validating the Symphony contract today: workflow parsing, GitHub issue dispatch, workspace safety, Codex app-server protocol behavior, retry semantics, and operator observability. Elixir should not replace it until the current implementation has enough behavioral proof and fixtures to become a conformance oracle.

The Elixir port should improve the execution model, not reopen product policy:

- GitHub Issues remain the current control plane.
- `WORKFLOW.md` remains the repo-owned policy contract.
- Workspace safety rules stay identical.
- The Codex app-server boundary stays narrow and generated-schema-driven.
- The orchestrator remains the single authority for claims, retries, reconciliation, and runtime state.

## Source Pack

Use `opensrc` from a scratch directory with repository modification disabled:

```bash
mkdir -p /tmp/opensrc-elixir
cd /tmp/opensrc-elixir

opensrc --modify=false \
  elixir-lang/elixir \
  oban-bg/oban \
  dashbitco/broadway \
  livebook-dev/livebook \
  phoenixframework/phoenix_pubsub \
  elixir-horde/horde \
  bitwalker/libcluster \
  fhunleth/muontrap
```

Do not run this command from the repo root unless you intend to let `opensrc` add local integration files.

## Source Map

- `elixir-lang/elixir`
  - Study `DynamicSupervisor`, `Task.Supervisor`, `Registry`, and `PartitionSupervisor`.
  - Use these as the default local supervision primitives before reaching for distributed libraries.
- `livebook-dev/livebook`
  - Study session creation, per-session GenServers, runtime monitoring, PubSub updates, and temp cleanup.
  - This is the closest source model for long-running supervised coding/runtime sessions.
- `oban-bg/oban`
  - Study queue isolation, worker execution, retry/backoff, cancellation, telemetry, and shutdown semantics.
  - Do not assume the first Elixir port needs Oban as a dependency; use it as a mature design reference.
- `fhunleth/muontrap`
  - Study supervised OS process handling, stdout/stderr flow control, exit mapping, and cleanup.
  - This is directly relevant to launching and containing `codex app-server`.
- `dashbitco/broadway`
  - Study concurrent producer/processor topology and rate-limited pipeline design.
  - Likely useful later if polling and dispatch become a richer processing pipeline.
- `phoenixframework/phoenix_pubsub`
  - Study runtime event fanout and status updates.
  - Useful for an HTTP dashboard or real-time status surface.
- `elixir-horde/horde` and `bitwalker/libcluster`
  - Study only after local supervision is proven.
  - These are candidates for remote/multi-node workers, not the first port milestone.

## Target Shape

The first Elixir implementation should be a Phoenix-free OTP application unless the dashboard becomes the first priority.

Suggested modules:

- `Symphony.Application`
  - Starts config watcher, tracker client, orchestrator, worker supervisor, and optional status endpoint.
- `Symphony.Workflow`
  - Loads `WORKFLOW.md`, parses front matter, validates prompt template, and emits reload events.
- `Symphony.Config`
  - Provides typed config access with defaults and secret indirection.
- `Symphony.Tracker.GitHub`
  - Isolates GitHub API transport and normalizes issues.
- `Symphony.Workspace`
  - Enforces sanitized workspace keys, root containment, and hook execution.
- `Symphony.Orchestrator`
  - A GenServer that owns claims, running sessions, retry queue, reconciliation, token totals, and snapshots.
- `Symphony.WorkerSupervisor`
  - A `DynamicSupervisor` or `Task.Supervisor` for per-issue attempts.
- `Symphony.Agent.Codex`
  - Owns the app-server subprocess, protocol framing, turn handling, tool-call policy, and usage/rate-limit extraction.
- `Symphony.Status`
  - Reads orchestrator snapshots and exposes optional HTTP/JSON or terminal output.

## Porting Rule

Port behavior by conformance slices, not by copying Python modules one-for-one.

Every slice should prove one operator-visible behavior through the full stack. Python fixtures and tests should become the comparison oracle where practical.

## Proposed Issue Series

Published tracker index:

- [#2 Capture Elixir OTP skeleton and workflow validation](https://github.com/AojdevStudio/harness-engineering/issues/2)
- [#3 Prove GitHub candidate selection in one tick](https://github.com/AojdevStudio/harness-engineering/issues/3)
- [#4 Prove workspace safety and hooks end-to-end](https://github.com/AojdevStudio/harness-engineering/issues/4)
- [#5 Run a supervised stub agent attempt](https://github.com/AojdevStudio/harness-engineering/issues/5)
- [#6 Prove reconciliation, cancellation, and retry dispatch](https://github.com/AojdevStudio/harness-engineering/issues/6)
- [#7 Spike the real Codex app-server boundary](https://github.com/AojdevStudio/harness-engineering/issues/7)
- [#8 Add Python-to-Elixir parity harness](https://github.com/AojdevStudio/harness-engineering/issues/8)
- [#9 Decide status surface and distribution scope](https://github.com/AojdevStudio/harness-engineering/issues/9)

### 1. Capture Elixir OTP Skeleton And Workflow Validation

Type: AFK

Blocked by: None - can start immediately

What to build:

Create a minimal Elixir OTP app that boots, accepts a workflow path, loads `WORKFLOW.md`, validates core dispatch config, and exits cleanly in one-shot mode without dispatching workers.

Acceptance criteria:

- [ ] The app starts under a supervision tree.
- [ ] CLI/runtime path precedence matches the Python implementation.
- [ ] YAML front matter, prompt body trimming, defaults, and `$VAR` resolution match existing fixtures.
- [ ] Invalid workflow reload/startup errors are operator-visible and typed.
- [ ] Tests compare the Elixir loader/config behavior against existing Python fixtures.

### 2. Prove GitHub Candidate Selection In One Tick

Type: AFK

Blocked by: issue 1

What to build:

Implement enough GitHub tracker and orchestrator logic for a one-tick dry run that fetches issue fixtures, normalizes them, applies eligibility rules, and reports which issue would dispatch.

Acceptance criteria:

- [ ] GitHub issue payload normalization matches the Python domain model.
- [ ] Active/terminal states, blocker rules, sort order, and concurrency gates match Python behavior.
- [ ] Tracker transport is isolated behind an adapter boundary.
- [ ] A one-shot command can run with mocked GitHub responses and no Codex launch.

### 3. Prove Workspace Safety And Hooks End-To-End

Type: AFK

Blocked by: issue 1

What to build:

Implement workspace creation/reuse and hook execution for one normalized issue, including root containment checks and hook timeout semantics.

Acceptance criteria:

- [ ] Workspace keys are sanitized with the same allowed character set as Python.
- [ ] Workspace paths are normalized and rejected if they escape the root.
- [ ] `after_create`, `before_run`, `after_run`, and `before_remove` semantics match the spec.
- [ ] Hook failures and timeouts map to the same attempt outcomes as Python.
- [ ] Existing non-directory workspace paths fail safely.

### 4. Run A Supervised Stub Agent Attempt

Type: AFK

Blocked by: issues 2 and 3

What to build:

Wire the orchestrator, worker supervisor, workspace manager, prompt renderer, and a stub Codex client so one eligible GitHub issue can be claimed, run, report events, and release into continuation retry.

Acceptance criteria:

- [ ] The orchestrator GenServer is the only process mutating scheduling state.
- [ ] Running attempts are supervised and monitored.
- [ ] Worker normal exit schedules a short continuation retry.
- [ ] Worker abnormal exit schedules exponential backoff.
- [ ] Runtime snapshot includes running rows, retry rows, token totals, and recent event fields.

### 5. Prove Reconciliation, Cancellation, And Retry Dispatch

Type: AFK

Blocked by: issue 4

What to build:

Complete state reconciliation against mocked GitHub state changes and prove retries are consumed, requeued, or released correctly.

Acceptance criteria:

- [ ] Terminal tracker states terminate the worker and clean the workspace.
- [ ] Non-active non-terminal states terminate the worker without workspace cleanup.
- [ ] Stalled sessions terminate and schedule retry when stall detection is enabled.
- [ ] Due retries re-fetch candidates and dispatch with the recorded attempt.
- [ ] Slot exhaustion requeues retries with an explicit reason.

### 6. Spike The Real Codex App-Server Boundary

Type: HITL

Blocked by: issue 4

What to build:

Build a narrow Elixir Codex app-server client spike that launches `codex app-server` inside the per-issue workspace, sends one valid turn, streams events, and maps terminal outcomes.

Acceptance criteria:

- [ ] The launch cwd is validated as exactly the per-issue workspace path.
- [ ] The implementation uses current generated Codex schema/docs rather than hand-maintained protocol assumptions.
- [ ] The subprocess boundary documents whether it uses raw `Port`, `MuonTrap`, or another containment layer.
- [ ] Approval, unsupported tool-call, and user-input-required policy is documented.
- [ ] A local smoke test demonstrates one bounded session against a safe fixture workspace.

### 7. Add Python-To-Elixir Parity Harness

Type: AFK

Blocked by: issues 2, 3, 4, and 5

What to build:

Create a parity test harness that runs shared fixtures through both implementations and reports behavioral drift before the Elixir runtime is considered a replacement candidate.

Acceptance criteria:

- [ ] Shared fixtures cover workflow parsing, config, prompt rendering, issue normalization, eligibility, workspace paths, and retry state transitions.
- [ ] Drift reports name the failing behavior and fixture.
- [ ] The Python implementation remains the oracle until an explicit port-readiness decision is made.
- [ ] Documentation states which behaviors are proven, stubbed, or not yet ported.

### 8. Decide Status Surface And Distribution Scope

Type: HITL

Blocked by: issue 7

What to build:

Make an explicit decision on whether the Elixir runtime should add Phoenix/Plug status endpoints immediately and whether distributed workers are in scope for the first production port.

Acceptance criteria:

- [ ] The decision records local-only OTP, Phoenix/Plug, Horde/libcluster, and Oban dependency tradeoffs.
- [ ] The chosen status surface preserves orchestrator-state-only correctness.
- [ ] The chosen distribution scope does not weaken the single-authority orchestration invariant.
- [ ] Follow-up issues are created only for the selected path.
