defmodule HarnessEngineering.Runtime do
  @moduledoc """
  Supervised runtime state for the Elixir port.

  The tracer bullet intentionally stops before launching workers. It can load
  workflow config, dry-run candidate selection, and prepare one selected issue's
  workspace with hooks.
  """

  use GenServer

  alias HarnessEngineering.Config
  alias HarnessEngineering.GitHubTracker
  alias HarnessEngineering.GitHubTracker.FixtureTransport
  alias HarnessEngineering.Orchestrator
  alias HarnessEngineering.Orchestrator.State
  alias HarnessEngineering.Workspace
  alias HarnessEngineering.Workflow.Reloader

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  def load_workflow(path, opts \\ []) do
    env = Keyword.get(opts, :env, System.get_env())
    GenServer.call(__MODULE__, {:load_workflow, path, env})
  end

  def dry_run_candidates(path, fixture_path, opts \\ []) do
    env = Keyword.get(opts, :env, System.get_env())
    GenServer.call(__MODULE__, {:dry_run_candidates, path, fixture_path, env})
  end

  def dry_run_workspace(path, fixture_path, opts \\ []) do
    env = Keyword.get(opts, :env, System.get_env())
    GenServer.call(__MODULE__, {:dry_run_workspace, path, fixture_path, env})
  end

  def reload_if_changed(opts \\ []) do
    env = Keyword.get(opts, :env, System.get_env())
    force = Keyword.get(opts, :force, false)
    GenServer.call(__MODULE__, {:reload_if_changed, env, force})
  end

  @impl true
  def init(_opts) do
    {:ok, %{workflow: nil, config: nil, reloader: nil}}
  end

  @impl true
  def handle_call({:load_workflow, path, env}, _from, state) do
    with {:ok, reloader} <- Reloader.load_initial(path),
         {:ok, config} <- Config.from_workflow(reloader.current, reloader.current.path, env),
         :ok <- Config.validate_dispatch(config) do
      result = %{workflow: reloader.current, config: config}

      {:reply, {:ok, result},
       %{state | workflow: reloader.current, config: config, reloader: reloader}}
    else
      {:error, error} ->
        {:reply, {:error, error}, state}
    end
  end

  @impl true
  def handle_call({:dry_run_candidates, path, fixture_path, env}, _from, state) do
    with {:ok, result} <- build_candidate_result(path, fixture_path, env) do
      reloader = result.reloader
      config = result.config
      result = Map.drop(result, [:reloader])

      {:reply, {:ok, result},
       %{state | workflow: reloader.current, config: config, reloader: reloader}}
    else
      {:error, error} ->
        {:reply, {:error, error}, state}
    end
  end

  @impl true
  def handle_call({:dry_run_workspace, path, fixture_path, env}, _from, state) do
    with {:ok, result} <- build_candidate_result(path, fixture_path, env),
         {:ok, attempt} <- prepare_workspace_attempt(result.config, result.selected) do
      reloader = result.reloader
      result = result |> Map.drop([:reloader]) |> Map.put(:attempt, attempt)

      {:reply, {:ok, result},
       %{state | workflow: reloader.current, config: result.config, reloader: reloader}}
    else
      {:error, error} ->
        {:reply, {:error, error}, state}
    end
  end

  @impl true
  def handle_call({:reload_if_changed, _env, _force}, _from, %{reloader: nil} = state) do
    error = %Config.Error{
      code: "workflow_not_loaded",
      message: "workflow must be loaded before reload"
    }

    {:reply, {:error, error}, state}
  end

  def handle_call({:reload_if_changed, env, force}, _from, state) do
    case Reloader.reload_if_changed(state.reloader, force: force) do
      {:unchanged, reloader} ->
        {:reply, {:ok, :unchanged}, %{state | reloader: reloader}}

      {:ok, reloader} ->
        with {:ok, config} <- Config.from_workflow(reloader.current, reloader.current.path, env),
             :ok <- Config.validate_dispatch(config) do
          result = %{workflow: reloader.current, config: config}

          {:reply, {:ok, result},
           %{state | workflow: reloader.current, config: config, reloader: reloader}}
        else
          {:error, error} ->
            {:reply, {:error, error}, %{state | reloader: reloader}}
        end

      {:error, reloader} ->
        {:reply, {:error, reloader.last_error}, %{state | reloader: reloader}}
    end
  end

  defp build_candidate_result(path, fixture_path, env) do
    with {:ok, reloader} <- Reloader.load_initial(path),
         {:ok, config} <- Config.from_workflow(reloader.current, reloader.current.path, env),
         :ok <- Config.validate_dispatch(config),
         {:ok, fixture} <- FixtureTransport.from_file(fixture_path),
         {:ok, candidates} <-
           GitHubTracker.fetch_candidate_issues(config.tracker, fixture.transport) do
      fixture_state = Map.get(fixture.fixture, "state", %{})
      orchestrator_state = State.from_config(config, fixture_state)
      selected = Orchestrator.select_dispatch_candidate(candidates, orchestrator_state)
      calls = FixtureTransport.calls(fixture.pid)
      FixtureTransport.stop(fixture.pid)

      {:ok,
       %{
         reloader: reloader,
         workflow: reloader.current,
         config: config,
         candidates: candidates,
         selected: selected,
         calls: calls
       }}
    end
  end

  defp prepare_workspace_attempt(_config, nil) do
    {:ok, %{outcome: "skipped", issue: nil, workspace: nil, error_code: nil, error_message: nil}}
  end

  defp prepare_workspace_attempt(config, selected) do
    config
    |> Workspace.from_config()
    |> Workspace.prepare_attempt(selected)
  end
end
