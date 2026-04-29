defmodule HarnessEngineering.CLI do
  @moduledoc """
  Command-line entrypoint for the Elixir tracer bullet.

  This first port slice validates startup and workflow loading only. It does
  not launch workers. A fixture-backed one-shot mode can prove candidate
  selection without reaching the GitHub API.
  """

  alias HarnessEngineering.Config
  alias HarnessEngineering.GitHubTracker
  alias HarnessEngineering.Runtime
  alias HarnessEngineering.Workflow

  def main(argv \\ System.argv()) do
    case parse_args(argv) do
      {:ok, opts, args} ->
        workflow_path = Workflow.select_path(List.first(args), File.cwd!())

        with {:ok, _apps} <- Application.ensure_all_started(:harness_engineering) do
          run_mode(workflow_path, opts)
        else
          {:error, error} ->
            print_startup_error(error)
            1
        end

      {:error, message} ->
        IO.puts(:stderr, "startup failed code=invalid_cli_args reason=#{message}")
        1
    end
  end

  defp parse_args(argv) do
    {opts, args, invalid} =
      OptionParser.parse(argv,
        strict: [once: :boolean, port: :integer, log_level: :string, github_fixture: :string],
        aliases: []
      )

    case invalid do
      [] -> {:ok, opts, args}
      [{flag, value} | _] -> {:error, "invalid option #{flag}=#{value}"}
    end
  end

  defp run_mode(workflow_path, opts) do
    case Keyword.get(opts, :github_fixture) do
      nil -> load_only(workflow_path, opts)
      fixture_path -> dry_run_candidates(workflow_path, fixture_path)
    end
  end

  defp load_only(workflow_path, opts) do
    case Runtime.load_workflow(workflow_path) do
      {:ok, _result} ->
        if Keyword.get(opts, :once, false) do
          IO.puts("workflow loaded path=#{workflow_path} mode=one_shot")
        else
          IO.puts("workflow loaded path=#{workflow_path}")
        end

        0

      {:error, error} ->
        print_startup_error(error)
        1
    end
  end

  defp dry_run_candidates(workflow_path, fixture_path) do
    case Runtime.dry_run_candidates(workflow_path, fixture_path) do
      {:ok, result} ->
        selected = if is_nil(result.selected), do: "none", else: result.selected.identifier

        IO.puts(
          "candidate selection path=#{workflow_path} fixture=#{fixture_path} mode=one_shot candidates=#{length(result.candidates)} selected=#{selected}"
        )

        0

      {:error, error} ->
        print_startup_error(error)
        1
    end
  end

  defp print_startup_error(%Workflow.LoadError{} = error) do
    IO.puts(:stderr, "startup failed code=#{error.code} reason=#{Exception.message(error)}")
  end

  defp print_startup_error(%Config.Error{} = error) do
    IO.puts(:stderr, "startup failed code=#{error.code} reason=#{Exception.message(error)}")
  end

  defp print_startup_error(%GitHubTracker.Error{} = error) do
    IO.puts(:stderr, "startup failed code=#{error.code} reason=#{Exception.message(error)}")
  end

  defp print_startup_error(error) do
    IO.puts(:stderr, "startup failed code=unknown reason=#{inspect(error)}")
  end
end
