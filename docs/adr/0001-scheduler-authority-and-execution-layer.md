---
title: Scheduler Authority And Execution Layer
type: adr
updated: 2026-04-30
status: accepted
---

# Scheduler Authority And Execution Layer

The Symphony Harness remains the authoritative daemonized scheduler for polling, claims, retries, reconciliation, workflow reloads, and operator-visible state. Sandcastle is treated as a source of execution-layer patterns rather than a replacement control plane: worker-side sandbox, worktree, provider, implement/review, and merge capabilities belong under a harness-owned Worker Session.

**Consequences:** Branch/worktree behavior is modeled as an Execution Strategy, not as scheduler identity. Future Sandcastle-inspired features should preserve the harness control-plane boundary instead of moving issue selection, retry decisions, or handoff semantics into ad hoc workflow scripts.
