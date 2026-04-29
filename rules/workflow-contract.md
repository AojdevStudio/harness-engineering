# Workflow Contract Rules

## Loading

Do parse YAML front matter as an optional root map and treat the markdown body as the prompt template.

Do not silently fall back when the workflow file is missing or malformed.

Reason: workflow parse errors are operator-visible configuration failures, not agent tasks.

## Dynamic Reload

Do keep the last known good workflow active when reload validation fails.

Do not crash the daemon on invalid edits to `WORKFLOW.md`.

Reason: operators need to fix policy without killing in-flight work.

## Secrets

Do resolve `$VAR_NAME` only for fields that explicitly support env indirection.

Do not globally override YAML values from environment variables.

Do not log token values.

Reason: explicit indirection keeps the workflow file auditable and avoids accidental secret disclosure.

## Prompt Rendering

Do fail on unknown prompt variables or filters.

Do not render templates with permissive missing-variable behavior.

Reason: a typo in a workflow prompt should fail one attempt clearly, not send a misleading task to Codex.
