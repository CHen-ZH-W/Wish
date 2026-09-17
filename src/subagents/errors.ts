export type SubagentErrorCode =
  | "subagent_invalid_input"
  | "subagent_not_found"
  | "subagent_conflict"
  | "subagent_limit_exceeded"
  | "subagent_not_running"
  | "subagent_closed";

export class SubagentError extends Error {
  constructor(
    readonly code: SubagentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SubagentError";
  }
}

export class SubagentInvalidInputError extends SubagentError {
  constructor(message: string) {
    super("subagent_invalid_input", message);
    this.name = "SubagentInvalidInputError";
  }
}

export class SubagentNotFoundError extends SubagentError {
  constructor(id: string) {
    super("subagent_not_found", `Subagent ${id} was not found`);
    this.name = "SubagentNotFoundError";
  }
}

export class SubagentConflictError extends SubagentError {
  constructor(message: string) {
    super("subagent_conflict", message);
    this.name = "SubagentConflictError";
  }
}

export class SubagentLimitExceededError extends SubagentError {
  constructor(message: string) {
    super("subagent_limit_exceeded", message);
    this.name = "SubagentLimitExceededError";
  }
}

export class SubagentNotRunningError extends SubagentError {
  constructor(id: string) {
    super("subagent_not_running", `Subagent ${id} is not running`);
    this.name = "SubagentNotRunningError";
  }
}

export class SubagentClosedError extends SubagentError {
  constructor() {
    super("subagent_closed", "Subagent service is closed");
    this.name = "SubagentClosedError";
  }
}
