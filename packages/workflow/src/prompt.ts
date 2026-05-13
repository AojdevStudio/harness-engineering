import { Liquid } from "liquidjs";
import { WorkflowError } from "./errors.ts";
import type { PromptRenderInput, WorkflowDefinition } from "./types.ts";

const DEFAULT_PROMPT_TEMPLATE = `You are working on issue {{ issue.identifier }}.

Title: {{ issue.title }}

Description:
{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}`;

const liquid = new Liquid({
  strictVariables: true,
  strictFilters: true,
  greedy: false,
});

export async function renderWorkflowPrompt(
  workflow: Pick<WorkflowDefinition, "promptTemplate">,
  input: PromptRenderInput,
): Promise<string> {
  const template = workflow.promptTemplate.trim() === "" ? DEFAULT_PROMPT_TEMPLATE : workflow.promptTemplate;

  try {
    return await liquid.parseAndRender(template, {
      issue: input.issue,
      attempt: input.attempt ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.toLowerCase().includes("parse") ? "template_parse_error" : "template_render_error";
    throw new WorkflowError(code, `Unable to render workflow prompt: ${message}`, error);
  }
}
