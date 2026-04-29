defmodule HarnessEngineering.Workspace.Error do
  @moduledoc false

  defexception [:code, :message, :path, :hook, :returncode]

  @impl true
  def exception(opts) do
    %__MODULE__{
      code: Keyword.fetch!(opts, :code),
      message: Keyword.fetch!(opts, :message),
      path: Keyword.get(opts, :path),
      hook: Keyword.get(opts, :hook),
      returncode: Keyword.get(opts, :returncode)
    }
  end
end

defmodule HarnessEngineering.Workspace.Instance do
  @moduledoc false

  defstruct path: nil, workspace_key: "", created_now: false
end

defmodule HarnessEngineering.Workspace.AttemptResult do
  @moduledoc false

  defstruct outcome: "",
            issue: nil,
            workspace: nil,
            error_code: nil,
            error_message: nil
end

defmodule HarnessEngineering.Workspace do
  @moduledoc """
  Per-issue workspace creation and hook execution for the Elixir tracer.

  The Python implementation remains authoritative. This module mirrors its
  workspace-key sanitizer, root containment checks, and fatal versus
  best-effort hook behavior before the Elixir runtime launches any worker.
  """

  alias HarnessEngineering.Config
  alias HarnessEngineering.Config.Hooks
  alias HarnessEngineering.Models.Issue
  alias HarnessEngineering.Workflow
  alias HarnessEngineering.Workspace.AttemptResult
  alias HarnessEngineering.Workspace.Error
  alias HarnessEngineering.Workspace.Instance

  defstruct root: nil, hooks: %{}, hook_timeout_ms: 60_000

  def new(root, opts \\ []) do
    %__MODULE__{
      root: normalize_path(root),
      hooks: opts |> Keyword.get(:hooks, %{}) |> normalize_hooks(),
      hook_timeout_ms: Keyword.get(opts, :hook_timeout_ms, 60_000)
    }
  end

  def from_config(%Config{} = config) do
    new(config.workspace.root,
      hooks: Hooks.as_scripts(config.hooks),
      hook_timeout_ms: config.hooks.timeout_ms
    )
  end

  def sanitize_key(identifier) do
    Regex.replace(~r/[^A-Za-z0-9._-]/u, to_string(identifier), "_")
  end

  def create_for_issue(%__MODULE__{} = manager, %Issue{} = issue),
    do: create_for_issue(manager, issue.identifier)

  def create_for_issue(%__MODULE__{} = manager, identifier) do
    key = sanitize_key(identifier)
    workspace_path = normalize_path(Path.join(manager.root, key))

    with :ok <- validate_workspace_path(manager, workspace_path),
         :ok <- ensure_root(manager.root),
         :ok <- ensure_directory_slot(workspace_path),
         created_now = not File.exists?(workspace_path),
         :ok <- ensure_workspace(workspace_path) do
      workspace = %Instance{path: workspace_path, workspace_key: key, created_now: created_now}

      if created_now do
        case run_hook(manager, "after_create", workspace.path, fatal: true) do
          :ok -> {:ok, workspace}
          {:error, %Error{} = error} -> {:error, error}
        end
      else
        {:ok, workspace}
      end
    end
  end

  def prepare_attempt(%__MODULE__{} = manager, %Issue{} = issue) do
    case create_for_issue(manager, issue) do
      {:ok, workspace} ->
        case run_hook(manager, "before_run", workspace.path, fatal: true) do
          :ok ->
            _ = run_hook(manager, "after_run", workspace.path, fatal: false)

            {:ok,
             %AttemptResult{
               outcome: "ready",
               issue: issue,
               workspace: workspace
             }}

          {:error, %Error{} = error} ->
            {:ok, retry_result(issue, workspace, error)}
        end

      {:error, %Error{} = error} ->
        {:ok, retry_result(issue, nil, error)}
    end
  end

  def remove_for_issue(%__MODULE__{} = manager, %Issue{} = issue),
    do: remove_for_issue(manager, issue.identifier)

  def remove_for_issue(%__MODULE__{} = manager, identifier) do
    key = sanitize_key(identifier)
    workspace_path = normalize_path(Path.join(manager.root, key))

    with :ok <- validate_workspace_path(manager, workspace_path) do
      cond do
        not File.exists?(workspace_path) ->
          :ok

        not File.dir?(workspace_path) ->
          {:error, path_error("workspace_path_not_directory", workspace_path)}

        true ->
          _ = run_hook(manager, "before_remove", workspace_path, fatal: false)

          case File.rm_rf(workspace_path) do
            {:ok, _paths} -> :ok
            {:error, reason, path} -> {:error, remove_error(reason, path)}
          end
      end
    end
  end

  def validate_workspace_path(%__MODULE__{} = manager, path) do
    candidate = normalize_path(path)

    if path_inside?(manager.root, candidate) do
      :ok
    else
      {:error, outside_root_error(candidate)}
    end
  end

  def assert_agent_cwd(%__MODULE__{} = manager, cwd, workspace_path) do
    cwd_path = normalize_path(cwd)
    expected = normalize_path(workspace_path)

    with :ok <- validate_workspace_path(manager, expected) do
      if cwd_path == expected do
        :ok
      else
        {:error,
         %Error{
           code: "invalid_workspace_cwd",
           message: "agent cwd must be workspace path: cwd=#{cwd_path} workspace=#{expected}",
           path: cwd_path
         }}
      end
    end
  end

  def run_hook(%__MODULE__{} = manager, name, workspace_path, opts \\ []) do
    hook_name = to_string(name)
    fatal = Keyword.get(opts, :fatal, true)
    script = Map.get(manager.hooks, hook_name)

    if is_nil(script) or script == "" do
      :ok
    else
      cwd = normalize_path(workspace_path)

      with :ok <- validate_workspace_path(manager, cwd) do
        case run_script(script, cwd, manager.hook_timeout_ms) do
          {:ok, 0, _output} ->
            :ok

          {:ok, status, _output} ->
            if fatal do
              {:error,
               %Error{
                 code: "hook_failed",
                 message: "hook #{hook_name} failed with exit code #{status}",
                 path: cwd,
                 hook: hook_name,
                 returncode: status
               }}
            else
              :ok
            end

          {:timeout, _output} ->
            if fatal do
              {:error,
               %Error{
                 code: "hook_timeout",
                 message: "hook #{hook_name} timed out",
                 path: cwd,
                 hook: hook_name
               }}
            else
              :ok
            end
        end
      end
    end
  end

  defp normalize_path(path), do: path |> to_string() |> Workflow.realpath()

  defp normalize_hooks(hooks) when is_map(hooks) do
    hooks
    |> Enum.reject(fn {_name, script} -> is_nil(script) or script == "" end)
    |> Map.new(fn {name, script} -> {to_string(name), to_string(script)} end)
  end

  defp normalize_hooks(_hooks), do: %{}

  defp ensure_root(root) do
    case File.mkdir_p(root) do
      :ok ->
        :ok

      {:error, reason} ->
        {:error,
         %Error{
           code: "workspace_create_failed",
           message: "workspace root cannot be created: #{root} reason=#{inspect(reason)}",
           path: root
         }}
    end
  end

  defp ensure_directory_slot(path) do
    if File.exists?(path) and not File.dir?(path) do
      {:error, path_error("workspace_path_not_directory", path)}
    else
      :ok
    end
  end

  defp ensure_workspace(path) do
    case File.mkdir_p(path) do
      :ok ->
        :ok

      {:error, reason} ->
        {:error,
         %Error{
           code: "workspace_create_failed",
           message: "workspace cannot be created: #{path} reason=#{inspect(reason)}",
           path: path
         }}
    end
  end

  defp path_error(code, path) do
    %Error{code: code, message: "workspace path is not a directory: #{path}", path: path}
  end

  defp outside_root_error(path) do
    %Error{
      code: "workspace_outside_root",
      message: "workspace path is outside root: #{path}",
      path: path
    }
  end

  defp remove_error(reason, path) do
    %Error{
      code: "workspace_remove_failed",
      message: "workspace cannot be removed: #{path} reason=#{inspect(reason)}",
      path: path
    }
  end

  defp retry_result(issue, workspace, %Error{} = error) do
    %AttemptResult{
      outcome: "retry",
      issue: issue,
      workspace: workspace,
      error_code: error.code,
      error_message: Exception.message(error)
    }
  end

  defp path_inside?(root, candidate) do
    root_parts = Path.split(root)
    candidate_parts = Path.split(candidate)
    Enum.take(candidate_parts, length(root_parts)) == root_parts
  end

  defp run_script(script, cwd, timeout_ms) do
    shell = System.find_executable("sh") || "/bin/sh"

    port =
      Port.open({:spawn_executable, shell}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        :use_stdio,
        {:args, ["-lc", script]},
        {:cd, cwd}
      ])

    collect_port(port, System.monotonic_time(:millisecond) + timeout_ms, [])
  end

  defp collect_port(port, deadline_ms, chunks) do
    remaining_ms = max(deadline_ms - System.monotonic_time(:millisecond), 0)

    receive do
      {^port, {:data, data}} ->
        collect_port(port, deadline_ms, [data | chunks])

      {^port, {:exit_status, status}} ->
        {:ok, status, chunks |> Enum.reverse() |> IO.iodata_to_binary()}
    after
      remaining_ms ->
        close_port(port)
        {:timeout, chunks |> Enum.reverse() |> IO.iodata_to_binary()}
    end
  end

  defp close_port(port) do
    try do
      Port.close(port)
    catch
      _kind, _reason -> :ok
    end
  end
end
