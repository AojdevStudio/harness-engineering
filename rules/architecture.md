# Architecture Rules

## Dependency Direction

Do keep imports flowing from runtime modules toward lower-level contracts.

Layer order:

1. `models`
2. `workflow`
3. `config`, `prompt`
4. `workspace`, `github_tracker`
5. `orchestrator`, `http_server`
6. `agent`
7. `runner`
8. `service`, `cli`

Do not import higher-level runtime modules from lower-level modules. If a lower layer needs behavior from a higher layer, pass it in as a callback or interface from `service` or `runner`.

Reason: Symphony workers depend on clear seams. Upward imports make isolated tests brittle and make future tracker/runner adapters harder to add.

## Policy Boundary

Do keep team workflow policy in `WORKFLOW.md` and `rules/`.

Do not hard-code workflow instructions, ticket transition policy, or team-specific handoff language in Python orchestration modules.

Reason: `WORKFLOW.md` travels with the target repo and is the versioned contract a worker reads at runtime.

## Tracker Boundary

Do keep tracker transport and payload normalization inside adapter modules such as `github_tracker.py`.

Do not let GraphQL response shapes leak into orchestrator decisions.

Reason: the orchestrator should schedule normalized `Issue` objects, not vendor payloads.
