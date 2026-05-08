import { describe, expect, test } from "bun:test";
import { resolveIssueLink, verifyPrMetadata } from "../src/issue-link.ts";

const exists = (valid: readonly number[]) => ({
  validateIssueExists: (num: number) => valid.includes(num),
});

describe("verifyPrMetadata", () => {
  const baseInspection = {
    url: "https://github.test/pr/1",
    state: "OPEN",
    checksStatus: "passing" as const,
    mergeable: true,
    isDraft: false,
    findings: [],
  };

  test("passes when no GitHub keyword was emitted", () => {
    expect(verifyPrMetadata({ trackerKeyword: "Closes ABC-1", source: "fallback" }, { ...baseInspection, closingIssuesReferences: [] })).toEqual({ ok: true });
  });

  test("passes when GitHub parsed a closing reference", () => {
    expect(verifyPrMetadata({ trackerKeyword: "Closes ABC-1", githubKeyword: "Closes #123", source: "branch" }, { ...baseInspection, closingIssuesReferences: [123] })).toEqual({ ok: true });
  });

  test("fails when GitHub keyword was emitted but no closing reference was parsed", () => {
    expect(verifyPrMetadata({ trackerKeyword: "Closes ABC-1", githubKeyword: "Closes #123", source: "branch" }, { ...baseInspection, closingIssuesReferences: [] })).toEqual({
      ok: false,
      reason: "missing-github-closing-keyword",
    });
  });
});

describe("resolveIssueLink", () => {
  test("always emits the tracker closing keyword", async () => {
    const result = await resolveIssueLink({
      trackerIdentifier: "HOM-15",
      branchName: "feature/no-number",
      commits: [],
      ghValidator: exists([]),
    });

    expect(result.trackerKeyword).toBe("Closes HOM-15");
    expect(result.source).toBe("fallback");
  });

  test.each([
    ["feature/123-foo", 123],
    ["feature/foo-123", 123],
    ["fix-#456-bar", 456],
  ])("extracts issue number from branch %s", async (branchName, issueNum) => {
    const result = await resolveIssueLink({
      trackerIdentifier: "ABC-1",
      branchName,
      commits: [],
      ghValidator: exists([issueNum]),
    });

    expect(result).toMatchObject({
      trackerKeyword: "Closes ABC-1",
      githubKeyword: `Closes #${issueNum}`,
      source: "branch",
    });
  });

  test("downgrades to fallback when validator returns false", async () => {
    const result = await resolveIssueLink({
      trackerIdentifier: "ABC-1",
      branchName: "feature/123-foo",
      commits: [],
      ghValidator: exists([]),
    });

    expect(result.githubKeyword).toBeUndefined();
    expect(result.source).toBe("fallback");
  });

  test("extracts closing keywords from commit messages", async () => {
    const result = await resolveIssueLink({
      trackerIdentifier: "ABC-1",
      branchName: "feature/no-number",
      commits: [{ sha: "abc", subject: "ship it", body: "Fixes #77" }],
      ghValidator: exists([77]),
    });

    expect(result.githubKeyword).toBe("Closes #77");
    expect(result.source).toBe("commits");
  });

  test("preserves Refs keyword from commit messages", async () => {
    const result = await resolveIssueLink({
      trackerIdentifier: "ABC-1",
      branchName: "feature/no-number",
      commits: [{ sha: "abc", subject: "Refs #88", body: "" }],
      ghValidator: exists([88]),
    });

    expect(result.githubKeyword).toBe("Refs #88");
    expect(result.source).toBe("commits");
  });

  test("uses no-issue checkbox only when allowed and present", async () => {
    const result = await resolveIssueLink({
      trackerIdentifier: "ABC-1",
      branchName: "feature/no-number",
      commits: [],
      allowNoIssue: true,
      prTemplate: {
        raw: "## Linked issues\n- [ ] No issue required (docs only)\n",
        sections: [{ header: "Linked issues", body: "- [ ] No issue required (docs only)" }],
      },
      ghValidator: exists([]),
    });

    expect(result).toMatchObject({
      trackerKeyword: "Closes ABC-1",
      noIssueChecked: true,
      source: "no-issue",
    });
  });
});
