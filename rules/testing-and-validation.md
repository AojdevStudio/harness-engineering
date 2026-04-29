# Testing And Validation Rules

## Required Commands

Run these before claiming an implementation is ready:

```bash
./scripts/test.sh
./scripts/lint.sh
./scripts/typecheck.sh
./scripts/validate-workflow.sh WORKFLOW.example.md
uv run pre-commit run --all-files
```

## Failure Handling

Do fix the code or configuration when a verification command fails.

Do not weaken tests, remove lint rules, or skip checks to make a failure disappear.

Reason: these commands are the local feedback loop agents rely on before pushing work to GitHub.

## Test Shape

Do keep tests deterministic and local by default.

Do mark real tracker/Codex integration tests separately when they require credentials or live subprocesses.

Reason: the default test command must be safe for every agent to run in a fresh clone.

## Garbage Collection Review

Do make manually triggered GC runs publish a human-readable summary with the scanner output.

Do not hide GC results only in action outputs or downstream issue bodies.

Reason: the agent-slop loop depends on a reviewer seeing exactly what drift was scanned before deciding whether to create or close a permanent harness artifact.
