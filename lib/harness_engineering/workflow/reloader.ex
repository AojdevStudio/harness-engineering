defmodule HarnessEngineering.Workflow.Reloader do
  @moduledoc """
  Keeps the last known good workflow active across reload failures.
  """

  alias HarnessEngineering.Workflow
  alias HarnessEngineering.Workflow.LoadError

  defstruct path: nil, current: nil, last_error: nil, last_mtime: nil

  def load_initial(path) do
    workflow_path = Workflow.realpath(path)

    with {:ok, workflow} <- Workflow.load(workflow_path),
         {:ok, stat} <- File.stat(workflow.path, time: :posix) do
      {:ok,
       %__MODULE__{
         path: workflow.path,
         current: workflow,
         last_error: nil,
         last_mtime: stat.mtime
       }}
    else
      {:error, %LoadError{} = error} ->
        {:error, error}

      {:error, _reason} ->
        {:error,
         %LoadError{
           code: "missing_workflow_file",
           message: "workflow file cannot be statted: #{workflow_path}",
           path: workflow_path
         }}
    end
  end

  def reload_if_changed(%__MODULE__{} = reloader, opts \\ []) do
    force = Keyword.get(opts, :force, false)

    case File.stat(reloader.path, time: :posix) do
      {:ok, stat} ->
        if not force and stat.mtime == reloader.last_mtime do
          {:unchanged, reloader}
        else
          reload(reloader, stat.mtime)
        end

      {:error, _reason} ->
        error = %LoadError{
          code: "missing_workflow_file",
          message: "workflow file cannot be statted: #{reloader.path}",
          path: reloader.path
        }

        {:error, %{reloader | last_error: error}}
    end
  end

  defp reload(reloader, mtime) do
    case Workflow.load(reloader.path) do
      {:ok, workflow} ->
        {:ok, %{reloader | current: workflow, last_error: nil, last_mtime: mtime}}

      {:error, error} ->
        {:error, %{reloader | last_error: error}}
    end
  end
end
