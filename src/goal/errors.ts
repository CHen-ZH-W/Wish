export type GoalErrorCode =
  | "goal_invalid_input"
  | "goal_not_found"
  | "goal_already_exists"
  | "goal_stale_revision"
  | "goal_invalid_transition"
  | "goal_round_limit"
  | "goal_closed";

export class GoalError extends Error {
  constructor(readonly code: GoalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoalError";
  }
}

export class GoalConflictError extends GoalError {
  constructor(code: Extract<GoalErrorCode, "goal_already_exists" | "goal_stale_revision" | "goal_invalid_transition" | "goal_round_limit">, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "GoalConflictError";
  }
}
