defmodule HarnessEngineering.CodexAppServerTest do
  use ExUnit.Case

  alias HarnessEngineering.CodexAppServer.Client
  alias HarnessEngineering.CodexAppServer.Protocol
  alias HarnessEngineering.Config.Codex
  alias HarnessEngineering.Models.Issue
  alias HarnessEngineering.Workspace

  test "protocol methods are read from generated Codex schema bundles" do
    assert Enum.all?(Protocol.schema_files(), &File.exists?/1)
    assert Protocol.method?(:client_request, "initialize")
    assert Protocol.method?(:client_request, "thread/start")
    assert Protocol.method?(:client_request, "turn/start")
    assert Protocol.method?(:client_notification, "initialized")
    assert Protocol.method?(:server_request, "item/commandExecution/requestApproval")
    assert Protocol.method?(:server_request, "item/tool/requestUserInput")
    assert Protocol.method?(:server_notification, "turn/completed")
    refute Protocol.method?(:client_request, "made/up")
  end

  test "run_turn launches the app-server command in the exact issue workspace" do
    {manager, workspace} = fixture_workspace("codex-fixture-exact-cwd")
    codex = fixture_codex()
    events = Agent.start_link(fn -> [] end) |> elem(1)

    assert {:ok, result} =
             Client.run_turn(codex, manager, workspace.path, "fixture prompt",
               issue: issue(),
               on_event: fn event -> Agent.update(events, &(&1 ++ [event.event])) end
             )

    assert result.outcome == "completed"
    assert result.thread_id == "fixture-thread"
    assert result.turn_id == "fixture-turn"
    assert result.codex_app_server_pid
    assert "session_started" in Agent.get(events, & &1)
    assert "turn_completed" in Enum.map(result.events, & &1.event)
    assert File.read!(Path.join(workspace.path, "fixture-cwd.txt")) == workspace.path

    logs = read_fixture_logs(workspace.path)
    assert Enum.any?(logs, &(&1["thread_start_cwd"] == workspace.path))
    assert Enum.any?(logs, &(&1["turn_start_cwd"] == workspace.path))

    assert Enum.any?(logs, fn entry ->
             get_in(entry, ["response", "result", "decision"]) == "acceptForSession"
           end)

    assert Enum.any?(logs, fn entry ->
             get_in(entry, ["response", "result", "success"]) == false
           end)

    assert Enum.any?(logs, fn entry ->
             get_in(entry, ["response", "error", "message"]) ==
               "user input is not supported by this harness"
           end)
  end

  test "run_turn rejects a launch cwd that is not exactly the issue workspace" do
    {manager, workspace} = fixture_workspace("codex-fixture-bad-cwd")

    assert {:error, error} =
             Client.run_turn(fixture_codex(), manager, workspace.path, "fixture prompt",
               launch_cwd: manager.root,
               issue: issue()
             )

    assert error.code == "invalid_workspace_cwd"
  end

  test "retryable Codex error notifications map to retry terminal outcome" do
    {manager, workspace} = fixture_workspace("codex-fixture-error")
    codex = fixture_codex("CODEX_FIXTURE_OUTCOME=error ")

    assert {:ok, result} =
             Client.run_turn(codex, manager, workspace.path, "fixture prompt", issue: issue())

    assert result.outcome == "retry"
    assert result.error_code == "codex_error"
    assert result.error_message == "fixture retryable error"
  end

  defp fixture_codex(prefix \\ "") do
    fixture = Path.expand("../test_support/codex_app_server_fixture.exs", __DIR__)

    %Codex{
      command: "#{prefix}elixir #{fixture}",
      approval_policy: "never",
      thread_sandbox: "read-only",
      turn_sandbox_policy: %{"type" => "readOnly", "networkAccess" => false},
      read_timeout_ms: 5_000,
      turn_timeout_ms: 10_000,
      stall_timeout_ms: 10_000
    }
  end

  defp fixture_workspace(name) do
    root = tmp_path(name)
    manager = Workspace.new(root)
    assert {:ok, workspace} = Workspace.create_for_issue(manager, issue())
    {manager, workspace}
  end

  defp issue do
    %Issue{
      id: "issue-7",
      identifier: "harness-engineering#7",
      title: "Spike the real Codex app-server boundary",
      state: "open"
    }
  end

  defp read_fixture_logs(workspace_path) do
    workspace_path
    |> Path.join("codex-fixture-responses.jsonl")
    |> File.read!()
    |> String.split("\n", trim: true)
    |> Enum.map(&:json.decode/1)
    |> Enum.map(&normalize_json/1)
  end

  defp normalize_json(:null), do: nil
  defp normalize_json(value) when is_list(value), do: Enum.map(value, &normalize_json/1)

  defp normalize_json(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {to_string(key), normalize_json(item)} end)
    |> Map.new()
  end

  defp normalize_json(value), do: value

  defp tmp_path(name) do
    Path.join(System.tmp_dir!(), "#{name}-#{System.unique_integer([:positive])}")
  end
end
