defmodule HarnessEngineering.GitHubTracker.Error do
  @moduledoc false

  defexception [:code, :message, :payload]

  @impl true
  def exception(opts) do
    %__MODULE__{
      code: Keyword.fetch!(opts, :code),
      message: Keyword.fetch!(opts, :message),
      payload: Keyword.get(opts, :payload)
    }
  end
end

defmodule HarnessEngineering.GitHubTracker.FixtureTransport do
  @moduledoc false

  use Agent

  alias HarnessEngineering.GitHubTracker.Error

  def start_link(responses) when is_list(responses) do
    Agent.start_link(fn -> %{responses: responses, calls: []} end)
  end

  def from_file(path) do
    with {:ok, body} <- File.read(path),
         {:ok, fixture} <- decode_json(body),
         {:ok, responses} <- fixture_responses(fixture),
         {:ok, pid} <- start_link(responses) do
      {:ok, %{transport: {__MODULE__, pid}, fixture: fixture, pid: pid}}
    else
      {:error, %Error{} = error} ->
        {:error, error}

      {:error, reason} ->
        {:error,
         %Error{code: "fixture_load_failed", message: "fixture load failed: #{inspect(reason)}"}}
    end
  end

  def execute(pid, query, variables, _opts) do
    Agent.get_and_update(pid, fn state ->
      case state.responses do
        [response | rest] ->
          call = %{"query" => query, "variables" => variables}
          {{:ok, response}, %{state | responses: rest, calls: state.calls ++ [call]}}

        [] ->
          error = %Error{
            code: "fixture_exhausted",
            message: "GitHub fixture transport has no responses left"
          }

          {{:error, error}, state}
      end
    end)
  end

  def calls(pid) do
    Agent.get(pid, & &1.calls)
  end

  def stop(pid) do
    Agent.stop(pid)
  end

  def decode_json(body) do
    {:ok, body |> :json.decode() |> normalize_json()}
  rescue
    _error ->
      {:error,
       %Error{code: "fixture_parse_error", message: "fixture file must contain valid JSON"}}
  end

  defp normalize_json(:null), do: nil

  defp normalize_json(value) when is_list(value), do: Enum.map(value, &normalize_json/1)

  defp normalize_json(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {to_string(key), normalize_json(item)} end)
    |> Map.new()
  end

  defp normalize_json(value), do: value

  defp fixture_responses(value) when is_list(value), do: {:ok, value}

  defp fixture_responses(%{"responses" => responses}) when is_list(responses),
    do: {:ok, responses}

  defp fixture_responses(_value) do
    {:error,
     %Error{
       code: "fixture_missing_responses",
       message: "fixture must be a response array or contain responses[]"
     }}
  end
end

defmodule HarnessEngineering.GitHubTracker do
  @moduledoc """
  GitHub issue tracker adapter for the Elixir port.

  The transport is injected so tests and one-shot dry runs can use captured
  GraphQL responses without network access.
  """

  alias HarnessEngineering.Config.Tracker
  alias HarnessEngineering.GitHubTracker.Error
  alias HarnessEngineering.Models.BlockerRef
  alias HarnessEngineering.Models.Issue

  @candidate_query """
  query HarnessCandidateIssues($owner: String!, $repo: String!, $states: [IssueState!], $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: $first, after: $after, states: $states, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes {
          id
          number
          title
          body
          state
          url
          createdAt
          updatedAt
          labels(first: 50) {
            nodes { name }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
  """

  def fetch_candidate_issues(%Tracker{} = config, transport, page_size \\ 50) do
    fetch_by_states(config, transport, config.active_states, page_size)
  end

  def fetch_by_states(_config, _transport, [], _page_size), do: {:ok, []}

  def fetch_by_states(%Tracker{} = config, transport, states, page_size) do
    graphql_states = Enum.map(states, &github_state/1)
    do_fetch_by_states(config, transport, graphql_states, page_size, nil, [])
  end

  def normalize_issue_node(node, %Tracker{} = config) when is_map(node) do
    labels =
      node
      |> get_in(["labels", "nodes"])
      |> case do
        values when is_list(values) -> values
        _ -> []
      end
      |> Enum.flat_map(fn
        %{"name" => name} when not is_nil(name) -> [name |> to_string() |> String.downcase()]
        _other -> []
      end)

    number = Map.get(node, "number")
    repo = config.repo || ""

    %Issue{
      id: string_value(Map.get(node, "id")),
      identifier: "#{repo}##{number}",
      title: string_value(Map.get(node, "title")),
      description: optional_string(Map.get(node, "body")),
      priority: priority_from_labels(labels),
      state: node |> Map.get("state") |> string_value() |> String.downcase(),
      branch_name: nil,
      url: optional_string(Map.get(node, "url")),
      labels: labels,
      blocked_by: blocked_refs(node, repo),
      created_at: parse_datetime(Map.get(node, "createdAt")),
      updated_at: parse_datetime(Map.get(node, "updatedAt"))
    }
  end

  defp do_fetch_by_states(config, transport, graphql_states, page_size, after_cursor, acc) do
    variables = %{
      "owner" => config.owner,
      "repo" => config.repo,
      "states" => graphql_states,
      "first" => page_size,
      "after" => after_cursor
    }

    with {:ok, payload} <-
           execute(transport, @candidate_query, variables,
             endpoint: config.endpoint,
             api_key: config.api_key
           ),
         {:ok, connection} <- issue_connection(payload),
         {:ok, nodes} <- issue_nodes(connection),
         {:ok, page_info} <- page_info(connection) do
      issues =
        nodes
        |> Enum.filter(&is_map/1)
        |> Enum.map(&normalize_issue_node(&1, config))

      if Map.get(page_info, "hasNextPage") do
        case Map.get(page_info, "endCursor") do
          nil ->
            {:error,
             %Error{
               code: "github_missing_end_cursor",
               message: "GitHub pagination reported next page without endCursor"
             }}

          cursor ->
            do_fetch_by_states(
              config,
              transport,
              graphql_states,
              page_size,
              cursor,
              acc ++ issues
            )
        end
      else
        {:ok, acc ++ issues}
      end
    end
  end

  defp execute({module, ref}, query, variables, opts),
    do: module.execute(ref, query, variables, opts)

  defp execute(module, query, variables, opts) when is_atom(module),
    do: module.execute(query, variables, opts)

  defp issue_connection(payload) do
    case get_in(payload, ["data", "repository", "issues"]) do
      value when is_map(value) ->
        {:ok, value}

      _ ->
        {:error,
         %Error{
           code: "github_unknown_payload",
           message: "missing repository.issues in GitHub response",
           payload: payload
         }}
    end
  end

  defp issue_nodes(connection) do
    case Map.get(connection, "nodes") do
      value when is_list(value) ->
        {:ok, value}

      _ ->
        {:error,
         %Error{
           code: "github_unknown_payload",
           message: "missing issue nodes in GitHub response",
           payload: connection
         }}
    end
  end

  defp page_info(connection) do
    case Map.get(connection, "pageInfo") do
      value when is_map(value) ->
        {:ok, value}

      _ ->
        {:error,
         %Error{
           code: "github_unknown_payload",
           message: "missing pageInfo in GitHub response",
           payload: connection
         }}
    end
  end

  defp github_state(state) do
    case state |> to_string() |> String.downcase() do
      value when value in ["open", "todo", "in progress", "in_progress"] -> "OPEN"
      value when value in ["closed", "done", "cancelled", "canceled", "duplicate"] -> "CLOSED"
      value -> String.upcase(value)
    end
  end

  defp priority_from_labels(labels) do
    Enum.find_value(labels, fn label ->
      case Regex.run(~r/(?:^priority[:\s-]*|^p)(\d+)$/, label) do
        [_match, value] -> String.to_integer(value)
        _ -> nil
      end
    end)
  end

  defp blocked_refs(node, repo) do
    node_refs =
      node
      |> Map.get("blockedBy")
      |> blocked_nodes()
      |> Enum.map(&blocked_ref_from_node(&1, repo))

    body_refs =
      node
      |> Map.get("body")
      |> blocked_refs_from_body(repo)

    (node_refs ++ body_refs)
    |> Enum.uniq_by(fn blocker -> {blocker.id, blocker.identifier} end)
  end

  defp blocked_nodes(%{"nodes" => nodes}) when is_list(nodes), do: nodes
  defp blocked_nodes(nodes) when is_list(nodes), do: nodes
  defp blocked_nodes(_value), do: []

  defp blocked_ref_from_node(node, repo) do
    number = Map.get(node, "number")
    identifier = Map.get(node, "identifier") || if number, do: "#{repo}##{number}", else: nil

    %BlockerRef{
      id: optional_string(Map.get(node, "id")),
      identifier: optional_string(identifier),
      state: node |> Map.get("state") |> optional_downcase()
    }
  end

  defp blocked_refs_from_body(nil, _repo), do: []

  defp blocked_refs_from_body(body, repo) do
    case Regex.run(~r/(?is)^##\s*Blocked by\s*(.*?)(?:^##\s+|\z)/m, to_string(body),
           capture: :all_but_first
         ) do
      [section] ->
        Regex.scan(~r/#(\d+)/, section)
        |> Enum.map(fn [_match, number] -> %BlockerRef{identifier: "#{repo}##{number}"} end)

      _ ->
        []
    end
  end

  defp parse_datetime(nil), do: nil

  defp parse_datetime(value) do
    value
    |> to_string()
    |> DateTime.from_iso8601()
    |> case do
      {:ok, datetime, _offset} -> datetime
      _ -> nil
    end
  end

  defp string_value(nil), do: ""
  defp string_value(value), do: to_string(value)

  defp optional_string(nil), do: nil
  defp optional_string(""), do: nil
  defp optional_string(value), do: to_string(value)

  defp optional_downcase(nil), do: nil
  defp optional_downcase(value), do: value |> to_string() |> String.downcase()
end
