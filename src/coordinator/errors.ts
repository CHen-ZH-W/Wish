export type CoordinatorErrorCode =
  | "coordinator_invalid_input"
  | "coordinator_not_found"
  | "coordinator_conflict"
  | "coordinator_inactive"
  | "coordinator_closed";

export class CoordinatorError extends Error {
  constructor(
    readonly code: CoordinatorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CoordinatorError";
  }
}

export class CoordinatorInvalidInputError extends CoordinatorError {
  constructor(message: string) {
    super("coordinator_invalid_input", message);
    this.name = "CoordinatorInvalidInputError";
  }
}

export class CoordinatorNotFoundError extends CoordinatorError {
  constructor(runId: string) {
    super("coordinator_not_found", `Coordinator Run ${runId} was not found`);
    this.name = "CoordinatorNotFoundError";
  }
}

export class CoordinatorConflictError extends CoordinatorError {
  constructor(message: string, options?: ErrorOptions) {
    super("coordinator_conflict", message, options);
    this.name = "CoordinatorConflictError";
  }
}

export class CoordinatorInactiveError extends CoordinatorError {
  constructor(runId: string) {
    super("coordinator_inactive", `Coordinator mode is not active for Run ${runId}`);
    this.name = "CoordinatorInactiveError";
  }
}

export class CoordinatorClosedError extends CoordinatorError {
  constructor() {
    super("coordinator_closed", "Coordinator service is closed");
    this.name = "CoordinatorClosedError";
  }
}
