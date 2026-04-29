defmodule HarnessEngineering.MixProject do
  use Mix.Project

  def project do
    [
      app: :harness_engineering,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: [],
      escript: [main_module: HarnessEngineering.CLI]
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {HarnessEngineering.Application, []}
    ]
  end
end
