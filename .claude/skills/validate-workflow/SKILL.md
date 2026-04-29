---
name: validate-workflow
description: Validate a WORKFLOW.md file with the harness loader and typed config layer.
allowed-tools: Bash, Read
---

# Validate Workflow

Use this skill before changing workflow examples or debugging workflow config.

## Steps

1. Choose the workflow path. Default to `WORKFLOW.example.md` if the user does not name one.
2. Run:

   ```bash
   ./scripts/validate-workflow.sh WORKFLOW.example.md
   ```

3. If validation fails, inspect the workflow front matter first, then the typed config layer.
4. Do not print real token values. Use placeholder env values for validation.
