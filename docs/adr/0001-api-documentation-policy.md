# ADR 0001: API Documentation Policy

## Status

Accepted

## Context

Symphony exposes several TypeScript packages that agents and operators use as architectural boundaries. CodeRabbit surfaced that the repo has effectively no docstring coverage, but a blanket "comment everything" rule would create noisy comments without improving maintainability.

The useful goal is not a raw percentage. The useful goal is that exported APIs explain the contract, side effects, error behavior, and operational assumptions that are hard to infer from type signatures alone.

## Decision

Symphony will use TSDoc/JSDoc comments for exported package APIs and public app entrypoints. Documentation is required for exported classes, interfaces, functions, type aliases, methods, and non-obvious properties unless the symbol is marked `@internal`.

Documentation comments should explain contract-level behavior:

- what the API owns or coordinates
- side effects such as Git, database, filesystem, tracker, or network writes
- error and retry behavior
- security or path-safety assumptions
- lifecycle state transitions

Documentation comments should not restate obvious type names or implementation details. If a comment would only say "returns the result", do not add it; improve the name or leave the symbol for a later policy exception.

## Consequences

- TypeDoc is the source of truth for API documentation generation and validation.
- `bun run docs:api:report` produces the missing-docs backlog used for documentation waves.
- `bun run docs:api:check` is non-blocking for missing docs while the baseline is high.
- `bun run docs:api:strict` is the future CI gate and is expected to fail until the documentation waves close the baseline.
- Once the exported API surface is documented in waves, documentation validation can be made blocking in CI.
- Future harness audits should flag repos that expose package/module APIs without an API documentation policy, ADR, or missing-docs report.
