---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "REPLACE_WITH_LINEAR_PROJECT_SLUG"
  active_states:
    - Todo
    - In Progress
    - Rework
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 30000
workspace:
  root: ./.symphony/workspaces
hooks:
  after_create: |
    bun install
  after_run: |
    bun run verify
  timeout_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 20
codex:
  command: codex exec --skip-git-repo-check --sandbox workspace-write -
  turn_timeout_ms: 3600000
server:
  host: 127.0.0.1
  port: 7331
states:
  in_progress: In Progress
  human_review: Human Review
  rework: Rework
  merging: Merging
  done: Done
evidence:
  ui:
    required_for_labels:
      - ui
      - frontend
      - browser
    command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR" --issue "$SYMPHONY_ISSUE_IDENTIFIER"
    required_artifacts:
      - kind: video
        glob: "*.webm"
      - kind: screenshot
        glob: "*.png"
      - kind: test-output
        glob: "*.txt"
---

You are working on Linear issue {{ issue.identifier }}.

Title: {{ issue.title }}
State: {{ issue.state }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Rules:

- Work only in this workspace.
- Reproduce or inspect current behavior before editing.
- Implement the issue completely.
- Run validation before handoff.
- Commit your changes.
- Produce concise evidence in stdout/stderr or artifact files.
- Do not ask the human for follow-up unless blocked by missing credentials, permissions, or required secrets.
