---
tracker:
  kind: github
  owner: AojdevStudio
  repo: harness-engineering
  api_key: $GITHUB_TOKEN
  active_states:
    - open
  terminal_states:
    - closed

polling:
  interval_ms: 30000

workspace:
  root: .symphony/workspaces

hooks:
  timeout_ms: 60000
  after_create: |
    git clone https://github.com/AojdevStudio/harness-engineering.git .
  before_run: |
    git fetch origin

agent:
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    open: 1

codex:
  driver: app-server
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

server:
  port: 0
---
# Task

You are working on GitHub issue {{ issue.identifier }}.

Title: {{ issue.title }}

Description:

{{ issue.description }}

Labels:
{% for label in issue.labels %}- {{ label }}
{% endfor %}

Follow the repository's `AGENTS.md` and `WORKFLOW.md`. Work only inside the current per-issue workspace. When the implementation is ready, validate it, open a pull request, and comment back on the GitHub issue with the PR link and verification results.

Use a branch name that starts with `issue-<issue-number>-`, where `<issue-number>` is the number after `#` in `issue.identifier`.

After the pull request is open and the issue has a PR link plus verification summary, close the GitHub issue as the handoff state. If you cannot open the PR or the PR cannot be made mergeable, leave or reopen the issue with a clear failure comment instead of closing it.
