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
  review_settle_ms: 240000
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
# PR self-review is opt-in. The command runs after PR creation and before Human Review.
# review:
#   self:
#     command: bun run review:pr -- --pr "$SYMPHONY_PR_URL"
#     timeout_ms: 600000
#     blocking_severities:
#       - P0
#       - P1
#       - P2
# UI evidence is opt-in. Uncomment this block after the target repo has an evidence script.
# evidence:
#   ui:
#     required_for_labels:
#       - ui
#       - frontend
#       - browser
#     command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR" --issue "$SYMPHONY_ISSUE_IDENTIFIER"
#     required_artifacts:
#       - kind: video
#         glob: "*.webm"
#       - kind: screenshot
#         glob: "*.png"
#       - kind: test-output
#         glob: "*.txt"
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
- At the very end of your final assistant message, include these optional marker blocks only when they have content.
- Use the `unverified` block for checks you could not perform, and the `next-time` block for concrete follow-up work the next agent should pick up.
- Omit a marker block entirely when it would be empty; do not emit empty marker blocks.

Optional final-message marker format:

```
<!-- unverified -->
- <one bullet per thing you did NOT verify>
<!-- /unverified -->

<!-- next-time -->
- <one bullet per follow-up the next agent should pick up>
<!-- /next-time -->
```
