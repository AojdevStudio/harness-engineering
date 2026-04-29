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
