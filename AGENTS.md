
Open-source implementation of OpenAI's Symphony spec for Codex orchestration. Other reference impls exist in several languages; this repo's contribution is its choice of control plane and workspace model.

The mantra: models commoditize, harnesses don't.

## First Build

GitHub-as-control-plane dispatch for Codex with per-issue workspace isolation. The agent reads work from GitHub Issues, runs in an isolated per-issue workspace, and reports back via PRs and comments.

## Architecture Anchors

- **GitHub is the source of truth** for the harness. Issues, PRs, and comments are the canonical surface Codex reads from and writes to. A Linear→GitHub sync runs upstream as a team workflow detail — it is not part of the harness contract and should not leak into orchestration logic.
- **`WORKFLOW.md` travels with the repo.** It is the policy contract a Codex worker reads on entry to a workspace. Orchestration code must not inline policy that belongs in `WORKFLOW.md`; treat the file as load-bearing.
- **Per-issue workspace isolation.** Each dispatched issue gets its own workspace. No shared mutable state between workspaces. 
