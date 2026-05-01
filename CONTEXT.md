# Harness Engineering

Harness Engineering defines a daemonized coding-agent orchestration service that reads executable work from GitHub Issues, applies repository-owned workflow policy, and runs isolated agent attempts with operator-visible state.

## Language

**Symphony Harness**:
A daemonized scheduler/runner that owns polling, issue claims, retries, reconciliation, workflow reloads, and runtime observability.
_Avoid_: Sandcastle clone, generic agent script

**Execution Layer**:
The worker-side capability boundary responsible for sandbox/workspace lifecycle, agent-provider integration, and task execution flows under the Symphony Harness scheduler.
_Avoid_: Sandcastle level, scheduler, control plane

**Worker Session**:
A durable issue/workspace story that survives across disposable agent attempts and records why work continued, handed off, failed, or retried.
_Avoid_: retry session, loose agent run, background job

**Agent Attempt**:
A single execution try inside a Worker Session, starting an agent process or turn sequence and ending with success, failure, timeout, cancellation, or handoff.
_Avoid_: Worker Session, durable session

**Worker Session Journal**:
An append-only filesystem record under an issue workspace that explains Worker Session history without becoming the live scheduling authority.
_Avoid_: scheduler database, retry lock, source of truth for live claims

**Operator Console**:
A human-readable runtime surface that explains Worker Sessions, Agent Attempts, next actions, handoffs, and relevant logs to an operator.
_Avoid_: analytics dashboard, metrics UI, generic status page

**Execution Strategy**:
The selected method a Worker Session uses to prepare and run code, such as a plain workspace, git worktree branch, sandbox container, or remote worker host.
_Avoid_: session identity, scheduler policy

**Execution Primitive**:
A typed capability exposed by the Execution Layer, such as preparing a workspace, running an implement attempt, running a review attempt, detecting commits, or recording handoff state.
_Avoid_: hardcoded workflow, scheduler rule

**Workflow Template**:
A repository-owned policy composition that uses Execution Primitives to define a repeatable agent flow such as simple attempt, implement plus review, PR handoff, or auto-merge.
_Avoid_: core scheduler behavior, hidden business process

**Handoff State**:
A Worker Session outcome where the harness stops dispatching because the next action belongs to a human, pull request, tracker state, or other external process.
_Avoid_: done, failed, terminal issue

**Policy Contract**:
The repository-owned `WORKFLOW.md` instructions and runtime settings that define how workers should behave for a target project.
_Avoid_: hardcoded harness policy, inline team rules

## Relationships

- A **Symphony Harness** runs one or more **Execution Layer** attempts.
- A **Worker Session** is the unit of execution managed by the **Execution Layer**.
- A **Worker Session** contains one or more **Agent Attempts**.
- A **Worker Session Journal** records **Worker Session** history but does not own live scheduling state.
- An **Operator Console** presents **Worker Sessions** and **Agent Attempts** in human-readable form.
- An **Execution Strategy** belongs to a **Worker Session**, but does not define the session's scheduler identity.
- An **Execution Layer** exposes **Execution Primitives**.
- A **Workflow Template** composes **Execution Primitives** into project-specific behavior.
- A **Handoff State** stops further dispatch for a **Worker Session** until the external handoff condition changes.
- A **Policy Contract** configures future **Execution Layer** attempts.
- A **Symphony Harness** owns scheduling decisions; an **Execution Layer** owns worker execution decisions.

## Example Dialogue

> **Dev:** "Are we trying to replace the harness with Sandcastle?"
> **Domain expert:** "No. The **Symphony Harness** remains the scheduler, and we build a Sandcastle-inspired **Execution Layer** under it."

## Flagged Ambiguities

- "Sandcastle level" was used to mean higher-quality agent orchestration; resolved: the canonical term is **Execution Layer** when discussing worker-side sandbox, provider, branch, review, and merge capabilities.
- "branch" and "worktree" were considered as possible session identity fields; resolved: they belong to **Execution Strategy**, while **Worker Session** identity remains issue plus workspace.
- "implement/review/merge" could mean scheduler behavior or workflow behavior; resolved: these are **Workflow Template** choices built from **Execution Primitives**, not core scheduler rules.
