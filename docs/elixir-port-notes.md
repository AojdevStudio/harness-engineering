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
