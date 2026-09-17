export type PlanErrorCode =
  | "plan_invalid_input"
  | "plan_not_found"
  | "plan_conflict"
  | "plan_inactive"
  | "plan_closed";

export class PlanError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlanError";
  }
}

export class PlanInvalidInputError extends PlanError {
  constructor(message: string) {
    super("plan_invalid_input", message);
    this.name = "PlanInvalidInputError";
  }
}

export class PlanNotFoundError extends PlanError {
  constructor(sessionId: string) {
    super("plan_not_found", `Plan Session ${sessionId} was not found`);
    this.name = "PlanNotFoundError";
  }
}

export class PlanConflictError extends PlanError {
  constructor(message: string, options?: ErrorOptions) {
    super("plan_conflict", message, options);
    this.name = "PlanConflictError";
  }
}

export class PlanInactiveError extends PlanError {
  constructor(sessionId: string) {
    super("plan_inactive", `Plan mode is not active for Session ${sessionId}`);
    this.name = "PlanInactiveError";
  }
}

export class PlanClosedError extends PlanError {
  constructor() {
    super("plan_closed", "Plan service is closed");
    this.name = "PlanClosedError";
  }
}
