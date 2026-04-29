#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GC_WORKFLOW = ROOT / ".github" / "workflows" / "harness-gc.yml"


def main() -> int:
    failures: list[str] = []

    if not GC_WORKFLOW.exists():
        failures.append(f"{GC_WORKFLOW}: missing harness GC workflow")
    else:
        text = GC_WORKFLOW.read_text(encoding="utf-8")
        requirements = {
            "workflow_dispatch:": "GC must stay manually triggerable for issue-driven review.",
            "GITHUB_STEP_SUMMARY": "GC output must be visible for human review on every run.",
            "steps.knowledge.outputs.output": "The reviewed summary must include the scanner output, not just pass/fail status.",
            "--label agent-slop": "Drift detected by GC must enter the agent-slop loop.",
        }
        for needle, reason in requirements.items():
            if needle not in text:
                failures.append(f"{GC_WORKFLOW}: missing {needle!r}. {reason}")

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("github workflow lint ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
