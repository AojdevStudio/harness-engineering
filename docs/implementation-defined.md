---
title: Implementation-Defined Behavior
type: reference
updated: 2026-04-29
---

# Implementation-Defined Symphony Behavior

This file documents choices the draft Symphony spec leaves to implementations.

## Tracker

- Supported `tracker.kind`: `github`.
- Required GitHub config: `tracker.owner`, `tracker.repo`, and `tracker.api_key` or `GITHUB_TOKEN`.
- GitHub issue states are normalized to lowercase (`open`, `closed`).
- GitHub issue blockers can be normalized from fixture `blockedBy` nodes or a `## Blocked by` issue-body section into domain `BlockerRef` values.
- Default active states: `["open"]`.
- Default terminal states: `["closed"]`.
- Linear is intentionally not part of this harness contract. If a team uses Linear, it should sync work into GitHub Issues upstream.

## Workspace Population

- Built-in workspace behavior only creates/reuses a sanitized per-issue directory.
- Repository checkout, dependency bootstrap, and synchronization belong in workflow hooks.
- Existing non-directory paths at a workspace location fail workspace creation.
- Reused workspaces are not destructively reset by the harness.

## Approval And Sandbox Posture

- The Codex app-server client launches `bash -lc <codex.command>` with cwd set to the per-issue workspace.
- `codex.approval_policy`, `codex.thread_sandbox`, and `codex.turn_sandbox_policy` are pass-through values sent to Codex when configured.
- Command execution approval requests are accepted for the session.
- File change approval requests are accepted for the session.
- Additional permission requests receive an empty session-scoped grant.
- User-input-required requests fail instead of stalling indefinitely.
- Unsupported dynamic tool calls return a structured failure response and do not stall the session.

The Elixir app-server spike mirrors this posture with raw `Port` and generated
Codex JSON Schema bundles under `docs/generated/codex-app-server/json-schema/`.
It validates client and server JSON-RPC method names against those generated
schemas before sending requests or answering app-server requests. The spike is
not yet a hardened containment layer; process-tree cleanup and MuonTrap or
equivalent supervision are intentionally left for HITL review.

This is a high-trust local harness posture. Operators that need stronger isolation should run the service under a restricted OS user and combine Codex sandbox settings with host-level controls.

## Runtime And Recovery

- Orchestrator state is in memory.
- Retry timers and live Codex sessions are not restored after process restart.
- Restart recovery is tracker-driven and filesystem-driven: terminal workspace cleanup runs at startup, then active GitHub issues are polled again.
- Invalid `WORKFLOW.md` reloads do not crash the service; the last known good workflow remains active.

## Observability

- Structured logs are emitted through Python logging.
- The optional HTTP extension binds loopback by default.
- `server.port` enables the HTTP extension; CLI `--port` overrides it.
- HTTP listener config changes require restart.
