import { describe, expect, test } from "bun:test";
import type { AppendEventInput } from "@symphony/db";
import type { NormalizedIssue } from "@symphony/core";
import {
  TrackerWriteError,
  writeBestEffortIssueState,
  writeBestEffortWorkpad,
  writeRequiredIssueState,
} from "../src/tracker-writes.ts";

const issue: NormalizedIssue = {
  id: "issue-1",
  identifier: "ABC-1",
  title: "Do work",
  description: null,
  priority: null,
  state: "Todo",
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
};

describe("writeRequiredIssueState", () => {
  test("writes state through the tracker", async () => {
    const writes: string[] = [];

    await writeRequiredIssueState({
      tracker: {
        updateIssueState: async (_issueId, stateName) => {
          writes.push(stateName);
        },
      },
      issue,
      stateName: "In Progress",
      appendEvent: () => {},
    });

    expect(writes).toEqual(["In Progress"]);
  });

  test("records and throws when a required write fails", async () => {
    const events: AppendEventInput[] = [];

    await expect(writeRequiredIssueState({
      tracker: {
        updateIssueState: async () => {
          throw new Error("Linear unavailable");
        },
      },
      issue,
      stateName: "Human Review",
      runId: "run-1",
      appendEvent: (event) => {
        events.push(event);
      },
    })).rejects.toThrow(TrackerWriteError);

    expect(events).toEqual([
      {
        runId: "run-1",
        issueId: "issue-1",
        identifier: "ABC-1",
        level: "error",
        type: "tracker.state_update_failed",
        message: "Linear unavailable",
        payload: { stateName: "Human Review", policy: "required", operation: "updateIssueState" },
      },
    ]);
  });
});

describe("writeBestEffortIssueState", () => {
  test("records failure and returns false without throwing", async () => {
    const events: AppendEventInput[] = [];

    const result = await writeBestEffortIssueState({
      tracker: {
        updateIssueState: async () => {
          throw new Error("state mutation failed");
        },
      },
      issue,
      stateName: "Rework",
      appendEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toBe(false);
    expect(events[0]).toMatchObject({
      issueId: "issue-1",
      identifier: "ABC-1",
      level: "error",
      type: "tracker.state_update_failed",
      message: "state mutation failed",
      payload: { stateName: "Rework", policy: "best-effort", operation: "updateIssueState" },
    });
  });
});

describe("writeBestEffortWorkpad", () => {
  test("records workpad failure and returns false without throwing", async () => {
    const events: AppendEventInput[] = [];

    const result = await writeBestEffortWorkpad({
      tracker: {
        createOrUpdateWorkpad: async () => {
          throw new Error("comment failed");
        },
      },
      issue,
      body: "handoff",
      runId: "run-1",
      appendEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toBe(false);
    expect(events).toEqual([
      {
        runId: "run-1",
        issueId: "issue-1",
        identifier: "ABC-1",
        level: "error",
        type: "tracker.workpad_update_failed",
        message: "comment failed",
        payload: { policy: "best-effort", operation: "createOrUpdateWorkpad" },
      },
    ]);
  });
});
