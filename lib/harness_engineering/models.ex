defmodule HarnessEngineering.Models.BlockerRef do
  @moduledoc false

  defstruct id: nil, identifier: nil, state: nil

  def from_map(value) when is_map(value) do
    %__MODULE__{
      id: optional_string(Map.get(value, "id") || Map.get(value, :id)),
      identifier: optional_string(Map.get(value, "identifier") || Map.get(value, :identifier)),
      state: optional_downcase(Map.get(value, "state") || Map.get(value, :state))
    }
  end

  def to_map(%__MODULE__{} = blocker) do
    %{
      "id" => blocker.id,
      "identifier" => blocker.identifier,
      "state" => blocker.state
    }
  end

  defp optional_string(nil), do: nil
  defp optional_string(value), do: to_string(value)

  defp optional_downcase(nil), do: nil
  defp optional_downcase(value), do: value |> to_string() |> String.downcase()
end

defmodule HarnessEngineering.Models.Issue do
  @moduledoc false

  alias HarnessEngineering.Models.BlockerRef

  defstruct id: "",
            identifier: "",
            title: "",
            state: "",
            description: nil,
            priority: nil,
            branch_name: nil,
            url: nil,
            labels: [],
            blocked_by: [],
            created_at: nil,
            updated_at: nil

  def from_map(value) when is_map(value) do
    %__MODULE__{
      id: string_value(Map.get(value, "id") || Map.get(value, :id)),
      identifier: string_value(Map.get(value, "identifier") || Map.get(value, :identifier)),
      title: string_value(Map.get(value, "title") || Map.get(value, :title)),
      state: value |> map_get_any(["state", :state]) |> string_value() |> String.downcase(),
      description: optional_string(Map.get(value, "description") || Map.get(value, :description)),
      priority: optional_int(Map.get(value, "priority") || Map.get(value, :priority)),
      branch_name: optional_string(Map.get(value, "branch_name") || Map.get(value, :branch_name)),
      url: optional_string(Map.get(value, "url") || Map.get(value, :url)),
      labels: string_list(Map.get(value, "labels") || Map.get(value, :labels)),
      blocked_by:
        (Map.get(value, "blocked_by") || Map.get(value, :blocked_by) || [])
        |> Enum.filter(&is_map/1)
        |> Enum.map(&BlockerRef.from_map/1),
      created_at: parse_datetime(Map.get(value, "created_at") || Map.get(value, :created_at)),
      updated_at: parse_datetime(Map.get(value, "updated_at") || Map.get(value, :updated_at))
    }
  end

  def to_map(%__MODULE__{} = issue) do
    %{
      "id" => issue.id,
      "identifier" => issue.identifier,
      "title" => issue.title,
      "description" => issue.description,
      "priority" => issue.priority,
      "state" => issue.state,
      "branch_name" => issue.branch_name,
      "url" => issue.url,
      "labels" => issue.labels,
      "blocked_by" => Enum.map(issue.blocked_by, &BlockerRef.to_map/1),
      "created_at" => format_datetime(issue.created_at),
      "updated_at" => format_datetime(issue.updated_at)
    }
  end

  defp map_get_any(map, keys) do
    Enum.find_value(keys, &Map.get(map, &1))
  end

  defp string_value(nil), do: ""
  defp string_value(value), do: to_string(value)

  defp optional_string(nil), do: nil
  defp optional_string(""), do: nil
  defp optional_string(value), do: to_string(value)

  defp optional_int(nil), do: nil
  defp optional_int(value) when is_integer(value), do: value

  defp optional_int(value) do
    case Integer.parse(to_string(value)) do
      {parsed, ""} -> parsed
      _ -> nil
    end
  end

  defp string_list(nil), do: []

  defp string_list(values) when is_list(values) do
    values
    |> Enum.map(&to_string/1)
    |> Enum.map(&String.downcase/1)
  end

  defp string_list(_value), do: []

  defp parse_datetime(nil), do: nil
  defp parse_datetime(%DateTime{} = value), do: value

  defp parse_datetime(value) do
    value
    |> to_string()
    |> DateTime.from_iso8601()
    |> case do
      {:ok, datetime, _offset} -> datetime
      _ -> nil
    end
  end

  defp format_datetime(nil), do: nil

  defp format_datetime(%DateTime{} = datetime) do
    datetime
    |> DateTime.to_iso8601()
    |> String.replace_suffix("Z", "+00:00")
  end
end
