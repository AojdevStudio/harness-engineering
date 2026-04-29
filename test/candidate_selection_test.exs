defmodule HarnessEngineering.CandidateSelectionTest do
  use ExUnit.Case
  import ExUnit.CaptureIO

  alias HarnessEngineering.CLI
  alias HarnessEngineering.Models.Issue
  alias HarnessEngineering.Runtime
  alias HarnessEngineering.Test.PythonOracle

  test "fixture-backed GitHub normalization and selected candidate match the Python oracle" do
    workflow_path =
      write_workflow("""
      ---
      tracker:
        kind: github
        owner: AojdevStudio
        repo: harness-engineering
        api_key: literal-token
      agent:
        max_concurrent_agents: 2
      ---
      Prompt
      """)

    fixture_path =
      write_fixture("""
      {
        "responses": [
          {
            "data": {
              "repository": {
                "issues": {
                  "nodes": [
                    {
                      "id": "id-3",
                      "number": 3,
                      "title": "Blocked issue",
                      "body": "## What to build\\nSomething\\n\\n## Blocked by\\n\\n- #2\\n",
                      "state": "OPEN",
                      "url": "https://github.com/AojdevStudio/harness-engineering/issues/3",
                      "createdAt": "2026-01-01T00:00:00Z",
                      "updatedAt": "2026-01-02T00:00:00Z",
                      "labels": {"nodes": [{"name": "Backend"}, {"name": "Priority:2"}]},
                      "blockedBy": {"nodes": [{"id": "id-1", "number": 1, "state": "CLOSED"}]}
                    },
                    {
                      "id": "id-4",
                      "number": 4,
                      "title": "Higher priority",
                      "body": "body",
                      "state": "OPEN",
                      "url": "https://github.com/AojdevStudio/harness-engineering/issues/4",
                      "createdAt": "2026-01-03T00:00:00Z",
                      "updatedAt": "2026-01-04T00:00:00Z",
                      "labels": {"nodes": [{"name": "p1"}]}
                    }
                  ],
                  "pageInfo": {"hasNextPage": false, "endCursor": null}
                }
              }
            }
          }
        ]
      }
      """)

    assert {:ok, result} = Runtime.dry_run_candidates(workflow_path, fixture_path)
    python = PythonOracle.candidate_selection(workflow_path, fixture_path)

    assert python["status"] == "ok"

    assert decode_json(python["normalized_issues"]) ==
             Enum.map(result.candidates, &Issue.to_map/1)

    assert python["selected_identifier"] == result.selected.identifier
    assert result.selected.identifier == "harness-engineering#4"
  end

  test "blocker rules and dispatch sort order match the Python oracle" do
    workflow_path =
      write_workflow("""
      ---
      tracker:
        kind: github
        owner: AojdevStudio
        repo: harness-engineering
        api_key: literal-token
        active_states:
          - todo
        terminal_states:
          - done
      agent:
        max_concurrent_agents: 2
      ---
      Prompt
      """)

    fixture_path =
      write_fixture("""
      {
        "responses": [
          {
            "data": {
              "repository": {
                "issues": {
                  "nodes": [
                    {
                      "id": "id-1",
                      "number": 1,
                      "title": "Blocked first",
                      "body": "body",
                      "state": "TODO",
                      "createdAt": "2026-01-01T00:00:00Z",
                      "updatedAt": "2026-01-01T00:00:00Z",
                      "labels": {"nodes": [{"name": "p1"}]},
                      "blockedBy": {"nodes": [{"id": "id-0", "number": 0, "state": "OPEN"}]}
                    },
                    {
                      "id": "id-2",
                      "number": 2,
                      "title": "Eligible second",
                      "body": "body",
                      "state": "TODO",
                      "createdAt": "2026-01-02T00:00:00Z",
                      "updatedAt": "2026-01-02T00:00:00Z",
                      "labels": {"nodes": [{"name": "p2"}]}
                    }
                  ],
                  "pageInfo": {"hasNextPage": false, "endCursor": null}
                }
              }
            }
          }
        ]
      }
      """)

    assert {:ok, result} = Runtime.dry_run_candidates(workflow_path, fixture_path)
    python = PythonOracle.candidate_selection(workflow_path, fixture_path)

    assert python["status"] == "ok"
    assert python["selected_identifier"] == result.selected.identifier
    assert result.selected.identifier == "harness-engineering#2"
  end

  test "concurrency gates can prevent dispatch in a one-tick dry run" do
    workflow_path =
      write_workflow("""
      ---
      tracker:
        kind: github
        owner: AojdevStudio
        repo: harness-engineering
        api_key: literal-token
      agent:
        max_concurrent_agents: 1
        max_concurrent_agents_by_state:
          open: 1
      ---
      Prompt
      """)

    fixture_path =
      write_fixture("""
      {
        "state": {
          "running": [
            {"id": "id-busy", "identifier": "harness-engineering#99", "title": "Busy", "state": "open"}
          ]
        },
        "responses": [
          {
            "data": {
              "repository": {
                "issues": {
                  "nodes": [
                    {
                      "id": "id-5",
                      "number": 5,
                      "title": "Would run",
                      "body": "body",
                      "state": "OPEN",
                      "createdAt": "2026-01-01T00:00:00Z",
                      "updatedAt": "2026-01-01T00:00:00Z",
                      "labels": {"nodes": [{"name": "p1"}]}
                    }
                  ],
                  "pageInfo": {"hasNextPage": false, "endCursor": null}
                }
              }
            }
          }
        ]
      }
      """)

    assert {:ok, result} = Runtime.dry_run_candidates(workflow_path, fixture_path)
    python = PythonOracle.candidate_selection(workflow_path, fixture_path)

    assert python["status"] == "ok"
    assert python["selected_identifier"] == ""
    assert is_nil(result.selected)
  end

  test "CLI reports selected issue from mocked GitHub responses without launching Codex" do
    workflow_path =
      write_workflow("""
      ---
      tracker:
        kind: github
        owner: AojdevStudio
        repo: harness-engineering
        api_key: literal-token
      ---
      Prompt
      """)

    fixture_path =
      write_fixture("""
      {
        "responses": [
          {
            "data": {
              "repository": {
                "issues": {
                  "nodes": [
                    {
                      "id": "id-8",
                      "number": 8,
                      "title": "Run me",
                      "body": "body",
                      "state": "OPEN",
                      "createdAt": "2026-01-01T00:00:00Z",
                      "updatedAt": "2026-01-01T00:00:00Z",
                      "labels": {"nodes": []}
                    }
                  ],
                  "pageInfo": {"hasNextPage": false, "endCursor": null}
                }
              }
            }
          }
        ]
      }
      """)

    output =
      capture_io(fn ->
        assert CLI.main([workflow_path, "--once", "--github-fixture", fixture_path]) == 0
      end)

    assert output =~ "candidate selection"
    assert output =~ "selected=harness-engineering#8"
  end

  defp decode_json(value) do
    value
    |> :json.decode()
    |> normalize_json()
  end

  defp normalize_json(:null), do: nil
  defp normalize_json(value) when is_list(value), do: Enum.map(value, &normalize_json/1)

  defp normalize_json(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {to_string(key), normalize_json(item)} end)
    |> Map.new()
  end

  defp normalize_json(value), do: value

  defp write_workflow(text) do
    path = Path.join(tmp_dir(), "WORKFLOW.md")
    File.write!(path, unindent(text))
    path
  end

  defp write_fixture(text) do
    path = Path.join(tmp_dir(), "github-fixture.json")
    File.write!(path, unindent(text))
    path
  end

  defp tmp_dir do
    path =
      Path.join(
        System.tmp_dir!(),
        "harness-engineering-candidate-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(path)
    path
  end

  defp unindent(text) do
    lines = String.split(text, "\n")

    indent =
      lines
      |> Enum.reject(&(String.trim(&1) == ""))
      |> Enum.map(fn line ->
        line |> String.graphemes() |> Enum.take_while(&(&1 == " ")) |> length()
      end)
      |> Enum.min(fn -> 0 end)

    lines
    |> Enum.map(&String.replace_prefix(&1, String.duplicate(" ", indent), ""))
    |> Enum.join("\n")
  end
end
