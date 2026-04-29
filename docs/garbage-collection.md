---
title: Harness Garbage Collection
type: operating-procedure
updated: 2026-04-29
---

# Harness Garbage Collection

Run this cadence weekly, preferably Friday afternoon local time.

## Inputs

- Open GitHub issues labeled `agent-slop`
- Recent PR review comments
- Failed CI runs
- Repeated local verification failures
- Operator notes about confusing docs, missing rules, or fragile skills

## Output

Every recurring failure must become one of:

- a rule in `rules/`
- a lint or structural check in `scripts/`
- a regression test in `tests/`
- a repo-local skill in `.claude/skills/`
- a corrected issue template or workflow prompt

## GitHub Action

`.github/workflows/harness-gc.yml` runs weekly and can be triggered manually. It runs knowledge linting, publishes the reviewed scanner output to the workflow summary, and opens an `agent-slop` issue when committed docs drift from the expected structure.

## Human Review

For each GC pass:

1. Review new `agent-slop` issues.
2. Decide whether the fix belongs in a rule, lint, test, or skill.
3. Keep changes small and reviewable.
4. Close the issue only after the permanent harness artifact lands.
