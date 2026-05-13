import { describe, expect, test } from "bun:test";
import { hookResultFromExecutedCommand } from "../src/hook-evidence.ts";

describe("hookResultFromExecutedCommand", () => {
  test("records the shell command that actually ran without fabricating split command evidence", () => {
    const result = hookResultFromExecutedCommand({
      command: "bun run typecheck && bun test",
      exitCode: 0,
      stdoutTail: "88 pass\n0 fail\n",
      stderrTail: "",
      durationMs: 4700,
    });

    expect(result).toEqual({
      command: "bun run typecheck && bun test",
      exitCode: 0,
      stdoutTail: "88 pass\n0 fail\n",
      stderrTail: "",
      durationMs: 4700,
      commands: [
        {
          command: "bun run typecheck && bun test",
          exitCode: 0,
          stdoutTail: "88 pass\n0 fail\n",
          stderrTail: "",
          durationMs: 4700,
        },
      ],
    });
  });
});
