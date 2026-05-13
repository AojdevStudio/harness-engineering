# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

## [0.2.0] - 2026-05-13

### Added

- TypeScript/Bun Symphony monorepo with package boundaries for workflow parsing, core domain types, SQLite state, Linear tracking, Git workspaces, runner adapters, evidence storage, and orchestration.
- First-run operator UX: README quick start, `.env.example`, `symphony init`, and `symphony doctor`.
- Linear-backed unattended ticket lifecycle from candidate issue polling through worktree creation, Codex/Pi runner execution, validation, evidence capture, PR handoff, self-review, review reconciliation, merge, and Done transition.
- Token-protected local control plane with runs, events, evidence, health, and guarded control actions.
- Operator dashboard SPA for inspecting runs, event timelines, evidence artifacts, health, and controls.
- Dogfood runbook, UI evidence guidance, build plan, and original-checkout retirement notes.
- Preserved Symphony visual assets under `assets/`.

### Changed

- Promoted the Symphony TypeScript implementation as the release line for the repository.
- Retired the earlier Python/Elixir harness experiments from the release tree while keeping the behavioral and planning context in docs.
- Bumped all Symphony workspace packages to `0.2.0`.

### Fixed

- Hardened PR self-review follow-up parsing so echoed marker examples do not pollute Linear handoff comments.
- Made GitHub PR merge handling idempotent when the PR merges successfully but branch cleanup returns a non-zero `gh pr merge` exit.
- Added regression coverage for the dogfood-discovered PR lifecycle edge cases.

## [0.1.1] - 2026-05-05

### Added

- feat(orchestrator): add PR review rework and merge loop
- ✨ feat(orchestrator): add poll/dispatch/run/handoff orchestration loop
- ✅ test(scripts): add UI evidence and Linear dogfood smoke runners
- ✨ feat(dashboard): scaffold dashboard app stub
- ✨ feat(server): add control plane HTTP API
- ✨ feat(cli): add symphony CLI entrypoint
- ✨ feat(evidence): add evidence artifact storage
- ✨ feat(runner): add shell-based Codex and Pi runner adapters
- ✨ feat(workspace-git): add safe git worktree manager and PR helpers
- ✨ feat(tracker-linear): add Linear GraphQL client and issue adapter
- ✨ feat(db): add SQLite schema, migrations, run records, and event log
- ✨ feat(workflow): add WORKFLOW.md parser, config resolver, prompt renderer
- ✨ feat(core): add orchestration domain types and state machine primitives
- 📝 docs: add Symphony build plan, dogfood runbook, UI evidence spec
- 📝 docs: add agent brief and example WORKFLOW.md

### Changed

- Initial commit

## [0.1.0] - 2026-04-28

### Added

- ✨ feat(core): implement GitHub Symphony harness

### Changed

- Initial commit

## Links
[Unreleased]: https://github.com/AojdevStudio/harness-engineering/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/AojdevStudio/harness-engineering/releases/tag/v0.2.0
[0.1.1]: https://github.com/AojdevStudio/harness-engineering/releases/tag/v0.1.1
[0.1.0]: https://github.com/AojdevStudio/harness-engineering/releases/tag/v0.1.0
