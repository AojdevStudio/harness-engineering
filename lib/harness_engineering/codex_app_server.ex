defmodule HarnessEngineering.CodexAppServer.Error do
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

defmodule HarnessEngineering.CodexAppServer.Event do
  @moduledoc false

  defstruct event: "",
            method: nil,
            params: %{},
            usage: nil,
            timestamp_ms: nil
end

defmodule HarnessEngineering.CodexAppServer.Result do
  @moduledoc false

  defstruct outcome: "",
            thread_id: nil,
            turn_id: nil,
            codex_app_server_pid: nil,
            events: [],
            error_code: nil,
            error_message: nil
end

defmodule HarnessEngineering.CodexAppServer.Protocol do
  @moduledoc """
  Reads the generated Codex app-server JSON Schema bundles.

  This intentionally validates only the narrow spike surface: request,
  notification, and server-request method names. Payload shape remains Codex's
  generated-schema responsibility until the Elixir port hardens this boundary.
  """

  alias HarnessEngineering.CodexAppServer.Error

  @schema_dir Path.expand("../../docs/generated/codex-app-server/json-schema", __DIR__)
  @schema_files [
    Path.join(@schema_dir, "codex_app_server_protocol.schemas.json"),
    Path.join(@schema_dir, "codex_app_server_protocol.v2.schemas.json")
  ]

  @method_groups %{
    client_request: "ClientRequest",
    client_notification: "ClientNotification",
    server_request: "ServerRequest",
    server_notification: "ServerNotification"
  }

  def schema_files, do: @schema_files

  def methods(group) when is_atom(group) do
    schema_method_set(group)
    |> MapSet.to_list()
    |> Enum.sort()
  end

  def method?(group, method) when is_atom(group) do
    MapSet.member?(schema_method_set(group), to_string(method))
  end

  def ensure_method(group, method) when is_atom(group) do
    if method?(group, method) do
      :ok
    else
      {:error,
       %Error{
         code: "unsupported_protocol_method",
         message: "#{group} method is not present in generated Codex schema: #{method}",
         payload: %{group: group, method: method}
       }}
    end
  end

  defp schema_method_set(group) do
    @schema_files
    |> Enum.flat_map(&extract_methods(&1, group))
    |> MapSet.new()
  end

  defp extract_methods(path, group) do
    with {:ok, body} <- File.read(path),
         {:ok, schema} <- decode_json(body),
         definition_name when is_binary(definition_name) <- Map.get(@method_groups, group),
         %{"definitions" => definitions} <- schema,
         %{"oneOf" => variants} <- Map.get(definitions, definition_name) do
      variants
      |> Enum.map(&get_in(&1, ["properties", "method", "enum"]))
      |> Enum.filter(&is_list/1)
      |> Enum.flat_map(& &1)
      |> Enum.map(&to_string/1)
    else
      _ -> []
    end
  end

  defp decode_json(body) do
    {:ok, body |> :json.decode() |> normalize_json()}
  rescue
    _error -> {:error, :invalid_json}
  end

  defp normalize_json(:null), do: nil
  defp normalize_json(value) when is_list(value), do: Enum.map(value, &normalize_json/1)

  defp normalize_json(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {to_string(key), normalize_json(item)} end)
    |> Map.new()
  end

  defp normalize_json(value), do: value
end

defmodule HarnessEngineering.CodexAppServer.Client do
  @moduledoc """
  Narrow JSON-RPC client for `codex app-server`.

  The spike uses raw `Port` with stdio so the app-server runs with `cd` set to
  the per-issue workspace. Host-level process containment is intentionally left
  for HITL review before this boundary is hardened.
  """

  alias HarnessEngineering.CodexAppServer.Error
  alias HarnessEngineering.CodexAppServer.Event
  alias HarnessEngineering.CodexAppServer.Protocol
  alias HarnessEngineering.CodexAppServer.Result
  alias HarnessEngineering.Config.Codex
  alias HarnessEngineering.Models.Issue
  alias HarnessEngineering.Workspace

  defstruct [:codex, :port, :buffer, :next_id, :os_pid]

  def run_turn(
        %Codex{} = codex,
        %Workspace{} = workspace_manager,
        workspace_path,
        prompt,
        opts \\ []
      ) do
    launch_cwd = Keyword.get(opts, :launch_cwd, workspace_path)
    on_event = Keyword.get(opts, :on_event, fn _event -> :ok end)
    issue = Keyword.get(opts, :issue, %Issue{identifier: "fixture#0"})

    with :ok <- Workspace.assert_agent_cwd(workspace_manager, launch_cwd, workspace_path),
         {:ok, session} <- start_session(codex, launch_cwd) do
      try do
        run_session(session, workspace_path, prompt, issue, on_event)
      after
        close_port(session.port)
      end
    end
  end

  defp run_session(session, workspace_path, prompt, issue, on_event) do
    with {:ok, session, _initialize_result, events} <-
           send_and_wait(
             session,
             "initialize",
             %{
               "clientInfo" => %{"name" => "harness-engineering", "version" => "0.1.0"},
               "capabilities" => %{"experimentalApi" => true}
             },
             [],
             on_event,
             session.codex.read_timeout_ms
           ),
         {:ok, session} <- notify(session, "initialized"),
         {:ok, session, thread_result, events} <-
           send_and_wait(
             session,
             "thread/start",
             drop_nil(%{
               "cwd" => to_string(workspace_path),
               "approvalPolicy" => session.codex.approval_policy,
               "sandbox" => session.codex.thread_sandbox,
               "serviceName" => "harness-engineering",
               "ephemeral" => false,
               "experimentalRawEvents" => false,
               "persistExtendedHistory" => true
             }),
             events,
             on_event,
             session.codex.read_timeout_ms
           ),
         {:ok, thread_id} <- required_id(thread_result, ["thread", "id"], "thread/start"),
         {:ok, session, turn_result, events} <-
           send_and_wait(
             session,
             "turn/start",
             drop_nil(%{
               "threadId" => thread_id,
               "cwd" => to_string(workspace_path),
               "approvalPolicy" => session.codex.approval_policy,
               "sandboxPolicy" => session.codex.turn_sandbox_policy,
               "input" => [
                 %{"type" => "text", "text" => prompt, "text_elements" => []}
               ]
             }),
             events,
             on_event,
             session.codex.read_timeout_ms
           ),
         {:ok, turn_id} <- required_id(turn_result, ["turn", "id"], "turn/start") do
      started =
        %Event{
          event: "session_started",
          method: "harness/session_started",
          params: %{
            "threadId" => thread_id,
            "turnId" => turn_id,
            "issueIdentifier" => issue.identifier
          },
          timestamp_ms: now_ms()
        }
        |> emit(on_event)

      stream_until_terminal(
        session,
        thread_id,
        turn_id,
        events ++ [started],
        on_event,
        deadline_ms(session.codex.turn_timeout_ms)
      )
    end
  end

  defp start_session(%Codex{} = codex, launch_cwd) do
    shell = System.find_executable("sh") || "/bin/sh"

    port =
      Port.open({:spawn_executable, shell}, [
        :binary,
        :exit_status,
        :use_stdio,
        {:args, ["-lc", codex.command]},
        {:cd, to_string(launch_cwd)}
      ])

    {:ok, %__MODULE__{codex: codex, port: port, buffer: "", next_id: 1, os_pid: os_pid(port)}}
  rescue
    error ->
      {:error,
       %Error{
         code: "port_start_failed",
         message: "codex app-server failed to launch: #{Exception.message(error)}"
       }}
  end

  defp send_and_wait(session, method, params, events, on_event, timeout_ms) do
    with {:ok, session, request_id} <- send_request(session, method, params) do
      wait_for_response(session, request_id, events, on_event, deadline_ms(timeout_ms))
    end
  end

  defp send_request(session, method, params) do
    with :ok <- Protocol.ensure_method(:client_request, method) do
      request_id = session.next_id

      message = %{
        "jsonrpc" => "2.0",
        "id" => request_id,
        "method" => method,
        "params" => params
      }

      :ok = write_message(session.port, message)
      {:ok, %{session | next_id: request_id + 1}, request_id}
    end
  end

  defp notify(session, method) do
    with :ok <- Protocol.ensure_method(:client_notification, method) do
      :ok = write_message(session.port, %{"jsonrpc" => "2.0", "method" => method})
      {:ok, session}
    end
  end

  defp send_response(session, request_id, result_or_error) do
    message =
      case result_or_error do
        {:error, error} -> %{"jsonrpc" => "2.0", "id" => request_id, "error" => error}
        result -> %{"jsonrpc" => "2.0", "id" => request_id, "result" => result}
      end

    write_message(session.port, message)
    {:ok, session}
  end

  defp wait_for_response(session, request_id, events, on_event, deadline) do
    with {:ok, session, message} <- read_message(session, deadline) do
      cond do
        Map.get(message, "id") == request_id and Map.has_key?(message, "error") ->
          {:error,
           %Error{
             code: "response_error",
             message: "Codex app-server returned error response",
             payload: Map.get(message, "error")
           }}

        Map.get(message, "id") == request_id ->
          result = Map.get(message, "result")

          if is_map(result) do
            {:ok, session, result, events}
          else
            {:error,
             %Error{
               code: "response_error",
               message: "Codex app-server returned a non-object result",
               payload: message
             }}
          end

        server_request?(message) ->
          with {:ok, session} <- handle_server_request(session, message) do
            wait_for_response(session, request_id, events, on_event, deadline)
          end

        server_notification?(message) ->
          event = message_to_event(message) |> emit(on_event)
          wait_for_response(session, request_id, events ++ [event], on_event, deadline)

        true ->
          wait_for_response(session, request_id, events, on_event, deadline)
      end
    end
  end

  defp stream_until_terminal(session, thread_id, turn_id, events, on_event, deadline) do
    with {:ok, session, message} <- read_message(session, deadline) do
      cond do
        server_request?(message) ->
          with {:ok, session} <- handle_server_request(session, message) do
            stream_until_terminal(session, thread_id, turn_id, events, on_event, deadline)
          end

        server_notification?(message) ->
          event = message_to_event(message) |> emit(on_event)
          events = events ++ [event]

          case terminal_outcome(message, turn_id) do
            nil ->
              stream_until_terminal(session, thread_id, turn_id, events, on_event, deadline)

            %Result{} = result ->
              {:ok,
               %{
                 result
                 | thread_id: thread_id,
                   turn_id: turn_id,
                   codex_app_server_pid: session.os_pid,
                   events: events
               }}
          end

        true ->
          stream_until_terminal(session, thread_id, turn_id, events, on_event, deadline)
      end
    end
  end

  defp handle_server_request(session, %{"id" => request_id, "method" => method} = message) do
    response =
      if Protocol.method?(:server_request, method) do
        server_request_response(method, message)
      else
        {:error, %{"code" => -32601, "message" => "unsupported server request #{method}"}}
      end

    send_response(session, request_id, response)
  end

  defp server_request_response("item/commandExecution/requestApproval", _message),
    do: %{"decision" => "acceptForSession"}

  defp server_request_response("item/fileChange/requestApproval", _message),
    do: %{"decision" => "acceptForSession"}

  defp server_request_response("item/permissions/requestApproval", _message),
    do: %{"permissions" => %{}, "scope" => "session"}

  defp server_request_response("item/tool/requestUserInput", _message),
    do: {:error, %{"code" => -32_000, "message" => "user input is not supported by this harness"}}

  defp server_request_response("mcpServer/elicitation/request", _message),
    do:
      {:error,
       %{"code" => -32_000, "message" => "MCP elicitation is not supported by this harness"}}

  defp server_request_response("item/tool/call", message) do
    name = get_in(message, ["params", "name"]) || "unknown"

    %{
      "success" => false,
      "contentItems" => [
        %{"type" => "inputText", "text" => "unsupported tool call: #{name}"}
      ]
    }
  end

  defp server_request_response(method, _message),
    do: {:error, %{"code" => -32601, "message" => "unsupported server request #{method}"}}

  defp server_request?(%{"id" => _id, "method" => _method}), do: true

  defp server_request?(_message), do: false

  defp server_notification?(%{"method" => method}),
    do: Protocol.method?(:server_notification, method)

  defp server_notification?(_message), do: false

  defp terminal_outcome(%{"method" => "turn/completed", "params" => params}, turn_id) do
    completed_turn_id = get_in(params, ["turn", "id"]) || Map.get(params, "turnId")

    if is_nil(completed_turn_id) or completed_turn_id == turn_id do
      %Result{outcome: "completed"}
    end
  end

  defp terminal_outcome(%{"method" => "error", "params" => params}, _turn_id) do
    %Result{
      outcome: if(Map.get(params, "willRetry"), do: "retry", else: "failed"),
      error_code: "codex_error",
      error_message: get_in(params, ["error", "message"]) || "Codex app-server error"
    }
  end

  defp terminal_outcome(_message, _turn_id), do: nil

  defp read_message(session, deadline) do
    case pop_line(session.buffer) do
      {:ok, line, rest} ->
        decode_message(line, %{session | buffer: rest})

      :more ->
        remaining = max(deadline - now_ms(), 0)

        receive do
          {port, {:data, data}} when port == session.port ->
            read_message(%{session | buffer: session.buffer <> data}, deadline)

          {port, {:exit_status, status}} when port == session.port ->
            {:error,
             %Error{
               code: "port_exit",
               message: "codex app-server exited before turn completed",
               payload: %{status: status}
             }}
        after
          remaining ->
            {:error,
             %Error{code: "read_timeout", message: "timed out waiting for Codex app-server"}}
        end
    end
  end

  defp decode_message(line, session) do
    {:ok, line |> :json.decode() |> normalize_json()}
    |> case do
      {:ok, message} when is_map(message) ->
        {:ok, session, message}

      _ ->
        {:error,
         %Error{
           code: "malformed",
           message: "Codex app-server emitted a non-object JSON-RPC message"
         }}
    end
  rescue
    _error ->
      {:error,
       %Error{
         code: "malformed",
         message: "Codex app-server emitted malformed JSON",
         payload: String.slice(line, 0, 200)
       }}
  end

  defp write_message(port, message) do
    data = message |> :json.encode() |> IO.iodata_to_binary()
    true = Port.command(port, data <> "\n")
    :ok
  end

  defp pop_line(buffer) do
    case :binary.match(buffer, "\n") do
      {index, 1} ->
        line = binary_part(buffer, 0, index)
        rest = binary_part(buffer, index + 1, byte_size(buffer) - index - 1)
        {:ok, line, rest}

      :nomatch ->
        :more
    end
  end

  defp required_id(result, path, method) do
    case get_in(result, path) do
      id when is_binary(id) and id != "" ->
        {:ok, id}

      _ ->
        {:error,
         %Error{
           code: "response_error",
           message: "#{method} response did not include #{Enum.join(path, ".")}",
           payload: result
         }}
    end
  end

  defp message_to_event(%{"method" => method} = message) do
    params = Map.get(message, "params")
    params = if is_map(params), do: params, else: %{}

    %Event{
      event: String.replace(method, "/", "_"),
      method: method,
      params: params,
      usage: extract_usage(method, params),
      timestamp_ms: now_ms()
    }
  end

  defp emit(%Event{} = event, on_event) do
    on_event.(event)
    event
  end

  defp extract_usage("thread/tokenUsage/updated", params) do
    usage = Map.get(params, "usage") || Map.get(params, "total_token_usage") || params
    if is_map(usage), do: usage
  end

  defp extract_usage(_method, _params), do: nil

  defp normalize_json(:null), do: nil
  defp normalize_json(value) when is_list(value), do: Enum.map(value, &normalize_json/1)

  defp normalize_json(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {to_string(key), normalize_json(item)} end)
    |> Map.new()
  end

  defp normalize_json(value), do: value

  defp drop_nil(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp deadline_ms(timeout_ms), do: now_ms() + timeout_ms
  defp now_ms, do: System.monotonic_time(:millisecond)

  defp os_pid(port) do
    case Port.info(port, :os_pid) do
      {:os_pid, pid} -> to_string(pid)
      _ -> nil
    end
  end

  defp close_port(port) do
    try do
      Port.close(port)
    catch
      _kind, _reason -> :ok
    end
  end
end
