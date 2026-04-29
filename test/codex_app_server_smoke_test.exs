defmodule HarnessEngineering.CodexAppServerSmokeTest do
  use ExUnit.Case

  alias HarnessEngineering.CodexAppServer.Client
  alias HarnessEngineering.Config.Codex
  alias HarnessEngineering.Models.Issue
  alias HarnessEngineering.Workspace

  @moduletag :codex_smoke

  test "real codex app-server completes one bounded turn in a fixture workspace" do
    root = Path.join(System.tmp_dir!(), "codex-real-smoke-#{System.unique_integer([:positive])}")
    manager = Workspace.new(root)
    issue = issue()
    assert {:ok, workspace} = Workspace.create_for_issue(manager, issue)

    codex = %Codex{
      command: "codex app-server",
      approval_policy: "never",
      thread_sandbox: "read-only",
      turn_sandbox_policy: %{"type" => "readOnly", "networkAccess" => false},
      read_timeout_ms: 10_000,
      turn_timeout_ms: 120_000,
      stall_timeout_ms: 120_000
    }

    assert {:ok, result} =
             Client.run_turn(
               codex,
               manager,
               workspace.path,
               "Reply with exactly: harness-smoke-ok. Do not inspect files or call tools.",
               issue: issue
             )

    assert result.outcome == "completed"
    assert Enum.any?(result.events, &(&1.event == "turn_completed"))
  end

  defp issue do
    %Issue{
      id: "issue-7-smoke",
      identifier: "harness-engineering#7-smoke",
      title: "Codex app-server smoke",
      state: "open"
    }
  end
end
