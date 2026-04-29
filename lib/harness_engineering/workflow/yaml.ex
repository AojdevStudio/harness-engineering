defmodule HarnessEngineering.Workflow.Yaml do
  @moduledoc """
  Small YAML subset parser for the workflow tracer bullet.

  The Python implementation remains the oracle. This parser intentionally
  covers the existing workflow fixtures: nested string-key maps, scalar lists,
  integer/string/bool/null scalars, and literal block scalars.
  """

  def decode(text) when is_binary(text) do
    lines = String.split(text, "\n", trim: false)

    case next_significant(lines, 0) do
      nil ->
        {:ok, %{}}

      {index, line} ->
        indent = indentation(line)

        cond do
          list_item?(line, indent) ->
            parse_list(lines, index, indent)
            |> finish_decode()

          true ->
            parse_map(lines, index, indent)
            |> finish_decode()
        end
    end
  end

  defp finish_decode({:ok, value, _index}), do: {:ok, value}
  defp finish_decode({:error, reason}), do: {:error, reason}

  defp parse_map(lines, index, indent), do: parse_map(lines, index, indent, %{})

  defp parse_map(lines, index, _indent, acc) when index >= length(lines), do: {:ok, acc, index}

  defp parse_map(lines, index, indent, acc) do
    line = Enum.at(lines, index)

    cond do
      blank_or_comment?(line) ->
        parse_map(lines, index + 1, indent, acc)

      indentation(line) < indent ->
        {:ok, acc, index}

      indentation(line) > indent ->
        {:error, :invalid_indentation}

      list_item?(line, indent) ->
        {:error, :unexpected_list_item}

      true ->
        with {:ok, key, value_text} <- split_key_value(line, indent),
             {:ok, value, next_index} <- parse_value(lines, index, indent, value_text) do
          parse_map(lines, next_index, indent, Map.put(acc, key, value))
        end
    end
  end

  defp parse_list(lines, index, indent), do: parse_list(lines, index, indent, [])

  defp parse_list(lines, index, _indent, acc) when index >= length(lines),
    do: {:ok, Enum.reverse(acc), index}

  defp parse_list(lines, index, indent, acc) do
    line = Enum.at(lines, index)

    cond do
      blank_or_comment?(line) ->
        parse_list(lines, index + 1, indent, acc)

      indentation(line) < indent ->
        {:ok, Enum.reverse(acc), index}

      indentation(line) > indent ->
        {:error, :invalid_indentation}

      not list_item?(line, indent) ->
        {:ok, Enum.reverse(acc), index}

      true ->
        value_text = line |> String.slice((indent + 2)..-1//1) |> String.trim()
        parse_list(lines, index + 1, indent, [parse_scalar(value_text) | acc])
    end
  end

  defp parse_value(lines, index, indent, "|") do
    {text, next_index} = collect_block_scalar(lines, index + 1, indent)
    {:ok, text, next_index}
  end

  defp parse_value(lines, index, indent, "") do
    case next_significant(lines, index + 1) do
      nil ->
        {:ok, nil, index + 1}

      {next_index, next_line} ->
        next_indent = indentation(next_line)

        cond do
          next_indent <= indent ->
            {:ok, nil, index + 1}

          list_item?(next_line, next_indent) ->
            parse_list(lines, next_index, next_indent)

          true ->
            parse_map(lines, next_index, next_indent)
        end
    end
  end

  defp parse_value(_lines, index, _indent, value_text),
    do: {:ok, parse_scalar(value_text), index + 1}

  defp collect_block_scalar(lines, index, parent_indent) do
    do_collect_block_scalar(lines, index, parent_indent, nil, [])
  end

  defp do_collect_block_scalar(lines, index, _parent_indent, _block_indent, acc)
       when index >= length(lines) do
    {finish_block(acc), index}
  end

  defp do_collect_block_scalar(lines, index, parent_indent, block_indent, acc) do
    line = Enum.at(lines, index)

    cond do
      String.trim(line) == "" ->
        case next_significant(lines, index + 1) do
          nil ->
            {finish_block(acc), index + 1}

          {_next_index, next_line} ->
            if indentation(next_line) <= parent_indent do
              {finish_block(acc), index + 1}
            else
              do_collect_block_scalar(lines, index + 1, parent_indent, block_indent, ["" | acc])
            end
        end

      indentation(line) <= parent_indent ->
        {finish_block(acc), index}

      true ->
        current_indent = indentation(line)
        effective_indent = block_indent || current_indent
        normalized = remove_indent(line, effective_indent)

        do_collect_block_scalar(lines, index + 1, parent_indent, effective_indent, [
          normalized | acc
        ])
    end
  end

  defp finish_block([]), do: ""
  defp finish_block(lines), do: (lines |> Enum.reverse() |> Enum.join("\n")) <> "\n"

  defp split_key_value(line, indent) do
    content = String.slice(line, indent..-1//1)

    case String.split(content, ":", parts: 2) do
      [key, value] ->
        key = String.trim(key)

        if key == "" do
          {:error, :empty_key}
        else
          {:ok, key, String.trim_leading(value)}
        end

      _ ->
        {:error, :missing_colon}
    end
  end

  defp parse_scalar(""), do: ""
  defp parse_scalar("null"), do: nil
  defp parse_scalar("Null"), do: nil
  defp parse_scalar("NULL"), do: nil
  defp parse_scalar("~"), do: nil
  defp parse_scalar("true"), do: true
  defp parse_scalar("True"), do: true
  defp parse_scalar("TRUE"), do: true
  defp parse_scalar("false"), do: false
  defp parse_scalar("False"), do: false
  defp parse_scalar("FALSE"), do: false

  defp parse_scalar(value) do
    cond do
      quoted?(value, "\"") -> value |> String.trim("\"") |> String.replace(~s(\\"), ~s("))
      quoted?(value, "'") -> String.trim(value, "'")
      Regex.match?(~r/^-?\d+$/, value) -> String.to_integer(value)
      true -> value
    end
  end

  defp quoted?(value, quote) do
    String.starts_with?(value, quote) and String.ends_with?(value, quote) and
      String.length(value) >= 2
  end

  defp next_significant(lines, index) when index >= length(lines), do: nil

  defp next_significant(lines, index) do
    line = Enum.at(lines, index)

    if blank_or_comment?(line) do
      next_significant(lines, index + 1)
    else
      {index, line}
    end
  end

  defp blank_or_comment?(line) do
    trimmed = String.trim(line)
    trimmed == "" or String.starts_with?(trimmed, "#")
  end

  defp list_item?(line, indent), do: String.starts_with?(String.slice(line, indent..-1//1), "- ")

  defp indentation(line) do
    line
    |> String.graphemes()
    |> Enum.take_while(&(&1 == " "))
    |> length()
  end

  defp remove_indent(line, indent),
    do: String.replace_prefix(line, String.duplicate(" ", indent), "")
end
