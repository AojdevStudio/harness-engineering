---
title: Elixir Port Notes
type: reference
updated: 2026-04-29
---

# Elixir Port Notes

The Elixir port starts as a tracer bullet, not a second scheduler.

## Tracer Bullet Scope

- Boot an OTP application with a supervised runtime process.
- Accept the same workflow path precedence as the Python CLI: explicit path first, otherwise `./WORKFLOW.md` from the current working directory.
- Load YAML front matter and the markdown prompt body from `WORKFLOW.md`.
- Resolve the same config defaults and explicit `$VAR` indirections used by the Python loader/config layer.
- Validate dispatch readiness without polling GitHub or launching workers.
- Return typed operator-visible startup and reload errors.

## Python Oracle

The current Python implementation remains authoritative for workflow semantics. Elixir tests call the Python loader/config against the same temporary workflow files and compare normalized fields for:

- prompt trimming
- tracker defaults
- workspace path resolution
- hook block scalars
- agent concurrency-by-state normalization
- server port defaults
- typed loader and config validation errors
- GitHub issue fixture normalization into the Python issue domain model
- one-tick candidate selection using active/terminal states, blocker checks, dispatch ordering, and concurrency gates

The Elixir YAML parser intentionally covers the existing workflow fixtures only. Replace it with a full YAML library before broadening the Elixir runtime beyond this tracer bullet.

## Candidate Selection Tracer

The candidate-selection tracer uses mocked GitHub GraphQL response fixtures. It loads workflow config, normalizes fixture issues through the GitHub tracker adapter, applies the orchestrator eligibility rules, and reports the issue identifier that would dispatch. It does not poll the live GitHub API or launch Codex workers.

## Workspace Safety Tracer

The workspace tracer takes the selected normalized issue from the fixture-backed candidate-selection path, derives the same sanitized workspace key as Python, validates the normalized path against `workspace.root`, creates or reuses the workspace, and runs lifecycle hooks without launching Codex. Fatal `after_create` and `before_run` hook errors map to retry outcomes; best-effort `after_run` and `before_remove` errors are ignored after logging-equivalent handling.

## Codex App-Server Boundary Spike

The app-server spike is deliberately narrow and HITL-reviewed before hardening.
It launches `codex app-server` for one turn only after
`Workspace.assert_agent_cwd/3` confirms the launch cwd exactly matches the
sanitized per-issue workspace path.

Protocol source of truth:

- Generated JSON Schema bundles live in `docs/generated/codex-app-server/json-schema/`.
- Regenerate them with `codex app-server generate-json-schema --experimental --out docs/generated/codex-app-server/json-schema`.
- `HarnessEngineering.CodexAppServer.Protocol` reads those generated bundles at runtime and rejects client/server method names not present in the generated protocol surface.

Subprocess boundary:

- The spike uses raw Elixir `Port`, not MuonTrap.
- The command runs through `sh -lc <codex.command>` with `Port.open(..., {:cd, workspace_path})` so the OS launch cwd is the issue workspace.
- stdout is reserved for line-delimited JSON-RPC; stderr is not merged into stdout.
- This does not add host-level containment beyond the Codex sandbox settings and the service OS user. Stronger containment, kill semantics, and process-tree cleanup need HITL review before production use.

Policy mapping:

- `item/commandExecution/requestApproval`: `acceptForSession`.
- `item/fileChange/requestApproval`: `acceptForSession`.
- `item/permissions/requestApproval`: empty session-scoped permission grant.
- `item/tool/call`: unsupported, returns `success: false` with an `inputText` explanation.
- `item/tool/requestUserInput` and `mcpServer/elicitation/request`: JSON-RPC error because this harness has no interactive user-input channel.
- `turn/completed` maps to `completed`.
- retryable app-server `error` notifications map to `retry`; non-retryable app-server `error` notifications map to `failed`.

Smoke coverage:

- Default Elixir tests use `test_support/codex_app_server_fixture.exs` to prove JSON-RPC launch, event streaming, policy responses, and terminal mapping without touching the real Codex service.
- The real bounded smoke path is opt-in: `./scripts/smoke-codex-app-server.sh`. It creates a temporary fixture workspace and sends a no-tool prompt to `codex app-server`.
