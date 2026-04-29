ExUnit.configure(exclude: [codex_smoke: true])
ExUnit.start()
Code.require_file("../test_support/python_oracle.exs", __DIR__)
