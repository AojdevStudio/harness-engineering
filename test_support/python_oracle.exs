defmodule HarnessEngineering.Test.PythonOracle do
  @moduledoc false

  @script """
  import base64
  import os
  import sys

  from harness_engineering.config import ServiceConfig
  from harness_engineering.workflow import load_workflow

  SEP = "\\x1f"

  def emit(key, value):
      if value is None:
          value = ""
      if not isinstance(value, str):
          value = str(value)
      encoded = base64.b64encode(value.encode("utf-8")).decode("ascii")
      print(f"{key}={encoded}")

  def emit_list(key, values):
      emit(key, SEP.join(values))

  def emit_map(key, values):
      rendered = SEP.join(f"{k}:{v}" for k, v in sorted(values.items()))
      emit(key, rendered)

  def summarize(path, validate):
      workflow = load_workflow(path)
      config = ServiceConfig.from_workflow(workflow, path, env=os.environ)
      if validate:
          config.validate_dispatch()
      emit("status", "ok")
      emit("path", str(workflow.path))
      emit("prompt_template", workflow.prompt_template)
      emit("tracker_kind", config.tracker.kind)
      emit("tracker_endpoint", config.tracker.endpoint)
      emit("tracker_api_key", config.tracker.api_key)
      emit("tracker_owner", config.tracker.owner)
      emit("tracker_repo", config.tracker.repo)
      emit_list("tracker_active_states", config.tracker.active_states)
      emit_list("tracker_terminal_states", config.tracker.terminal_states)
      emit("polling_interval_ms", config.polling.interval_ms)
      emit("workspace_root", str(config.workspace.root))
      emit("hooks_after_create", config.hooks.after_create)
      emit("hooks_before_run", config.hooks.before_run)
      emit("hooks_timeout_ms", config.hooks.timeout_ms)
      emit("agent_max_concurrent_agents", config.agent.max_concurrent_agents)
      emit("agent_max_turns", config.agent.max_turns)
      emit("agent_max_retry_backoff_ms", config.agent.max_retry_backoff_ms)
      emit_map("agent_max_concurrent_agents_by_state", config.agent.max_concurrent_agents_by_state)
      emit("codex_command", config.codex.command)
      emit("codex_turn_timeout_ms", config.codex.turn_timeout_ms)
      emit("codex_read_timeout_ms", config.codex.read_timeout_ms)
      emit("codex_stall_timeout_ms", config.codex.stall_timeout_ms)
      emit("server_port", config.server.port)
      emit("server_host", config.server.host)

  try:
      summarize(sys.argv[1], sys.argv[2] == "validate")
  except Exception as exc:
      emit("status", "error")
      emit("code", getattr(exc, "code", "unknown"))
      emit("message", str(exc))
  """

  @candidate_script """
  import base64
  import json
  import os
  import sys
  from datetime import datetime

  from harness_engineering.config import ServiceConfig
  from harness_engineering.github_tracker import GitHubTracker
  from harness_engineering.models import BlockerRef, Issue
  from harness_engineering.orchestrator import OrchestratorState, should_dispatch, sort_for_dispatch
  from harness_engineering.workflow import load_workflow

  def emit(key, value):
      if value is None:
          value = ""
      if not isinstance(value, str):
          value = str(value)
      encoded = base64.b64encode(value.encode("utf-8")).decode("ascii")
      print(f"{key}={encoded}")

  class FixtureTransport:
      def __init__(self, responses):
          self.responses = list(responses)
          self.calls = []

      def execute(self, query, variables, *, endpoint, api_key):
          self.calls.append({"query": query, "variables": variables})
          if not self.responses:
              raise RuntimeError("fixture exhausted")
          return self.responses.pop(0)

  def parse_datetime(value):
      if not value:
          return None
      try:
          return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
      except ValueError:
          return None

  def issue_from_map(value):
      return Issue(
          id=str(value.get("id") or ""),
          identifier=str(value.get("identifier") or ""),
          title=str(value.get("title") or ""),
          state=str(value.get("state") or "").lower(),
          description=value.get("description"),
          priority=value.get("priority"),
          branch_name=value.get("branch_name"),
          url=value.get("url"),
          labels=[str(label).lower() for label in value.get("labels", [])],
          blocked_by=[
              BlockerRef(
                  id=blocker.get("id"),
                  identifier=blocker.get("identifier"),
                  state=str(blocker.get("state")).lower() if blocker.get("state") else None,
              )
              for blocker in value.get("blocked_by", [])
              if isinstance(blocker, dict)
          ],
          created_at=parse_datetime(value.get("created_at")),
          updated_at=parse_datetime(value.get("updated_at")),
      )

  def summarize(path, fixture_path):
      workflow = load_workflow(path)
      config = ServiceConfig.from_workflow(workflow, path, env=os.environ)
      config.validate_dispatch()
      with open(fixture_path, encoding="utf-8") as file:
          fixture = json.load(file)
      responses = fixture if isinstance(fixture, list) else fixture.get("responses", [])
      fixture_state = {} if isinstance(fixture, list) else fixture.get("state", {})
      transport = FixtureTransport(responses)
      tracker = GitHubTracker(config.tracker, transport=transport)
      candidates = tracker.fetch_candidate_issues()
      state = OrchestratorState(
          max_concurrent_agents=config.agent.max_concurrent_agents,
          active_states=set(config.tracker.active_states),
          terminal_states=set(config.tracker.terminal_states),
          max_concurrent_agents_by_state=config.agent.max_concurrent_agents_by_state,
      )
      for item in fixture_state.get("running", []):
          issue = issue_from_map(item)
          state.running[issue.id] = issue
      state.claimed.update(str(item) for item in fixture_state.get("claimed", []))
      selected = None
      for issue in sort_for_dispatch(candidates):
          if should_dispatch(issue, state):
              selected = issue
              break
      emit("status", "ok")
      emit("selected_identifier", selected.identifier if selected else "")
      emit("candidate_identifiers", json.dumps([issue.identifier for issue in candidates], sort_keys=True))
      emit("normalized_issues", json.dumps([issue.to_dict() for issue in candidates], sort_keys=True))
      emit("calls", json.dumps(transport.calls, sort_keys=True))

  try:
      summarize(sys.argv[1], sys.argv[2])
  except Exception as exc:
      emit("status", "error")
      emit("code", getattr(exc, "code", "unknown"))
      emit("message", str(exc))
  """

  def summary(path, env \\ %{}, mode \\ :load) do
    validate = if mode == :validate, do: "validate", else: "load"
    uv_cache = Path.join(System.tmp_dir!(), "harness-engineering-uv-cache")
    File.mkdir_p!(uv_cache)
    env = Map.put_new(env, "UV_CACHE_DIR", uv_cache)

    case System.cmd("uv", ["run", "python", "-c", @script, path, validate],
           env: Map.to_list(env),
           stderr_to_stdout: true
         ) do
      {output, 0} ->
        parse(output)

      {output, status} ->
        %{"status" => "command_failed", "code" => "#{status}", "message" => output}
    end
  end

  def candidate_selection(path, fixture_path, env \\ %{}) do
    uv_cache = Path.join(System.tmp_dir!(), "harness-engineering-uv-cache")
    File.mkdir_p!(uv_cache)
    env = Map.put_new(env, "UV_CACHE_DIR", uv_cache)

    case System.cmd("uv", ["run", "python", "-c", @candidate_script, path, fixture_path],
           env: Map.to_list(env),
           stderr_to_stdout: true
         ) do
      {output, 0} ->
        parse(output)

      {output, status} ->
        %{"status" => "command_failed", "code" => "#{status}", "message" => output}
    end
  end

  defp parse(output) do
    output
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case String.split(line, "=", parts: 2) do
        [key, encoded] ->
          case Base.decode64(encoded) do
            {:ok, value} -> [{key, value}]
            :error -> []
          end

        _ ->
          []
      end
    end)
    |> Map.new()
  end
end
