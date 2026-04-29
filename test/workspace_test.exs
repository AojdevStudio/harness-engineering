defmodule HarnessEngineering.WorkspaceTest do
  use ExUnit.Case

  alias HarnessEngineering.Models.Issue
  alias HarnessEngineering.Runtime
  alias HarnessEngineering.Test.PythonOracle
  alias HarnessEngineering.Workspace

  test "workspace keys use the same sanitizer as Python" do
    identifier = "HE/123 bad:chars☃"
    python = PythonOracle.workspace_key(identifier)

    assert python["status"] == "ok"
    assert Workspace.sanitize_key(identifier) == python["workspace_key"]
    assert Workspace.sanitize_key("ABC-1.ok") == "ABC-1.ok"
  end

  test "workspace creation reuses directories and runs after_create once" do
    root = tmp_path("workspace-reuse")

    manager =
      Workspace.new(root,
        hooks: %{"after_create" => "printf created >> marker.txt"},
        hook_timeout_ms: 5_000
      )

    assert {:ok, first} = Workspace.create_for_issue(manager, issue("harness-engineering#4"))
    assert {:ok, second} = Workspace.create_for_issue(manager, issue("harness-engineering#4"))

    assert first.path == second.path
    assert first.workspace_key == "harness-engineering_4"
    assert first.created_now == true
    assert second.created_now == false
    assert File.read!(Path.join(first.path, "marker.txt")) == "created"
  end

  test "workspace paths normalize symlinks and reject root escapes" do
    root = tmp_path("workspace-root")
    outside = tmp_path("workspace-outside")
    File.mkdir_p!(root)
    File.mkdir_p!(outside)
    File.ln_s!(outside, Path.join(root, "harness-engineering_4"))

    manager = Workspace.new(root)

    assert {:error, error} =
             Workspace.create_for_issue(manager, issue("harness-engineering#4"))

    assert error.code == "workspace_outside_root"
  end

  test "existing non-directory workspace path fails safely before hooks run" do
    root = tmp_path("workspace-file")
    key_path = Path.join(root, "harness-engineering_4")
    File.mkdir_p!(root)
    File.write!(key_path, "not a directory")

    manager =
      Workspace.new(root,
        hooks: %{"after_create" => "printf should-not-run > hook-ran"},
        hook_timeout_ms: 5_000
      )

    assert {:error, error} =
             Workspace.create_for_issue(manager, issue("harness-engineering#4"))

    assert error.code == "workspace_path_not_directory"
    refute File.exists?(Path.join(root, "hook-ran"))
    assert File.read!(key_path) == "not a directory"
  end

  test "before_run hook failures map to the same retry outcome as Python" do
    hooks = %{"before_run" => "exit 42", "after_run" => "printf after > after.txt"}
    identifier = "harness-engineering#4"
    python = PythonOracle.workspace_prepare(tmp_path("python-failure"), identifier, hooks, 5_000)

    manager = Workspace.new(tmp_path("elixir-failure"), hooks: hooks, hook_timeout_ms: 5_000)

    assert {:ok, attempt} = Workspace.prepare_attempt(manager, issue(identifier))
    assert python["status"] == "ok"
    assert python["attempt_outcome"] == "retry"
    assert python["error_code"] == "hook_failed"
    assert attempt.outcome == python["attempt_outcome"]
    assert attempt.error_code == python["error_code"]
    refute File.exists?(Path.join(attempt.workspace.path, "after.txt"))
  end

  test "fatal hook timeouts map to the same retry outcome as Python" do
    hooks = %{"before_run" => "sleep 0.2"}
    identifier = "harness-engineering#4"
    python = PythonOracle.workspace_prepare(tmp_path("python-timeout"), identifier, hooks, 50)

    manager = Workspace.new(tmp_path("elixir-timeout"), hooks: hooks, hook_timeout_ms: 50)

    assert {:ok, attempt} = Workspace.prepare_attempt(manager, issue(identifier))
    assert python["status"] == "ok"
    assert python["attempt_outcome"] == "retry"
    assert python["error_code"] == "hook_timeout"
    assert attempt.outcome == python["attempt_outcome"]
    assert attempt.error_code == python["error_code"]
  end

  test "after_run and before_remove hooks are best effort" do
    root = tmp_path("best-effort")

    manager =
      Workspace.new(root,
        hooks: %{
          "before_run" => "printf before > hooks.txt",
          "after_run" => "printf after >> hooks.txt; exit 9",
          "before_remove" => "printf removing > cleanup.txt; exit 10"
        },
        hook_timeout_ms: 5_000
      )

    assert {:ok, attempt} = Workspace.prepare_attempt(manager, issue("harness-engineering#4"))
    assert attempt.outcome == "ready"
    assert File.read!(Path.join(attempt.workspace.path, "hooks.txt")) == "beforeafter"

    assert :ok = Workspace.remove_for_issue(manager, "harness-engineering#4")
    refute File.exists?(attempt.workspace.path)
  end

  test "before_remove timeout is best effort and still removes workspace" do
    root = tmp_path("remove-timeout")

    manager =
      Workspace.new(root,
        hooks: %{"before_remove" => "sleep 0.2"},
        hook_timeout_ms: 50
      )

    assert {:ok, workspace} = Workspace.create_for_issue(manager, "harness-engineering#4")
    assert :ok = Workspace.remove_for_issue(manager, "harness-engineering#4")
    refute File.exists?(workspace.path)
  end

  test "runtime prepares one selected normalized issue without launching Codex" do
    root = tmp_path("runtime-workspaces")

    workflow_path =
      write_workflow("""
      ---
      tracker:
        kind: github
        owner: AojdevStudio
        repo: harness-engineering
        api_key: literal-token
      workspace:
        root: #{root}
      hooks:
        timeout_ms: 5000
        after_create: |
          printf created > marker.txt
        before_run: |
          printf before > hooks.txt
        after_run: |
          printf after >> hooks.txt; exit 9
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
                      "id": "id-4",
                      "number": 4,
                      "title": "Workspace safety",
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

    assert {:ok, result} = Runtime.dry_run_workspace(workflow_path, fixture_path)

    assert result.selected.identifier == "harness-engineering#4"
    assert result.attempt.outcome == "ready"
    assert result.attempt.workspace.workspace_key == "harness-engineering_4"
    assert File.read!(Path.join(result.attempt.workspace.path, "marker.txt")) == "created"
    assert File.read!(Path.join(result.attempt.workspace.path, "hooks.txt")) == "beforeafter"
  end

  defp issue(identifier) do
    %Issue{
      id: "id-#{identifier}",
      identifier: identifier,
      title: "Workspace safety",
      state: "open"
    }
  end

  defp tmp_path(name) do
    Path.join(System.tmp_dir!(), "#{name}-#{System.unique_integer([:positive])}")
  end

  defp write_workflow(text) do
    path = Path.join(tmp_path("workflow"), "WORKFLOW.md")
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, unindent(text))
    path
  end

  defp write_fixture(text) do
    path = Path.join(tmp_path("fixture"), "github-fixture.json")
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, unindent(text))
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
