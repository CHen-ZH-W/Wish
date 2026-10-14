export type UserTerminalErrorCode =
  | "invalid_input"
  | "not_found"
  | "not_active"
  | "limit_reached"
  | "control_unavailable"
  | "unavailable";

export class UserTerminalError extends Error {
  constructor(readonly code: UserTerminalErrorCode, message: string) {
    super(message);
    this.name = "UserTerminalError";
  }
}
