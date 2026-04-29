defmodule CodexAppServerFixture do
  @thread_id "fixture-thread"
  @turn_id "fixture-turn"

  def run do
    File.write!("fixture-cwd.txt", File.cwd!())
    loop()
  end

  defp loop do
    case IO.read(:stdio, :line) do
      :eof ->
        :ok

      line ->
        line
        |> :json.decode()
        |> normalize_json()
        |> handle_message()

        loop()
    end
  end

  defp handle_message(%{"id" => id, "method" => "initialize"}) do
    write(%{
      "jsonrpc" => "2.0",
      "id" => id,
      "result" => %{"serverInfo" => %{"name" => "fixture"}}
    })
  end

  defp handle_message(%{"method" => "initialized"}), do: :ok

  defp handle_message(%{"id" => id, "method" => "thread/start", "params" => params}) do
    write_log(%{"thread_start_cwd" => Map.get(params, "cwd")})

    write(%{
      "jsonrpc" => "2.0",
      "id" => id,
      "result" => %{
        "thread" => %{"id" => @thread_id},
        "cwd" => File.cwd!(),
        "model" => "fixture",
        "modelProvider" => "fixture",
        "approvalPolicy" => "never",
        "approvalsReviewer" => "user",
        "sandbox" => %{"type" => "readOnly"}
      }
    })
  end

  defp handle_message(%{"id" => id, "method" => "turn/start", "params" => params}) do
    write_log(%{"turn_start_cwd" => Map.get(params, "cwd"), "input" => Map.get(params, "input")})
    write(%{"jsonrpc" => "2.0", "id" => id, "result" => %{"turn" => %{"id" => @turn_id}}})

    write(%{
      "jsonrpc" => "2.0",
      "method" => "turn/started",
      "params" => %{"turn" => %{"id" => @turn_id}}
    })

    request("item/commandExecution/requestApproval", %{"command" => "printf fixture"})
    request("item/fileChange/requestApproval", %{"changes" => []})
    request("item/permissions/requestApproval", %{"permissions" => %{}})
    request("item/tool/call", %{"name" => "fixtureTool"})
    request("item/tool/requestUserInput", %{"questions" => []})

    if System.get_env("CODEX_FIXTURE_OUTCOME") == "error" do
      write(%{
        "jsonrpc" => "2.0",
        "method" => "error",
        "params" => %{
          "threadId" => @thread_id,
          "turnId" => @turn_id,
          "willRetry" => true,
          "error" => %{"message" => "fixture retryable error"}
        }
      })
    else
      write(%{
        "jsonrpc" => "2.0",
        "method" => "thread/tokenUsage/updated",
        "params" => %{"usage" => %{"inputTokens" => 1, "outputTokens" => 1}}
      })

      write(%{
        "jsonrpc" => "2.0",
        "method" => "turn/completed",
        "params" => %{"threadId" => @thread_id, "turn" => %{"id" => @turn_id}}
      })
    end
  end

  defp handle_message(message), do: write_log(%{"unexpected" => message})

  defp request(method, params) do
    request_id = "server-#{System.unique_integer([:positive])}"
    write(%{"jsonrpc" => "2.0", "id" => request_id, "method" => method, "params" => params})

    receive_response(request_id)
  end

  defp receive_response(request_id) do
    case IO.read(:stdio, :line) do
      :eof ->
        write_log(%{"request_id" => request_id, "response" => "eof"})

      line ->
        response = line |> :json.decode() |> normalize_json()
        write_log(%{"request_id" => request_id, "response" => response})
    end
  end

  defp write(message) do
    IO.write(:stdio, IO.iodata_to_binary(:json.encode(message)) <> "\n")
  end

  defp write_log(message) do
    File.write!(
      "codex-fixture-responses.jsonl",
      IO.iodata_to_binary(:json.encode(message)) <> "\n",
      [
        :append
      ]
    )
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

CodexAppServerFixture.run()
