# Symphony Dogfood Runbook

Use this when you are ready to run Symphony against a real repo and a real Linear ticket.

## 0. Pick the target repo

Choose a repo where Symphony is allowed to create branches, commit, push, and open PRs.

Minimum requirements:

- `AGENTS.md` or equivalent agent instructions
- deterministic install command
- deterministic test/smoke command under ~5 minutes
- no mandatory secrets for basic validation
- GitHub remote push access via `gh`
- Linear ticket with narrow acceptance criteria

## 1. Run harness audit first

Before dogfooding Symphony, audit the target repo for unattended-agent readiness.

From the target repo:

```bash
cd /path/to/target-repo
```

Ask Pi:

```text
Run harness-audit on this repo and patch only the P0/P1 readiness gaps.
```

The audit should check:

- cold-start docs
- exact install/test/lint commands
- agent rules in `AGENTS.md`
- smoke test availability
- env/secrets documentation
- repo structure clarity
- pre-commit or validation guardrails
- PR/review handoff readiness

Patch only blockers before Symphony dogfood. Do not turn this into a full repo cleanup.

## 2. Create a tiny Linear smoke ticket

Use a safe ticket that proves orchestration, not product complexity.

Good examples:

- add one missing smoke test
- fix one typo plus validation
- add one small docs clarification
- add one simple assertion
- clean one obvious lint issue

Bad examples:

- large feature work
- migrations
- auth/payment changes
- anything requiring production secrets
- broad refactors

The ticket should include exact acceptance criteria and the expected validation command.

## 3. Create `WORKFLOW.md` in Symphony

From the Symphony repo:

```bash
cd /Users/ossieirondi/Projects/agents/ship-more/harness-building
cp WORKFLOW.example.md WORKFLOW.md
```

Edit the key fields:

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: YOUR_LINEAR_PROJECT_SLUG
  active_states: [Todo]
  terminal_states: [Done, Closed, Canceled, Cancelled, Duplicate]

workspace:
  mode: worktree
  root: /tmp/symphony-workspaces
  source_repo: /path/to/target-repo

hooks:
  after_create: bun install
  after_run: bun test

evidence:
  ui:
    required_for_labels: [ui, frontend, browser]
    command: bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR" --issue "$SYMPHONY_ISSUE_IDENTIFIER"
    required_artifacts:
      - kind: video
        glob: "*.webm"
      - kind: screenshot
        glob: "*.png"
      - kind: test-output
        glob: "*.txt"

codex:
  command: "codex exec --skip-git-repo-check --sandbox workspace-write -"

states:
  in_progress: In Progress
  human_review: In Review
  rework: Rework
  merging: Merging
  done: Done
```

For Pi runner instead of Codex:

```yaml
runner:
  kind: pi
```

and set:

```bash
export SYMPHONY_PI_COMMAND="pi --print"
```

## 4. Validate the workflow

First run local config validation:

```bash
bun run symphony validate WORKFLOW.md
```

Then run live Linear preflight:

```bash
bun run symphony validate WORKFLOW.md --live-tracker
```

Live preflight verifies:

- `LINEAR_API_KEY` works
- `tracker.project_slug` exists
- every configured active/terminal/lifecycle state exists in the Linear project team

Expected result has:

```json
{
  "dispatchReady": true,
  "dispatchErrors": [],
  "liveTracker": {
    "ok": true,
    "missingStates": []
  }
}
```

Fix all local or live validation errors before running a ticket.

## 5. Run one ticket once

```bash
bun run symphony tick WORKFLOW.md
```

Expected flow:

1. Fetch eligible Linear ticket from `active_states`.
2. Claim ticket in SQLite.
3. Move Linear ticket to `In Progress`.
4. Prepare git workspace.
5. Run Codex or Pi.
6. Run `hooks.after_run` validation.
7. For UI/browser-labeled tickets, run the configured evidence command and require video/screenshot/test-output artifacts.
8. Push branch and create PR if PR config is enabled.
9. Move Linear ticket to `In Review`.
10. Write Symphony workpad comment.
11. Persist events/evidence/token data locally.
12. On later ticks, poll `Human Review`/`Merging` PRs:
    - P0/P1/P2 review findings or failing checks move the ticket to `Rework` and respawn the agent with the feedback in its prompt.
    - Clean, passing, approved PRs move through `Merging`, merge, and then move the ticket to `Done`.

## 6. Run the dashboard/control plane

```bash
export SYMPHONY_AUTH_TOKEN="$(openssl rand -hex 24)"
bun run symphony serve WORKFLOW.md
```

Dashboard:

```text
http://localhost:7331
```

Authenticated API check:

```bash
curl -H "Authorization: Bearer $SYMPHONY_AUTH_TOKEN" \
  http://localhost:7331/api/v1/state
```

## 7. First real dogfood command

Once `WORKFLOW.md` is ready:

```bash
bun run symphony validate WORKFLOW.md --live-tracker && bun run symphony tick WORKFLOW.md
```

## 8. Stop conditions

Stop and inspect before retrying if:

- validation fails
- workspace setup fails
- Linear state updates fail
- runner exits non-zero
- generated branch has unrelated changes
- PR creation fails
- dashboard event log lacks enough evidence to explain the run

Do not keep polling blindly until one manual tick has completed cleanly.
