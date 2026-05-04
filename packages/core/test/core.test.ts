import { describe, expect, test } from "bun:test";
import { isActiveState, isTerminalState, sanitizeWorkspaceKey } from "../src/index.ts";

describe("core issue helpers", () => {
  test("sanitizes issue identifiers for workspace paths", () => {
    expect(sanitizeWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(sanitizeWorkspaceKey("Team / weird:ticket")).toBe("Team___weird_ticket");
  });

  test("compares issue states case-insensitively", () => {
    expect(isActiveState("in progress", ["Todo", "In Progress"])).toBe(true);
    expect(isTerminalState("DONE", ["Done", "Closed"])).toBe(true);
    expect(isTerminalState("Todo", ["Done", "Closed"])).toBe(false);
  });

  test("sanitizeWorkspaceKey blocks leading-dot and bare-dot traversal vectors", () => {
    // Bare `..` must not pass through as-is (would be a traversal segment).
    expect(sanitizeWorkspaceKey("..")).not.toBe("..");
    expect(sanitizeWorkspaceKey("..")).not.toMatch(/^\./);

    // Bare `.` must not pass through.
    expect(sanitizeWorkspaceKey(".")).not.toBe(".");

    // Leading dot (hidden file) must be prefixed so key doesn't start with `.`.
    expect(sanitizeWorkspaceKey(".hidden")).not.toMatch(/^\./);
    expect(sanitizeWorkspaceKey(".hidden")).toBe("_hidden");

    // `../escape` starts with `.` after regex replace — must be prefixed.
    expect(sanitizeWorkspaceKey("../escape")).not.toMatch(/^\./);
    expect(sanitizeWorkspaceKey("../escape")).toBe("__escape");

    // Normal identifiers are unchanged.
    expect(sanitizeWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(sanitizeWorkspaceKey("my.workspace-key")).toBe("my.workspace-key");
  });
});
