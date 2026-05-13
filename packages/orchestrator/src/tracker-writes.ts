import type { NormalizedIssue } from "@symphony/core";
import type { AppendEventInput } from "@symphony/db";

export interface TrackerStateWriter {
  updateIssueState?(issueId: string, stateName: string): Promise<void>;
}

export interface TrackerWorkpadWriter {
  createOrUpdateWorkpad?(issueId: string, body: string): Promise<void>;
}

export interface TrackerWriteEventSink {
  appendEvent(event: AppendEventInput): void;
}

export class TrackerWriteError extends Error {
  readonly issueId: string;
  readonly identifier: string;
  readonly operation: string;
  readonly cause: unknown;

  constructor(message: string, input: { readonly issue: NormalizedIssue; readonly operation: string; readonly cause: unknown }) {
    super(message);
    this.name = "TrackerWriteError";
    this.issueId = input.issue.id;
    this.identifier = input.issue.identifier;
    this.operation = input.operation;
    this.cause = input.cause;
  }
}

export async function writeRequiredIssueState(input: {
  readonly tracker: TrackerStateWriter;
  readonly issue: NormalizedIssue;
  readonly stateName: string;
  readonly runId?: string;
  readonly appendEvent: TrackerWriteEventSink["appendEvent"];
}): Promise<void> {
  try {
    await input.tracker.updateIssueState?.(input.issue.id, input.stateName);
  } catch (error) {
    appendTrackerWriteFailure({
      appendEvent: input.appendEvent,
      issue: input.issue,
      ...(input.runId ? { runId: input.runId } : {}),
      type: "tracker.state_update_failed",
      message: messageFor(error),
      payload: { stateName: input.stateName, policy: "required", operation: "updateIssueState" },
    });
    throw new TrackerWriteError(`Required tracker state write failed: ${input.stateName}`, {
      issue: input.issue,
      operation: "updateIssueState",
      cause: error,
    });
  }
}

export async function writeBestEffortIssueState(input: {
  readonly tracker: TrackerStateWriter;
  readonly issue: NormalizedIssue;
  readonly stateName: string;
  readonly runId?: string;
  readonly appendEvent: TrackerWriteEventSink["appendEvent"];
}): Promise<boolean> {
  try {
    if (!input.tracker.updateIssueState) return false;
    await input.tracker.updateIssueState(input.issue.id, input.stateName);
    return true;
  } catch (error) {
    appendTrackerWriteFailure({
      appendEvent: input.appendEvent,
      issue: input.issue,
      ...(input.runId ? { runId: input.runId } : {}),
      type: "tracker.state_update_failed",
      message: messageFor(error),
      payload: { stateName: input.stateName, policy: "best-effort", operation: "updateIssueState" },
    });
    return false;
  }
}

export async function writeBestEffortWorkpad(input: {
  readonly tracker: TrackerWorkpadWriter | undefined;
  readonly issue: NormalizedIssue;
  readonly body: string;
  readonly runId?: string;
  readonly appendEvent: TrackerWriteEventSink["appendEvent"];
}): Promise<boolean> {
  try {
    if (!input.tracker?.createOrUpdateWorkpad) return false;
    await input.tracker.createOrUpdateWorkpad(input.issue.id, input.body);
    return true;
  } catch (error) {
    appendTrackerWriteFailure({
      appendEvent: input.appendEvent,
      issue: input.issue,
      ...(input.runId ? { runId: input.runId } : {}),
      type: "tracker.workpad_update_failed",
      message: messageFor(error),
      payload: { policy: "best-effort", operation: "createOrUpdateWorkpad" },
    });
    return false;
  }
}

function appendTrackerWriteFailure(input: {
  readonly appendEvent: TrackerWriteEventSink["appendEvent"];
  readonly issue: NormalizedIssue;
  readonly runId?: string;
  readonly type: string;
  readonly message: string;
  readonly payload: Record<string, unknown>;
}): void {
  input.appendEvent({
    ...(input.runId ? { runId: input.runId } : {}),
    issueId: input.issue.id,
    identifier: input.issue.identifier,
    level: "error",
    type: input.type,
    message: input.message,
    payload: input.payload,
  });
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
