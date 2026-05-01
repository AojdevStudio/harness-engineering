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

The Elixir YAML parser intentionally covers the existing workflow fixtures only. Replace it with a full YAML library before broadening the Elixir runtime beyond this tracer bullet.

## Sandcastle-Level Parity Targets

The Sandcastle-level roadmap does not change the port rule: Python remains the oracle until an explicit port-readiness decision is made.

Future Elixir parity work should follow these behavior targets in order:

1. **Worker Session**
   - Model issue plus workspace as the durable session identity.
   - Do not use branch, worktree, container, or remote host identity as the scheduler key.

2. **Agent Attempt**
   - Represent disposable attempts inside a Worker Session.
   - Preserve attempt number, reason, status, timestamps, error, and handoff reason fields.

3. **Worker Session Journal**
   - Read and write the same append-only JSONL event shape as Python.
   - Treat journal data as evidence/history only, not as restored live scheduler authority.
   - Tolerate missing files, malformed lines, and partial writes.

4. **Execution Strategy**
   - Start with a `plain_workspace` strategy that preserves Python behavior.
   - Add git worktree branch behavior only after the Python strategy and fixtures are stable.

Do not introduce a second Elixir scheduler while these parity targets are being added. Each Elixir slice should compare against Python-backed fixtures before runtime behavior is broadened.
