# API Documentation Policy

Symphony uses TSDoc/JSDoc for exported APIs that form package, app, runner, tracker, workspace, and orchestration boundaries.

The policy is intentionally contract-focused. The goal is to help a future operator or coding agent understand how to use an exported API safely without reading the full implementation first.

## What Must Be Documented

Document these exported symbols unless they are marked `@internal`:

- classes
- interfaces
- functions
- type aliases and unions
- methods
- non-obvious exported constants or properties

Prioritize exported APIs from package entrypoints under `packages/*/src/index.ts` and app entrypoints under `apps/*/src/index.ts`.

## What The Comment Should Say

A useful TSDoc/JSDoc comment explains at least one contract-level detail:

- ownership: what capability or boundary the API represents
- inputs: what callers must provide beyond what the type already says
- side effects: database, filesystem, Git, GitHub, Linear, runner, or network writes
- lifecycle behavior: state transitions, retries, claims, cleanup, or handoff semantics
- error behavior: thrown errors, returned failures, and best-effort behavior
- safety constraints: path safety, auth, branch safety, evidence integrity, or concurrency assumptions

## What To Avoid

Do not add comments that only restate the name or type:

```ts
/** Creates a run. */
export function createRun(...) {}
```

Prefer:

```ts
/**
 * Creates the durable run record for a claimed issue.
 *
 * The caller must already own the claim; this function does not perform
 * tracker writes or workspace setup.
 */
export function createRun(...) {}
```

## Internal APIs

Use `@internal` for exported symbols that are exported only for tests, package-local composition, or current TypeScript module boundaries. Internal symbols are excluded from generated docs.

```ts
/**
 * Normalizes runner transcript markers into structured follow-up items.
 *
 * @internal
 */
export function parseFollowUpsFromTranscript(...) {}
```

## Commands

Generate API docs:

```bash
bun run docs:api
```

Validate TypeDoc configuration without writing docs:

```bash
bun run docs:api:check
```

Regenerate the missing-docs backlog:

```bash
bun run docs:api:report
```

Run the future strict gate locally:

```bash
bun run docs:api:strict
```

`docs:api:strict` is expected to fail until the rollout plan closes the missing-docs baseline.

## Rollout Plan

1. Add this policy, ADR, TypeDoc config, and baseline report.
2. Document `packages/core`, `packages/workflow`, and `packages/runner`.
3. Document `packages/workspace-git`, `packages/tracker-linear`, `packages/evidence`, and `packages/db`.
4. Document `packages/orchestrator`.
5. Document app-level public APIs where they remain exported.
6. Turn missing-doc validation into a CI gate once the baseline is clean enough.
