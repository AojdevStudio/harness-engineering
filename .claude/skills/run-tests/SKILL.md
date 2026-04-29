---
name: run-tests
description: Run the repository's local verification suite for harness-engineering.
allowed-tools: Bash
---

# Run Tests

Use this skill when validating code changes in this repository.

## Steps

1. Run the unit test suite:

   ```bash
   ./scripts/test.sh
   ```

2. Run lint and formatting checks:

   ```bash
   ./scripts/lint.sh
   ```

3. Run type checks:

   ```bash
   ./scripts/typecheck.sh
   ```

4. Report the exact command output and any failures.

Do not skip a failing command. Fix the failure or report the blocker.
