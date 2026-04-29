defmodule HarnessEngineering.Runtime do
  @moduledoc """
  Supervised runtime state for the Elixir port.

  The tracer bullet intentionally stops at load and dispatch validation. Worker
  polling and dispatch stay out of this module until the port has parity tests
  for the lower-level workflow contract.
  """

  use GenServer

  alias HarnessEngineering.Config
  alias HarnessEngineering.Workflow.Reloader

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  def load_workflow(path, opts \\ []) do
    env = Keyword.get(opts, :env, System.get_env())
    GenServer.call(__MODULE__, {:load_workflow, path, env})
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
end
