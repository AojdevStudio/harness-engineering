import type { PullRequestInspection, PullRequestReviewFinding } from "./index.ts";

export interface ReviewLifecycleStates {
  readonly humanReview: string;
  readonly merging: string;
}

export interface ReviewReconciliationInput {
  readonly issueState: string;
  readonly inspection: PullRequestInspection;
  readonly mergingState: string;
  readonly canMerge: boolean;
}

export type ReviewReconciliationDecision =
  | { readonly action: "mark-done"; readonly reason: "already-merged" }
  | { readonly action: "rework"; readonly reason: "blocking-findings"; readonly findings: readonly PullRequestReviewFinding[] }
  | { readonly action: "merge"; readonly reason: "approved" | "merging-state" }
  | { readonly action: "wait"; readonly reason: string };

export function isReviewLifecycleState(state: string, states: ReviewLifecycleStates): boolean {
  return sameState(state, states.humanReview) || sameState(state, states.merging);
}

export function decideReviewReconciliation(input: ReviewReconciliationInput): ReviewReconciliationDecision {
  if (input.inspection.state === "MERGED") return { action: "mark-done", reason: "already-merged" };

  const findings = blockingReviewFindings(input.inspection);
  if (findings.length > 0) return { action: "rework", reason: "blocking-findings", findings };

  if (shouldMergePullRequest(input)) {
    return {
      action: "merge",
      reason: sameState(input.issueState, input.mergingState) ? "merging-state" : "approved",
    };
  }

  return {
    action: "wait",
    reason: prWaitingReason(input.issueState, input.inspection, input.mergingState),
  };
}

export function shouldMergePullRequest(input: ReviewReconciliationInput): boolean {
  if (!input.canMerge) return false;
  if (input.inspection.state !== "OPEN") return false;
  if (input.inspection.isDraft) return false;
  if (input.inspection.checksStatus !== "passing") return false;
  if (!input.inspection.mergeable) return false;
  if (sameState(input.issueState, input.mergingState)) return true;
  return isPullRequestApproved(input.inspection);
}

export function isPullRequestApproved(inspection: PullRequestInspection): boolean {
  return normalizeReviewDecision(inspection.reviewDecision) === "APPROVED";
}

export function sameState(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function reviewSettlePollMs(reviewSettleMs: number): number {
  return Math.max(1, Math.min(30_000, Math.ceil(reviewSettleMs / 4)));
}

export function blockingReviewFindings(inspection: PullRequestInspection): readonly PullRequestReviewFinding[] {
  const findings = inspection.findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1" || finding.severity === "P2");

  const synthetic: PullRequestReviewFinding[] = [];
  if (inspection.checksStatus === "failing") {
    synthetic.push({ severity: "P1", source: "checks", message: "PR checks are failing; inspect CI output, fix the branch, and rerun validation." });
  }
  if (normalizeReviewDecision(inspection.reviewDecision) === "CHANGES_REQUESTED" && findings.length === 0) {
    synthetic.push({ severity: "P1", source: "review-decision", message: "GitHub review decision is CHANGES_REQUESTED; inspect review comments and address or explicitly push back on each actionable item." });
  }

  return [...findings, ...synthetic];
}

export function summarizeReviewFindings(findings: readonly PullRequestReviewFinding[]): string | null {
  if (findings.length === 0) return null;
  return findings.map((finding) => {
    const source = finding.source ? ` (${finding.source})` : "";
    return `${finding.severity}${source}: ${finding.message}`;
  }).join("; ");
}

export function appendReviewFeedback(prompt: string, inspection: PullRequestInspection | undefined, findings: readonly PullRequestReviewFinding[]): string {
  const lines = [
    prompt.trimEnd(),
    "",
    "## Pull Request Review Feedback",
    "",
    inspection ? `PR: ${inspection.url}` : "PR: unavailable",
    "Address every listed P0/P1/P2 item, rerun validation, commit, and push the branch before handing back to review.",
    "",
    ...findings.map((finding, index) => {
      const source = finding.source ? ` (${finding.source})` : "";
      const url = finding.url ? ` ${finding.url}` : "";
      return `${index + 1}. ${finding.severity}${source}: ${finding.message}${url}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

export function summarizePrInspection(inspection: PullRequestInspection): Record<string, unknown> {
  return {
    url: inspection.url,
    state: inspection.state,
    reviewDecision: inspection.reviewDecision ?? null,
    checksStatus: inspection.checksStatus,
    mergeable: inspection.mergeable,
    isDraft: inspection.isDraft ?? false,
    findings: inspection.findings.map((finding) => ({
      severity: finding.severity,
      source: finding.source ?? null,
      message: finding.message,
      url: finding.url ?? null,
    })),
  };
}

export function prWaitingReason(issueState: string, inspection: PullRequestInspection, mergingState: string): string {
  if (inspection.state !== "OPEN") return `PR is ${inspection.state}`;
  if (inspection.isDraft) return "PR is draft";
  if (inspection.checksStatus !== "passing") return `PR checks are ${inspection.checksStatus}`;
  if (!inspection.mergeable) return "PR is not mergeable";
  if (!sameState(issueState, mergingState) && !isPullRequestApproved(inspection)) {
    return "PR is clean but not approved or in merging state";
  }
  return "PR is waiting";
}

function normalizeReviewDecision(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}
