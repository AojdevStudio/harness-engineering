---
title: Architecture
type: design
updated: 2026-04-29
---

# Architecture

The service is split into layers that keep policy, coordination, execution, integration, and observability separate.

## Layers

1. Domain contracts: `models.py`
2. Workflow loading: `workflow.py`
3. Typed config and prompt rendering: `config.py`, `prompt.py`
4. Workspace and tracker integration: `workspace.py`, `github_tracker.py`
5. Coordination and observability state: `orchestrator.py`, `http_server.py`
6. Codex app-server boundary: `agent.py`
7. Attempt orchestration: `runner.py`
8. Host lifecycle: `service.py`, `cli.py`

`scripts/lint-architecture.py` enforces this dependency direction. When a lower layer needs higher-level behavior, pass an interface or callback downward from `service.py` or `runner.py`.

## Control Plane

GitHub Issues are the executable work queue. Linear can mirror issues upstream, but Linear-specific logic must not leak into scheduler or runner code.

## Policy Plane

`WORKFLOW.md` is the worker policy contract. Runtime code loads it, validates it, and renders prompts from it. Runtime code must not inline team-specific issue handling policy.
