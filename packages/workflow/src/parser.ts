import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { WorkflowError } from "./errors.ts";
import type { RawWorkflowConfig, WorkflowDefinition } from "./types.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkflowMarkdown(path: string, source: string): WorkflowDefinition {
  const normalizedPath = resolve(path);
  const directory = dirname(normalizedPath);

  if (!source.startsWith("---")) {
    return {
      path: normalizedPath,
      directory,
      config: {},
      promptTemplate: source.trim(),
    };
  }

  const lines = source.split(/\r?\n/);
  let closingIndex = -1;

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      `WORKFLOW.md front matter starts with --- but has no closing ---: ${normalizedPath}`,
    );
  }

  const frontMatter = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n").trim();

  let parsed: unknown;
  try {
    parsed = frontMatter.trim() === "" ? {} : parseYaml(frontMatter);
  } catch (error) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Unable to parse WORKFLOW.md YAML front matter: ${normalizedPath}`,
      error,
    );
  }

  if (parsed == null) {
    parsed = {};
  }

  if (!isPlainRecord(parsed)) {
    throw new WorkflowError(
      "workflow_front_matter_not_map",
      `WORKFLOW.md YAML front matter must decode to a map/object: ${normalizedPath}`,
      parsed,
    );
  }

  return {
    path: normalizedPath,
    directory,
    config: parsed as RawWorkflowConfig,
    promptTemplate: body,
  };
}

export async function loadWorkflowFile(path: string): Promise<WorkflowDefinition> {
  const normalizedPath = resolve(path);

  let source: string;
  try {
    source = await Bun.file(normalizedPath).text();
  } catch (error) {
    throw new WorkflowError(
      "missing_workflow_file",
      `Unable to read workflow file: ${normalizedPath}`,
      error,
    );
  }

  return parseWorkflowMarkdown(normalizedPath, source);
}
