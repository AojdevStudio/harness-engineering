defmodule HarnessEngineering.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      HarnessEngineering.Runtime
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: HarnessEngineering.Supervisor)
  end
end
