# Agent Brief

This file mirrors `AGENTS.md` for agents that read Claude-style repo briefs first. Keep both files aligned when changing cold-start instructions.

## What This Is

`harness-engineering` is a Python implementation of a Symphony-style Codex orchestration service. The first build uses GitHub Issues as the control plane, keeps `WORKFLOW.md` as the repo-owned policy contract, and runs each agent in a sanitized per-issue workspace.

## Source Of Truth

1. GitHub Issues define active work and durable handoff state.
2. `WORKFLOW.md` in the target repo defines worker prompt, runtime config, hooks, and tracker settings.
3. `rules/` defines coding and orchestration invariants.
4. Tests and lint output beat prose when they disagree.
5. `docs/implementation-defined.md` documents choices the draft Symphony spec leaves open.

## Local Setup

```bash
uv sync
```

Use `GITHUB_TOKEN` for real tracker access:

```bash
export GITHUB_TOKEN=...
```

## Run And Verify

```bash
./scripts/test.sh
./scripts/lint.sh
./scripts/typecheck.sh
./scripts/validate-workflow.sh WORKFLOW.example.md
```

Run one scheduler tick against a workflow:

```bash
uv run symphony-harness WORKFLOW.example.md --once
```

Run the status server on an ephemeral port in multi-worktree contexts:

```bash
uv run symphony-harness WORKFLOW.example.md --port 0
```

## Rules

- `rules/architecture.md`: dependency direction and module boundaries.
- `rules/workflow-contract.md`: `WORKFLOW.md`, tracker, and prompt rules.
- `rules/workspace-safety.md`: per-issue workspace invariants and multi-worktree rules.
- `rules/testing-and-validation.md`: expected verification commands and failure handling.

## Where Work Is Tracked

- Use GitHub Issues as the executable work queue.
- Use `.github/ISSUE_TEMPLATE/feature.yaml` for planned implementation work.
- Use `.github/ISSUE_TEMPLATE/bug.yaml` for regressions.
- Use `.github/ISSUE_TEMPLATE/agent-slop.yaml` when an agent mistake should become a rule, lint, test, or skill.
- Use `progress.json` for milestone-level Symphony wave state; do not duplicate full issue bodies there.
- Linear, if connected later, is a mirror and not part of the harness runtime contract.

## Multi-Worktree Gotcha

The hazard scanner previously found a fixed status-server port in `WORKFLOW.example.md`. Fixed ports collide when multiple worktrees run live harness sessions. Use `server.port: 0` in examples or pass a unique CLI `--port` per worktree. Only one live dev session may use a manually fixed port at a time.

## Operational Gotchas

- GitHub is the harness source of truth. Do not add Linear-specific orchestration logic to core scheduler code.
- Do not inline team policy in Python modules. Policy belongs in `WORKFLOW.md` and repo rules.
- Always validate the agent cwd before launching Codex. The cwd must equal the sanitized issue workspace path.
- Treat workflow reload failures as operator-visible errors, not process crashes. Keep the last known good config.
- Do not print tracker tokens or resolved secret values. Validate presence only.
- Hook scripts are trusted repo policy, but they must run inside the workspace and have timeouts.
- Workspaces persist across attempts. Do not destructively reset reused workspaces unless a documented workflow hook does it.

## Git And Release

- Keep changes surgical and path-scoped.
- Run the verification commands above before committing.
- Use the `changelog` CLI for release notes. Do not hand-write release entries when the tool can generate them.
- Do not push or release unless the user explicitly asks for that workflow.

## Garbage Collection

Read `docs/garbage-collection.md` before changing rules, lint, or repo skills. Weekly GC converts PR feedback and agent-slop issues into permanent harness improvements.
