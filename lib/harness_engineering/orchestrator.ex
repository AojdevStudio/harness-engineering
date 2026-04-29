defmodule HarnessEngineering.Orchestrator.State do
  @moduledoc false

  alias HarnessEngineering.Config
  alias HarnessEngineering.Models.Issue

  defstruct max_concurrent_agents: 10,
            active_states: MapSet.new(),
            terminal_states: MapSet.new(),
            running: %{},
            claimed: MapSet.new(),
            max_concurrent_agents_by_state: %{}

  def from_config(%Config{} = config, fixture_state \\ %{}) do
    running =
      fixture_state
      |> Map.get("running", [])
      |> Enum.filter(&is_map/1)
      |> Enum.map(&Issue.from_map/1)
      |> Map.new(fn issue -> {issue.id, issue} end)

    claimed =
      fixture_state
      |> Map.get("claimed", [])
      |> Enum.map(&to_string/1)
      |> MapSet.new()

    %__MODULE__{
      max_concurrent_agents: config.agent.max_concurrent_agents,
      active_states: MapSet.new(config.tracker.active_states),
      terminal_states: MapSet.new(config.tracker.terminal_states),
      running: running,
      claimed: claimed,
      max_concurrent_agents_by_state: config.agent.max_concurrent_agents_by_state
    }
  end
end

defmodule HarnessEngineering.Orchestrator do
  @moduledoc false

  alias HarnessEngineering.Models.Issue
  alias HarnessEngineering.Orchestrator.State

  def sort_for_dispatch(issues) do
    Enum.sort_by(issues, fn issue ->
      {
        if(is_nil(issue.priority), do: 999_999, else: issue.priority),
        issue.created_at || DateTime.from_unix!(253_402_300_799),
        issue.identifier
      }
    end)
  end

  def available_slots(%State{} = state, state_name \\ nil) do
    global_slots = max(state.max_concurrent_agents - map_size(state.running), 0)

    if is_nil(state_name) do
      global_slots
    else
      normalized = state_name |> to_string() |> String.downcase()

      per_state_limit =
        Map.get(state.max_concurrent_agents_by_state, normalized, state.max_concurrent_agents)

      running_in_state =
        state.running
        |> Map.values()
        |> Enum.count(fn issue -> issue.state == normalized end)

      min(global_slots, max(per_state_limit - running_in_state, 0))
    end
  end

  def should_dispatch(%Issue{} = issue, %State{} = state) do
    issue_state = String.downcase(issue.state || "")

    cond do
      issue.id == "" or issue.identifier == "" or issue.title == "" or issue.state == "" ->
        false

      not MapSet.member?(state.active_states, issue_state) ->
        false

      MapSet.member?(state.terminal_states, issue_state) ->
        false

      Map.has_key?(state.running, issue.id) or MapSet.member?(state.claimed, issue.id) ->
        false

      available_slots(state, issue_state) <= 0 ->
        false

      issue_state == "todo" and blocked?(issue, state) ->
        false

      true ->
        true
    end
  end

  def select_dispatch_candidate(issues, %State{} = state) do
    issues
    |> sort_for_dispatch()
    |> Enum.find(&should_dispatch(&1, state))
  end

  defp blocked?(%Issue{} = issue, %State{} = state) do
    Enum.any?(issue.blocked_by, fn blocker ->
      blocker_state = (blocker.state || "") |> String.downcase()
      not MapSet.member?(state.terminal_states, blocker_state)
    end)
  end
end
