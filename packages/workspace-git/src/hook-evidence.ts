import type { HookCommandResult, HookResult } from "./index.ts";

export function hookResultFromExecutedCommand(command: HookCommandResult): HookResult {
  return {
    command: command.command,
    exitCode: command.exitCode,
    stdoutTail: command.stdoutTail,
    stderrTail: command.stderrTail,
    durationMs: command.durationMs,
    commands: [command],
  };
}
