defmodule HarnessEngineering.WorkflowConfigTest do
  use ExUnit.Case
  import ExUnit.CaptureIO

  alias HarnessEngineering.CLI
  alias HarnessEngineering.Config
  alias HarnessEngineering.Runtime
  alias HarnessEngineering.Test.PythonOracle
  alias HarnessEngineering.Workflow
  alias HarnessEngineering.Workflow.Reloader

  test "OTP app starts under a supervision tree" do
    assert {:ok, _apps} = Application.ensure_all_started(:harness_engineering)
    assert is_pid(Process.whereis(HarnessEngineering.Supervisor))
    assert is_pid(Process.whereis(HarnessEngineering.Runtime))
  end

  test "workflow path precedence matches the Python CLI contract" do
    tmp = tmp_dir()
    explicit = Path.join(tmp, "custom.md")

    assert Workflow.select_path(explicit, tmp) == Workflow.realpath(explicit)
    assert Workflow.select_path(nil, tmp) == Workflow.realpath("WORKFLOW.md", tmp)
    assert Workflow.select_path("", tmp) == Workflow.realpath("WORKFLOW.md", tmp)
  end

  test "loader trims prompt body and matches the Python workflow oracle" do
    workflow_path =
      write_workflow("""
      ---
      tracker:
        kind: github
        owner: AojdevStudio
        repo: harness-engineering
        api_key: literal-token
      ---

      Hello {{ issue.identifier }}

      """)

    assert {:ok, workflow} = Workflow.load(workflow_path)
    assert {:ok, config} = Config.from_workflow(workflow, workflow_path, %{})

    assert elixir_summary(workflow, config) == PythonOracle.summary(workflow_path)
  end

  test "defaults env resolution paths and block scalars match the Python oracle" do
    env = %{"WORKFLOW_TEST_TOKEN" => "ghp_test"}

    workflow_path =
      write_workflow("""
      ---
      tracker:
        kind: github
        owner: AojdevStudio
        repo: harness-engineering
        api_key: $WORKFLOW_TEST_TOKEN
      workspace:
        root: .symphony
      hooks:
        timeout_ms: 60000
        after_create: |
          git clone https://github.com/AojdevStudio/harness-engineering.git .
        before_run: |
          git fetch origin
      agent:
        max_concurrent_agents_by_state:
          OPEN: 2
          closed: 0
      server:
        port: 0
      ---
      Prompt
      """)

    assert {:ok, workflow} = Workflow.load(workflow_path)
    assert {:ok, config} = Config.from_workflow(workflow, workflow_path, env)

    assert elixir_summary(workflow, config) == PythonOracle.summary(workflow_path, env)
  end

  test "invalid front matter errors are typed and match the Python oracle code" do
    workflow_path = write_workflow("---\n: bad yaml\n---\nPrompt\n")

    assert {:error, %Workflow.LoadError{} = error} = Workflow.load(workflow_path)
    assert error.code == "workflow_parse_error"

    python = PythonOracle.summary(workflow_path)
    assert python["status"] == "error"
    assert python["code"] == error.code
  end

  test "dispatch validation errors are typed and operator visible" do
    workflow_path = write_workflow("---\ntracker:\n  kind: jira\n---\nPrompt\n")

    assert {:ok, workflow} = Workflow.load(workflow_path)
    assert {:ok, config} = Config.from_workflow(workflow, workflow_path, %{})
    assert {:error, %Config.Error{} = error} = Config.validate_dispatch(config)
    assert error.code == "unsupported_tracker_kind"

    python = PythonOracle.summary(workflow_path, %{}, :validate)
    assert python["status"] == "error"
    assert python["code"] == error.code
  end

  test "reloader keeps last known good workflow after invalid reload" do
    workflow_path = write_workflow("---\npolling:\n  interval_ms: 1000\n---\nOne\n")
    assert {:ok, reloader} = Reloader.load_initial(workflow_path)

    File.write!(workflow_path, "---\n: bad yaml\n---\nTwo\n")

    assert {:error, failed} = Reloader.reload_if_changed(reloader, force: true)
    assert failed.current.prompt_template == "One"
    assert failed.last_error.code == "workflow_parse_error"
  end

  test "runtime one-shot load validates without dispatching workers" do
    env = %{"WORKFLOW_TEST_TOKEN" => "ghp_test"}

    workflow_path =
      write_workflow("""
      ---
      tracker:
        kind: github
        owner: AojdevStudio
        repo: harness-engineering
        api_key: $WORKFLOW_TEST_TOKEN
      ---
      Prompt
      """)

    assert {:ok, result} = Runtime.load_workflow(workflow_path, env: env)
    assert result.workflow.prompt_template == "Prompt"
    assert result.config.tracker.api_key == "ghp_test"
  end

  test "CLI prints typed startup errors" do
    workflow_path = write_workflow("---\ntracker:\n  kind: jira\n---\nPrompt\n")

    assert capture_io(:stderr, fn ->
             assert CLI.main([workflow_path, "--once"]) == 1
           end) =~ "startup failed code=unsupported_tracker_kind"
  end

  defp elixir_summary(workflow, config) do
    %{
      "status" => "ok",
      "path" => workflow.path,
      "prompt_template" => workflow.prompt_template,
      "tracker_kind" => config.tracker.kind,
      "tracker_endpoint" => config.tracker.endpoint,
      "tracker_api_key" => config.tracker.api_key || "",
      "tracker_owner" => config.tracker.owner || "",
      "tracker_repo" => config.tracker.repo || "",
      "tracker_active_states" => Enum.join(config.tracker.active_states, "\x1F"),
      "tracker_terminal_states" => Enum.join(config.tracker.terminal_states, "\x1F"),
      "polling_interval_ms" => to_string(config.polling.interval_ms),
      "workspace_root" => config.workspace.root,
      "hooks_after_create" => config.hooks.after_create || "",
      "hooks_before_run" => config.hooks.before_run || "",
      "hooks_timeout_ms" => to_string(config.hooks.timeout_ms),
      "agent_max_concurrent_agents" => to_string(config.agent.max_concurrent_agents),
      "agent_max_turns" => to_string(config.agent.max_turns),
      "agent_max_retry_backoff_ms" => to_string(config.agent.max_retry_backoff_ms),
      "agent_max_concurrent_agents_by_state" =>
        sorted_state_limits(config.agent.max_concurrent_agents_by_state),
      "codex_command" => config.codex.command,
      "codex_turn_timeout_ms" => to_string(config.codex.turn_timeout_ms),
      "codex_read_timeout_ms" => to_string(config.codex.read_timeout_ms),
      "codex_stall_timeout_ms" => to_string(config.codex.stall_timeout_ms),
      "server_port" =>
        if(is_nil(config.server.port), do: "", else: to_string(config.server.port)),
      "server_host" => config.server.host
    }
  end

  defp sorted_state_limits(value) do
    value
    |> Enum.sort_by(fn {key, _value} -> key end)
    |> Enum.map(fn {key, limit} -> "#{key}:#{limit}" end)
    |> Enum.join("\x1F")
  end

  defp write_workflow(text) do
    path = Path.join(tmp_dir(), "WORKFLOW.md")
    File.write!(path, unindent(text))
    path
  end

  defp tmp_dir do
    path =
      Path.join(
        System.tmp_dir!(),
        "harness-engineering-elixir-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(path)
    path
  end

  defp unindent(text) do
    lines = String.split(text, "\n")

    indent =
      lines
      |> Enum.reject(&(String.trim(&1) == ""))
      |> Enum.map(fn line ->
        line |> String.graphemes() |> Enum.take_while(&(&1 == " ")) |> length()
      end)
      |> Enum.min(fn -> 0 end)

    lines
    |> Enum.map(&String.replace_prefix(&1, String.duplicate(" ", indent), ""))
    |> Enum.join("\n")
  end
end
