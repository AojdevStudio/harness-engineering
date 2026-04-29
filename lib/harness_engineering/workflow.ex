defmodule HarnessEngineering.Workflow.LoadError do
  @moduledoc false

  defexception [:code, :message, :path]

  @impl true
  def exception(opts) do
    %__MODULE__{
      code: Keyword.fetch!(opts, :code),
      message: Keyword.fetch!(opts, :message),
      path: Keyword.get(opts, :path)
    }
  end
end

defmodule HarnessEngineering.Workflow.Definition do
  @moduledoc false

  defstruct config: %{}, prompt_template: "", path: nil
end

defmodule HarnessEngineering.Workflow do
  @moduledoc """
  `WORKFLOW.md` path selection and front-matter loading.
  """

  alias HarnessEngineering.Workflow.Definition
  alias HarnessEngineering.Workflow.LoadError
  alias HarnessEngineering.Workflow.Yaml

  def select_path(explicit_path, cwd \\ File.cwd!())

  def select_path(nil, cwd), do: realpath("WORKFLOW.md", cwd)

  def select_path("", cwd), do: realpath("WORKFLOW.md", cwd)

  def select_path(explicit_path, _cwd), do: realpath(explicit_path)

  def realpath(path, cwd \\ nil) do
    expanded = if cwd, do: Path.expand(path, cwd), else: Path.expand(path)
    resolve_symlinks(expanded)
  end

  defp resolve_symlinks(path, seen \\ 0)

  defp resolve_symlinks(path, seen) when seen > 32, do: path

  defp resolve_symlinks(path, seen) do
    path
    |> Path.split()
    |> resolve_parts([], seen)
  end

  defp resolve_parts([], acc, _seen), do: Path.join(acc)

  defp resolve_parts([part | rest], [], seen), do: resolve_parts(rest, [part], seen)

  defp resolve_parts([part | rest], acc, seen) do
    candidate = Path.join(acc ++ [part])

    case File.lstat(candidate) do
      {:ok, %File.Stat{type: :symlink}} ->
        resolve_link(candidate, rest, seen)

      _ ->
        resolve_parts(rest, acc ++ [part], seen)
    end
  end

  defp resolve_link(candidate, rest, seen) do
    case File.read_link(candidate) do
      {:ok, target} ->
        target_path =
          if Path.type(target) == :absolute do
            target
          else
            Path.expand(target, Path.dirname(candidate))
          end

        rest
        |> Enum.reduce(target_path, fn part, path -> Path.join(path, part) end)
        |> resolve_symlinks(seen + 1)

      {:error, _reason} ->
        Enum.reduce(rest, candidate, fn part, path -> Path.join(path, part) end)
    end
  end

  def load(path) do
    workflow_path = realpath(path)

    case File.read(workflow_path) do
      {:ok, text} ->
        parse_text(text, workflow_path)

      {:error, _reason} ->
        {:error,
         %LoadError{
           code: "missing_workflow_file",
           message: "workflow file cannot be read: #{workflow_path}",
           path: workflow_path
         }}
    end
  end

  defp parse_text(text, workflow_path) do
    if String.starts_with?(text, "---") do
      with {:ok, front_matter, body} <- split_front_matter(text, workflow_path),
           {:ok, config} <- decode_front_matter(front_matter, workflow_path) do
        {:ok,
         %Definition{
           config: config,
           prompt_template: String.trim(body),
           path: workflow_path
         }}
      end
    else
      {:ok,
       %Definition{
         config: %{},
         prompt_template: String.trim(text),
         path: workflow_path
       }}
    end
  end

  defp split_front_matter(text, path) do
    lines = String.split(text, ~r{\R}, include_captures: true)
    logical_lines = combine_line_endings(lines)

    case logical_lines do
      [first | rest] ->
        if String.trim(first) == "---" do
          split_front_matter_lines(rest, path)
        else
          {:ok, "", text}
        end

      _ ->
        {:ok, "", text}
    end
  end

  defp split_front_matter_lines(rest, path) do
    case Enum.find_index(rest, &(String.trim(&1) == "---")) do
      nil ->
        {:error,
         %LoadError{
           code: "workflow_parse_error",
           message: "workflow front matter is missing closing delimiter: #{path}",
           path: path
         }}

      index ->
        {front_matter_lines, [_delimiter | body_lines]} = Enum.split(rest, index)
        {:ok, Enum.join(front_matter_lines), Enum.join(body_lines)}
    end
  end

  defp combine_line_endings(parts), do: combine_line_endings(parts, [])

  defp combine_line_endings([], acc), do: Enum.reverse(acc)

  defp combine_line_endings([line, ending | rest], acc) when ending in ["\n", "\r\n", "\r"] do
    combine_line_endings(rest, [line <> ending | acc])
  end

  defp combine_line_endings([line | rest], acc), do: combine_line_endings(rest, [line | acc])

  defp decode_front_matter(front_matter, workflow_path) do
    case Yaml.decode(front_matter) do
      {:ok, config} when is_map(config) ->
        if Enum.all?(Map.keys(config), &is_binary/1) do
          {:ok, config}
        else
          {:error,
           %LoadError{
             code: "workflow_parse_error",
             message: "workflow front matter keys must be strings",
             path: workflow_path
           }}
        end

      {:ok, _other} ->
        {:error,
         %LoadError{
           code: "workflow_front_matter_not_a_map",
           message: "workflow front matter must decode to a map",
           path: workflow_path
         }}

      {:error, _reason} ->
        {:error,
         %LoadError{
           code: "workflow_parse_error",
           message: "workflow front matter is invalid YAML: #{workflow_path}",
           path: workflow_path
         }}
    end
  end
end
