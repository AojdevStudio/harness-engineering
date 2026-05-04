export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_map"
  | "config_validation_error"
  | "template_parse_error"
  | "template_render_error";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly details?: unknown;

  constructor(code: WorkflowErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }
}
