# Symphony Agent Brief

This repo builds our TypeScript/Bun implementation of Symphony: a self-hosted team control plane for unattended ticket-level coding agents.

## Source of truth

1. `docs/symphony-build-plan.md` — product and architecture decisions.
2. `symphony/SPEC.md` — cloned OpenAI reference spec, used as external inspiration only.
3. Package code and tests under `packages/` and `apps/`.

## Commands

```bash
bun install
bun test
bun run typecheck
bun run verify
```

## Current architecture

- `packages/workflow`: `WORKFLOW.md` parser, config resolver, prompt renderer.
- `packages/core`: orchestration domain types/state machine primitives.
- `packages/db`: SQLite schema, migrations, run records, event log.
- `packages/tracker-linear`: Linear GraphQL client and issue adapter.
- `packages/workspace-git`: safe git worktree/clone workspace manager.
- `packages/runner`: shell-based Codex/Pi runner adapters.
- `packages/evidence`: evidence artifact storage.
- `packages/orchestrator`: poll/dispatch/run/handoff orchestration.
- `apps/cli`: future `symphony` command.
- `apps/server`: future control plane API.
- `apps/dashboard`: future dashboard UI.

## Guardrails

- Keep the implementation portable. Do not couple core logic to Superconductor or one local harness.
- Add adapters at boundaries: tracker, runner, workspace, evidence, observability.
- Parse and validate external data at package boundaries.
- Prefer tests with every domain behavior change.
- Never hardcode API keys, personal paths, or tracker project slugs.
