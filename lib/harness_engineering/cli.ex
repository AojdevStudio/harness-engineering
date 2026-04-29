defmodule HarnessEngineering.CLI do
  @moduledoc """
  Command-line entrypoint for the Elixir tracer bullet.

  This first port slice validates startup and workflow loading only. It does
  not poll the tracker or dispatch workers.
  """

  alias HarnessEngineering.Config
  alias HarnessEngineering.Runtime
  alias HarnessEngineering.Workflow

  def main(argv \\ System.argv()) do
    case parse_args(argv) do
      {:ok, opts, args} ->
        workflow_path = Workflow.select_path(List.first(args), File.cwd!())

        with {:ok, _apps} <- Application.ensure_all_started(:harness_engineering),
             {:ok, _result} <- Runtime.load_workflow(workflow_path) do
          if Keyword.get(opts, :once, false) do
            IO.puts("workflow loaded path=#{workflow_path} mode=one_shot")
          else
            IO.puts("workflow loaded path=#{workflow_path}")
          end

          0
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
        strict: [once: :boolean, port: :integer, log_level: :string],
        aliases: []
      )

    case invalid do
      [] -> {:ok, opts, args}
      [{flag, value} | _] -> {:error, "invalid option #{flag}=#{value}"}
    end
  end

  defp print_startup_error(%Workflow.LoadError{} = error) do
    IO.puts(:stderr, "startup failed code=#{error.code} reason=#{Exception.message(error)}")
  end

  defp print_startup_error(%Config.Error{} = error) do
    IO.puts(:stderr, "startup failed code=#{error.code} reason=#{Exception.message(error)}")
  end

  defp print_startup_error(error) do
    IO.puts(:stderr, "startup failed code=unknown reason=#{inspect(error)}")
  end
end
