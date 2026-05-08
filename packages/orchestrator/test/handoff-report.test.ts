import { describe, expect, test } from "bun:test";
import { buildLinearComment, buildPrBody, type HandoffReportInput } from "../src/handoff-report.ts";

const baseInput: HandoffReportInput = {
  issue: {
    identifier: "ABC-1",
    title: "Do work",
  },
  run: {
    runId: "run_abc123",
  },
  result: {
    runner: "codex",
    prTitle: "ABC-1: Do work",
    prUrl: "https://github.test/pr/1",
    checksStatus: "passing",
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  },
  commits: [
    { sha: "aaa111", subject: "feat: first commit", body: "" },
    { sha: "bbb222", subject: "test: add coverage", body: "" },
  ],
  files: [
    { path: "src/foo.ts", status: "M" },
    { path: "src/bar.ts", status: "A" },
  ],
  diffstat: { filesChanged: 2, insertions: 42, deletions: 7 },
};

const expectedPrBody = `## Summary
- feat: first commit
- test: add coverage
- files changed: 2 | +42 / -7

## Linked issues
Closes ABC-1

## Verification
_Captured in a follow-up slice (#TBD)._

---
<details><summary>Run metadata</summary>

runner: codex · runId: run_abc123 · tokens in/out: 100/50

</details>`;

const expectedLinearComment = `## ABC-1 — Symphony run report

**PR:** [ABC-1: Do work](https://github.test/pr/1) (status: passing)

**Files touched (2):**
- src/foo.ts
- src/bar.ts

**Verification**
_Captured in #TBD._

---
runner: codex · runId: run_abc123 · tokens in/out: 100/50`;

describe("buildPrBody", () => {
  test("matches the MVP golden output", () => {
    expect(buildPrBody(baseInput)).toBe(expectedPrBody);
  });

  test("mirrors bare template sections and appends missing Symphony sections", () => {
    const body = buildPrBody({
      ...baseInput,
      prTemplate: {
        raw: "",
        sections: [
          { header: "Description", body: "Describe the change." },
          { header: "Testing", body: "- [ ] Manual test" },
        ],
      },
    });

    expect(body).toContain("## Description\n- feat: first commit\n- test: add coverage\n- files changed: 2 | +42 / -7");
    expect(body).toContain("## Testing\n_Captured in a follow-up slice (#TBD)._");
    expect(body).toContain("## Linked issues\nCloses ABC-1");
    expect(body).not.toContain("Describe the change.");
  });

  test("places linked issues inside a template Linked issues section", () => {
    const body = buildPrBody({
      ...baseInput,
      prTemplate: {
        raw: "",
        sections: [
          { header: "Linked issues", body: "- [ ] No issue required" },
        ],
      },
    });

    expect(body).toContain("## Linked issues\nCloses ABC-1");
    expect(body.match(/## Linked issues/g)).toHaveLength(1);
    expect(body).not.toContain("- [ ] No issue required");
  });

  test("renders tracker and GitHub issue links together", () => {
    const body = buildPrBody({
      ...baseInput,
      issueLink: {
        trackerKeyword: "Closes ABC-1",
        githubKeyword: "Closes #123",
        source: "branch",
      },
    });

    expect(body).toContain("## Linked issues\nCloses ABC-1\nCloses #123");
  });

  test("renders checked no-issue template line when selected", () => {
    const body = buildPrBody({
      ...baseInput,
      prTemplate: {
        raw: "## Linked issues\n- [ ] No issue required (internal cleanup)\n",
        sections: [{ header: "Linked issues", body: "- [ ] No issue required (internal cleanup)" }],
      },
      issueLink: {
        trackerKeyword: "Closes ABC-1",
        noIssueChecked: true,
        source: "no-issue",
      },
    });

    expect(body).toContain("## Linked issues\nCloses ABC-1\n- [x] No issue required (internal cleanup)");
  });

  test("preserves unmatched template sections", () => {
    const body = buildPrBody({
      ...baseInput,
      prTemplate: {
        raw: "",
        sections: [
          { header: "Risk", body: "Keep this section." },
        ],
      },
    });

    expect(body).toContain("## Risk\nKeep this section.");
    expect(body).toContain("## Summary");
    expect(body).toContain("## Linked issues");
    expect(body).toContain("## Verification");
  });

  test("includes Summary section with commit subjects and diffstat", () => {
    const body = buildPrBody(baseInput);
    expect(body).toContain("## Summary");
    expect(body).toContain("- feat: first commit");
    expect(body).toContain("- test: add coverage");
    expect(body).toContain("files changed: 2 | +42 / -7");
  });

  test("includes Linked issues section with Closes ${identifier} verbatim", () => {
    const body = buildPrBody(baseInput);
    expect(body).toContain("## Linked issues");
    expect(body).toContain("Closes ABC-1");
  });

  test("includes Verification section with follow-up placeholder", () => {
    const body = buildPrBody(baseInput);
    expect(body).toContain("## Verification");
    expect(body).toContain("_Captured in a follow-up slice (#TBD)._");
  });

  test("ends with <details> run metadata block (runner, runId, tokens)", () => {
    const body = buildPrBody(baseInput);
    expect(body).toContain("<details><summary>Run metadata</summary>");
    expect(body).toContain("runner: codex");
    expect(body).toContain("runId: run_abc123");
    expect(body).toContain("tokens in/out: 100/50");
    expect(body.trimEnd().endsWith("</details>")).toBe(true);
  });

  test("orders headers Summary -> Linked issues -> Verification", () => {
    const body = buildPrBody(baseInput);
    const summaryIdx = body.indexOf("## Summary");
    const linkedIdx = body.indexOf("## Linked issues");
    const verifyIdx = body.indexOf("## Verification");
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(linkedIdx).toBeGreaterThan(summaryIdx);
    expect(verifyIdx).toBeGreaterThan(linkedIdx);
  });
});

describe("buildLinearComment", () => {
  test("matches the MVP golden output", () => {
    expect(buildLinearComment(baseInput)).toBe(expectedLinearComment);
  });

  test("first heading is `## ${identifier} — Symphony run report`", () => {
    const body = buildLinearComment(baseInput);
    expect(body.startsWith("## ABC-1 — Symphony run report")).toBe(true);
  });

  test("contains PR line with title, url, and check status", () => {
    const body = buildLinearComment(baseInput);
    expect(body).toContain("**PR:** [ABC-1: Do work](https://github.test/pr/1)");
    expect(body).toContain("status: passing");
  });

  test("lists every file under Files touched (N) with N matching array length", () => {
    const body = buildLinearComment(baseInput);
    expect(body).toContain("**Files touched (2):**");
    expect(body).toContain("- src/foo.ts");
    expect(body).toContain("- src/bar.ts");
  });

  test("Verification placeholder references #TBD", () => {
    const body = buildLinearComment(baseInput);
    expect(body).toContain("**Verification**");
    expect(body).toContain("#TBD");
  });

  test("ends with metadata footer (runner/runId/tokens)", () => {
    const body = buildLinearComment(baseInput);
    expect(body).toContain("runner: codex");
    expect(body).toContain("runId: run_abc123");
    expect(body).toContain("tokens in/out: 100/50");
  });

  test("PR line shows 'PR: not created' when prUrl is null", () => {
    const body = buildLinearComment({ ...baseInput, result: { ...baseInput.result, prUrl: null } });
    expect(body).toContain("**PR:** not created");
  });
});
