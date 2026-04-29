---
title: Golden Principles
type: standard
updated: 2026-04-29
---

# Golden Principles

These are mechanical principles for preventing agent-driven entropy. Each principle should become enforceable through tests, lint, or review automation.

## Preserve Workspace Isolation

Codex must run only inside the sanitized per-issue workspace path.

Enforced by: `WorkspaceManager.assert_agent_cwd`, workspace tests, `rules/workspace-safety.md`.

## Keep Policy In Workflow Files

Team-specific task handling belongs in `WORKFLOW.md`, issue templates, and rules docs.

Enforced by: code review and `rules/workflow-contract.md`.

## Normalize External Payloads At The Edge

Tracker payloads must become `Issue` objects before orchestration decisions inspect them.

Enforced by: GitHub tracker tests and `rules/architecture.md`.

## Fail Fast On Invalid Configuration

Startup validation should fail clearly, while invalid dynamic reloads keep the last known good config alive.

Enforced by: workflow/config tests.

## Make Verification Scriptable

Every permanent rule should have a command that an agent can run locally or in CI.

Enforced by: `scripts/test.sh`, `scripts/lint.sh`, `scripts/typecheck.sh`, `scripts/validate-workflow.sh`, and CI.
