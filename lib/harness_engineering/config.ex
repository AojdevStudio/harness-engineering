defmodule HarnessEngineering.Config.Error do
  @moduledoc false

  defexception [:code, :message]

  @impl true
  def exception(opts) do
    %__MODULE__{code: Keyword.fetch!(opts, :code), message: Keyword.fetch!(opts, :message)}
  end
end

defmodule HarnessEngineering.Config.Tracker do
  @moduledoc false

  defstruct kind: "",
            endpoint: "https://api.github.com/graphql",
            api_key: nil,
            active_states: [],
            terminal_states: [],
            owner: nil,
            repo: nil,
            project_slug: nil
end

defmodule HarnessEngineering.Config.Polling do
  @moduledoc false

  defstruct interval_ms: 30_000
end

defmodule HarnessEngineering.Config.Workspace do
  @moduledoc false

  defstruct root: nil
end

defmodule HarnessEngineering.Config.Hooks do
  @moduledoc false

  defstruct after_create: nil,
            before_run: nil,
            after_run: nil,
            before_remove: nil,
            timeout_ms: 60_000

  def as_scripts(%__MODULE__{} = hooks) do
    %{
      "after_create" => hooks.after_create,
      "before_run" => hooks.before_run,
      "after_run" => hooks.after_run,
      "before_remove" => hooks.before_remove
    }
    |> Enum.reject(fn {_name, script} -> is_nil(script) or script == "" end)
    |> Map.new()
  end
end

defmodule HarnessEngineering.Config.Agent do
  @moduledoc false

  defstruct max_concurrent_agents: 10,
            max_turns: 20,
            max_retry_backoff_ms: 300_000,
            max_concurrent_agents_by_state: %{}
end

defmodule HarnessEngineering.Config.Codex do
  @moduledoc false

  defstruct command: "codex app-server",
            approval_policy: nil,
            thread_sandbox: nil,
            turn_sandbox_policy: nil,
            turn_timeout_ms: 3_600_000,
            read_timeout_ms: 5_000,
            stall_timeout_ms: 300_000
end

defmodule HarnessEngineering.Config.Server do
  @moduledoc false

  defstruct port: nil, host: "127.0.0.1"
end

defmodule HarnessEngineering.Config do
  @moduledoc """
  Typed runtime config resolved from `WORKFLOW.md` front matter.
  """

  alias HarnessEngineering.Config.Agent
  alias HarnessEngineering.Config.Codex
  alias HarnessEngineering.Config.Error
  alias HarnessEngineering.Config.Hooks
  alias HarnessEngineering.Config.Polling
  alias HarnessEngineering.Config.Server
  alias HarnessEngineering.Config.Tracker
  alias HarnessEngineering.Config.Workspace
  alias HarnessEngineering.Workflow
  alias HarnessEngineering.Workflow.Definition

  defstruct [:tracker, :polling, :workspace, :hooks, :agent, :codex, :server]

  def from_workflow(%Definition{} = workflow, workflow_path, env \\ System.get_env()) do
    try do
      {:ok, build_config!(workflow, workflow_path, env)}
    rescue
      error in Error -> {:error, error}
    end
  end

  def validate_dispatch(%__MODULE__{} = config) do
    cond do
      config.tracker.kind == "" ->
        {:error, %Error{code: "missing_tracker_kind", message: "tracker.kind is required"}}

      config.tracker.kind != "github" ->
        {:error,
         %Error{
           code: "unsupported_tracker_kind",
           message: "unsupported tracker.kind=#{inspect(config.tracker.kind)}"
         }}

      is_nil(config.tracker.api_key) ->
        {:error,
         %Error{
           code: "missing_tracker_api_key",
           message: "tracker.api_key or GITHUB_TOKEN is required"
         }}

      is_nil(config.tracker.owner) or is_nil(config.tracker.repo) ->
        {:error,
         %Error{
           code: "missing_tracker_repository",
           message: "tracker.owner and tracker.repo are required for GitHub"
         }}

      config.codex.command == "" ->
        {:error, %Error{code: "missing_codex_command", message: "codex.command is required"}}

      true ->
        :ok
    end
  end

  defp build_config!(workflow, workflow_path, env) do
    root = object(workflow.config)
    workflow_dir = workflow_path |> Workflow.realpath() |> Path.dirname()
    tracker_raw = object(Map.get(root, "tracker"))
    kind = tracker_raw |> Map.get("kind", "") |> to_string() |> String.downcase()
    api_key = resolve_secret(Map.get(tracker_raw, "api_key"), env)

    api_key =
      cond do
        present?(api_key) -> api_key
        kind == "github" -> empty_to_nil(Map.get(env, "GITHUB_TOKEN"))
        kind == "linear" -> empty_to_nil(Map.get(env, "LINEAR_API_KEY"))
        true -> api_key
      end

    {active_states, terminal_states} =
      if kind == "github" do
        {
          string_list(Map.get(tracker_raw, "active_states"), ["open"]),
          string_list(Map.get(tracker_raw, "terminal_states"), ["closed"])
        }
      else
        {
          string_list(Map.get(tracker_raw, "active_states"), ["Todo", "In Progress"]),
          string_list(Map.get(tracker_raw, "terminal_states"), [
            "Closed",
            "Cancelled",
            "Canceled",
            "Duplicate",
            "Done"
          ])
        }
      end

    polling_raw = object(Map.get(root, "polling"))
    workspace_raw = object(Map.get(root, "workspace"))
    hooks_raw = object(Map.get(root, "hooks"))
    agent_raw = object(Map.get(root, "agent"))
    codex_raw = object(Map.get(root, "codex"))
    server_raw = object(Map.get(root, "server"))

    %__MODULE__{
      tracker: %Tracker{
        kind: kind,
        endpoint: tracker_endpoint(kind, Map.get(tracker_raw, "endpoint")),
        api_key: api_key,
        owner: optional_string(Map.get(tracker_raw, "owner")),
        repo: optional_string(Map.get(tracker_raw, "repo")),
        project_slug: optional_string(Map.get(tracker_raw, "project_slug")),
        active_states: Enum.map(active_states, &String.downcase/1),
        terminal_states: Enum.map(terminal_states, &String.downcase/1)
      },
      polling: %Polling{
        interval_ms:
          positive_int!(Map.get(polling_raw, "interval_ms"), 30_000, "polling.interval_ms")
      },
      workspace: %Workspace{
        root:
          resolve_path!(
            Map.get(workspace_raw, "root", Path.join(System.tmp_dir!(), "symphony_workspaces")),
            workflow_dir,
            env
          )
      },
      hooks: %Hooks{
        after_create: optional_string(Map.get(hooks_raw, "after_create")),
        before_run: optional_string(Map.get(hooks_raw, "before_run")),
        after_run: optional_string(Map.get(hooks_raw, "after_run")),
        before_remove: optional_string(Map.get(hooks_raw, "before_remove")),
        timeout_ms: positive_int!(Map.get(hooks_raw, "timeout_ms"), 60_000, "hooks.timeout_ms")
      },
      agent: %Agent{
        max_concurrent_agents:
          positive_int!(
            Map.get(agent_raw, "max_concurrent_agents"),
            10,
            "agent.max_concurrent_agents"
          ),
        max_turns: positive_int!(Map.get(agent_raw, "max_turns"), 20, "agent.max_turns"),
        max_retry_backoff_ms:
          positive_int!(
            Map.get(agent_raw, "max_retry_backoff_ms"),
            300_000,
            "agent.max_retry_backoff_ms"
          ),
        max_concurrent_agents_by_state:
          by_state_limits(Map.get(agent_raw, "max_concurrent_agents_by_state"))
      },
      codex: %Codex{
        command:
          codex_raw |> Map.get("command", "codex app-server") |> to_string() |> String.trim(),
        approval_policy: optional_string(Map.get(codex_raw, "approval_policy")),
        thread_sandbox: optional_string(Map.get(codex_raw, "thread_sandbox")),
        turn_sandbox_policy: Map.get(codex_raw, "turn_sandbox_policy"),
        turn_timeout_ms:
          positive_int!(Map.get(codex_raw, "turn_timeout_ms"), 3_600_000, "codex.turn_timeout_ms"),
        read_timeout_ms:
          positive_int!(Map.get(codex_raw, "read_timeout_ms"), 5_000, "codex.read_timeout_ms"),
        stall_timeout_ms:
          int!(Map.get(codex_raw, "stall_timeout_ms"), 300_000, "codex.stall_timeout_ms")
      },
      server: %Server{
        port: server_port(Map.get(server_raw, "port")),
        host: server_raw |> Map.get("host", "127.0.0.1") |> to_string()
      }
    }
  end

  defp object(value) when is_map(value), do: value
  defp object(_value), do: %{}

  defp string_list(nil, default), do: default
  defp string_list(value, default) when not is_list(value), do: default

  defp string_list(value, _default) do
    value
    |> Enum.map(&to_string/1)
    |> Enum.reject(&(String.trim(&1) == ""))
  end

  defp optional_string(nil), do: nil

  defp optional_string(value) do
    parsed = to_string(value)
    if parsed == "", do: nil, else: parsed
  end

  defp empty_to_nil(nil), do: nil

  defp empty_to_nil(value) do
    parsed = String.trim(to_string(value))
    if parsed == "", do: nil, else: parsed
  end

  defp resolve_secret(nil, _env), do: nil

  defp resolve_secret(value, env) do
    parsed = to_string(value)

    if String.starts_with?(parsed, "$") and String.length(parsed) > 1 do
      parsed |> String.slice(1..-1//1) |> then(&Map.get(env, &1)) |> empty_to_nil()
    else
      empty_to_nil(parsed)
    end
  end

  defp resolve_path!(value, workflow_dir, env) do
    raw = to_string(value)

    raw =
      if String.starts_with?(raw, "$") and String.length(raw) > 1 do
        Map.get(env, String.slice(raw, 1..-1//1), "")
      else
        raw
      end

    Workflow.realpath(raw, workflow_dir)
  end

  defp tracker_endpoint(kind, configured) do
    cond do
      configured not in [nil, ""] -> to_string(configured)
      kind == "linear" -> "https://api.linear.app/graphql"
      true -> "https://api.github.com/graphql"
    end
  end

  defp positive_int!(value, default, field_name) do
    parsed = int!(value, default, field_name)

    if parsed <= 0 do
      raise Error, code: "invalid_config", message: "#{field_name} must be positive"
    end

    parsed
  end

  defp int!(nil, default, _field_name), do: default

  defp int!(value, _default, _field_name) when is_integer(value), do: value

  defp int!(value, _default, field_name) do
    case Integer.parse(to_string(value)) do
      {parsed, ""} ->
        parsed

      _ ->
        raise Error, code: "invalid_config", message: "#{field_name} must be an integer"
    end
  end

  defp server_port(nil), do: nil
  defp server_port(value), do: int!(value, 0, "server.port")

  defp by_state_limits(value) do
    value
    |> object()
    |> Enum.reduce(%{}, fn {state, limit}, acc ->
      case Integer.parse(to_string(limit)) do
        {parsed, ""} when parsed > 0 ->
          Map.put(acc, state |> to_string() |> String.downcase(), parsed)

        _ ->
          acc
      end
    end)
  end

  defp present?(value), do: not is_nil(empty_to_nil(value))
end
