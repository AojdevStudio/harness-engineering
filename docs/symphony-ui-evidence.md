# Symphony UI Evidence Contract

Status: implemented for workflow config, orchestrator capture, artifact registration, fail/retry gating, and a real Playwright CLI smoke test. Target repos still need to provide their own Playwright evidence scripts.

## Why this exists

The Codex/Symphony reference discussion frames video evidence as trust compression: humans should not shoulder-surf an agent's full session, but the agent/orchestrator should attach proof that makes the final change reviewable.

For Symphony, UI evidence is required proof for browser-facing tickets before handoff.

## Decisions

1. **Scope:** require browser evidence for UI/browser tickets only.
2. **Owner:** Symphony orchestrator owns the required evidence capture gate.
3. **Repo contract:** use a repo-local script plus `WORKFLOW.md` declaration.
4. **Required artifacts for UI tickets:**
   - Playwright video
   - final-state screenshot
   - validation/test output
5. **Failure policy:** if required evidence capture fails, the run fails and enters normal retry/backoff.

## Target repo responsibility

The target repo should own app-specific details:

- how to start the app
- seed/test account setup
- login flow
- stable route(s) to inspect
- Playwright selectors
- teardown/cleanup

Recommended script shape:

```bash
bun run evidence:ui -- --output "$SYMPHONY_EVIDENCE_DIR" --issue "$SYMPHONY_ISSUE_IDENTIFIER"
```

The script must write artifacts to `$SYMPHONY_EVIDENCE_DIR`, for example:

```text
$SYMPHONY_EVIDENCE_DIR/
  ui-proof.webm
  final-state.png
  playwright-output.txt
```

## Symphony responsibility

Symphony should:

1. Detect whether evidence is required for the ticket.
2. Run the configured evidence command after agent execution and before success.
3. Collect produced video/screenshot/test-output artifacts.
4. Store artifacts in the evidence registry.
5. Surface artifacts in dashboard and run detail API.
6. Include evidence links in Linear workpad/PR handoff.
7. Fail/retry the run if required artifacts are missing.

## `WORKFLOW.md` shape

```yaml
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
```

## Harness-audit impact

For Symphony readiness, harness-audit should mark UI/browser repos incomplete unless they document or implement:

- Playwright or equivalent browser evidence command
- how to launch the app for evidence capture
- where video/screenshot/test output is written
- which ticket labels trigger UI evidence
- failure behavior when evidence cannot be captured

## Real smoke test

Run:

```bash
bun run smoke:ui-evidence
```

This creates a disposable fake UI workspace, simulates an agent editing `fake-app.html`, runs the configured Symphony evidence gate, invokes the real Playwright CLI, records a browser video, captures a final screenshot, writes Playwright output, registers all artifacts, and requires the Symphony run to reach `succeeded`.

Expected proof is copied to a predictable repo-local folder:

```text
.symphony/smoke-runs/ui-evidence/latest/
  ui-proof.webm
  final-state.png
  playwright-output.txt
  result.json
```

`playwright-output.txt` should contain `1 passed`.

If Playwright browsers are missing, install Chromium once:

```bash
bunx playwright install chromium
```

## Non-goals for V1

- Recording the entire agent coding session.
- Auto-generating Playwright scripts from ticket text.
- Requiring video for backend/docs/tooling tickets.
- Publishing videos to third-party storage by default.
