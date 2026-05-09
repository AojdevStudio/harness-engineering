import { describe, expect, test } from "bun:test";
import type { PullRequestInspection, PullRequestReviewFinding } from "../src/index.ts";
import {
  appendReviewFeedback,
  blockingReviewFindings,
  decideReviewReconciliation,
  isReviewLifecycleState,
  prWaitingReason,
  reviewSettlePollMs,
  shouldMergePullRequest,
  summarizePrInspection,
} from "../src/review-reconciliation.ts";

function inspection(overrides: Partial<PullRequestInspection> = {}): PullRequestInspection {
  return {
    url: "https://github.test/pr/1",
    state: "OPEN",
    checksStatus: "passing",
    mergeable: true,
    isDraft: false,
    closingIssuesReferences: [],
    findings: [],
    ...overrides,
  };
}

function decision(input: {
  readonly issueState?: string;
  readonly inspection?: PullRequestInspection;
  readonly canMerge?: boolean;
}) {
  return decideReviewReconciliation({
    issueState: input.issueState ?? "Human Review",
    inspection: input.inspection ?? inspection(),
    mergingState: "Merging",
    canMerge: input.canMerge ?? true,
  });
}

describe("isReviewLifecycleState", () => {
  test("matches human-review and merging states case-insensitively", () => {
    const states = { humanReview: "Human Review", merging: "Merging" };

    expect(isReviewLifecycleState("human review", states)).toBe(true);
    expect(isReviewLifecycleState(" MERGING ", states)).toBe(true);
    expect(isReviewLifecycleState("In Progress", states)).toBe(false);
  });
});

describe("decideReviewReconciliation", () => {
  test("marks already-merged PRs done", () => {
    expect(decision({ inspection: inspection({ state: "MERGED" }) })).toEqual({ action: "mark-done", reason: "already-merged" });
  });

  test("routes blocking P0-P2 findings to rework", () => {
    const finding: PullRequestReviewFinding = { severity: "P2", source: "review", message: "Fix this before merge" };
    const result = decision({ inspection: inspection({ findings: [finding] }) });

    expect(result.action).toBe("rework");
    if (result.action === "rework") {
      expect(result.findings).toEqual([finding]);
    }
  });

  test("synthesizes blocking findings for failing checks and requested changes", () => {
    expect(blockingReviewFindings(inspection({ checksStatus: "failing" }))).toEqual([
      { severity: "P1", source: "checks", message: "PR checks are failing; inspect CI output, fix the branch, and rerun validation." },
    ]);

    expect(blockingReviewFindings(inspection({ reviewDecision: "CHANGES_REQUESTED" }))).toEqual([
      { severity: "P1", source: "review-decision", message: "GitHub review decision is CHANGES_REQUESTED; inspect review comments and address or explicitly push back on each actionable item." },
    ]);
  });

  test("marks approved clean PRs merge-ready when merge capability exists", () => {
    expect(decision({ inspection: inspection({ reviewDecision: "APPROVED" }) })).toEqual({ action: "merge", reason: "approved" });
  });

  test("marks clean PRs already in Merging merge-ready even without approval", () => {
    expect(decision({ issueState: "Merging", inspection: inspection({ reviewDecision: null }) })).toEqual({ action: "merge", reason: "merging-state" });
  });

  test("waits when the PR is clean but not approved or already merging", () => {
    expect(decision({ inspection: inspection({ reviewDecision: null }) })).toEqual({
      action: "wait",
      reason: "PR is clean but not approved or in merging state",
    });
  });

  test("preserves draft and mergeability wait reasons", () => {
    expect(prWaitingReason("Human Review", inspection({ isDraft: true }), "Merging")).toBe("PR is draft");
    expect(prWaitingReason("Human Review", inspection({ mergeable: false }), "Merging")).toBe("PR is not mergeable");
  });
});

describe("shouldMergePullRequest", () => {
  test("requires merge capability, open state, passing checks, mergeability, and approval or merging state", () => {
    const approved = inspection({ reviewDecision: "APPROVED" });

    expect(shouldMergePullRequest({ issueState: "Human Review", inspection: approved, mergingState: "Merging", canMerge: true })).toBe(true);
    expect(shouldMergePullRequest({ issueState: "Human Review", inspection: approved, mergingState: "Merging", canMerge: false })).toBe(false);
    expect(shouldMergePullRequest({ issueState: "Human Review", inspection: inspection({ reviewDecision: "APPROVED", checksStatus: "pending" }), mergingState: "Merging", canMerge: true })).toBe(false);
    expect(shouldMergePullRequest({ issueState: "Merging", inspection: inspection({ reviewDecision: null }), mergingState: "Merging", canMerge: true })).toBe(true);
  });
});

describe("review settle helpers", () => {
  test("uses quarter-window polling with a 30s cap", () => {
    expect(reviewSettlePollMs(0)).toBe(1);
    expect(reviewSettlePollMs(1_000)).toBe(250);
    expect(reviewSettlePollMs(240_000)).toBe(30_000);
  });
});

describe("review feedback rendering", () => {
  test("adds actionable review findings to the runner prompt", () => {
    const prompt = appendReviewFeedback("Work on the issue", inspection(), [
      { severity: "P1", source: "checks", message: "Fix CI", url: "https://github.test/checks/1" },
    ]);

    expect(prompt).toContain("## Pull Request Review Feedback");
    expect(prompt).toContain("PR: https://github.test/pr/1");
    expect(prompt).toContain("1. P1 (checks): Fix CI https://github.test/checks/1");
  });
});

describe("summarizePrInspection", () => {
  test("normalizes optional fields for event payloads", () => {
    const withoutDraft: PullRequestInspection = {
      url: "https://github.test/pr/1",
      state: "OPEN",
      checksStatus: "passing",
      mergeable: true,
      closingIssuesReferences: [],
      findings: [],
    };

    expect(summarizePrInspection(withoutDraft)).toMatchObject({
      url: "https://github.test/pr/1",
      reviewDecision: null,
      isDraft: false,
      findings: [],
    });
  });
});
