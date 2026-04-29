#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Finding:
    persona: str
    severity: str
    path: str
    message: str


def changed_files(base: str) -> list[Path]:
    result = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...HEAD"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        result = subprocess.run(["git", "diff", "--name-only"], cwd=ROOT, text=True, capture_output=True, check=True)
    return [ROOT / line for line in result.stdout.splitlines() if line]


def review_file(path: Path) -> list[Finding]:
    rel = path.relative_to(ROOT).as_posix()
    if not path.exists() or path.is_dir():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []

    findings: list[Finding] = []
    if "GITHUB_TOKEN" in text and "print(" in text:
        findings.append(
            Finding(
                "security",
                "warning",
                rel,
                "Do not print token-bearing values. Validate secret presence only; see rules/workflow-contract.md.",
            )
        )
    if "subprocess.Popen" in text and "cwd=" not in text:
        findings.append(
            Finding(
                "reliability",
                "blocker",
                rel,
                "Subprocess launch must set an explicit cwd so worker execution cannot drift; see rules/workspace-safety.md.",
            )
        )
    if rel.startswith("src/harness_engineering/") and "harness_engineering.service" in text:
        findings.append(
            Finding(
                "architecture",
                "blocker",
                rel,
                "Lower-level modules must not import service.py. Move shared contracts down or inject callbacks; see rules/architecture.md.",
            )
        )
    if rel.endswith(".md") and "TODO" in text:
        findings.append(
            Finding(
                "harness",
                "warning",
                rel,
                "Replace TODOs in committed docs with an issue reference so GitHub remains the control plane.",
            )
        )
    return findings


def render(findings: list[Finding]) -> str:
    lines = ["# Harness PR Review", ""]
    if not findings:
        lines.append("No blocker findings from reliability, security, architecture, or harness personas.")
        return "\n".join(lines)
    for finding in findings:
        lines.append(f"- **{finding.severity.upper()} / {finding.persona}** `{finding.path}`: {finding.message}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deterministic harness PR review personas.")
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    findings: list[Finding] = []
    for path in changed_files(args.base):
        findings.extend(review_file(path))

    report = render(findings)
    if args.output:
        Path(args.output).write_text(report + "\n", encoding="utf-8")
    else:
        print(report)

    return 1 if any(finding.severity == "blocker" for finding in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
