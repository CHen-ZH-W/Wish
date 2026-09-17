export type ShellErrorCode =
  | "shell_invalid_input"
  | "shell_permission_denied"
  | "shell_policy_mismatch"
  | "shell_unavailable"
  | "shell_execution_failed";

/** Stable failure vocabulary shared by Shell providers and consumers. */
export class ShellError extends Error {
  constructor(
    readonly code: ShellErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ShellError";
  }
}

export class ShellInvalidInputError extends ShellError {
  constructor(message: string) {
    super("shell_invalid_input", message);
    this.name = "ShellInvalidInputError";
  }
}

export class ShellPermissionDeniedError extends ShellError {
  constructor(message: string, options?: ErrorOptions) {
    super("shell_permission_denied", message, options);
    this.name = "ShellPermissionDeniedError";
  }
}

export class ShellPolicyMismatchError extends ShellError {
  constructor(message: string) {
    super("shell_policy_mismatch", message);
    this.name = "ShellPolicyMismatchError";
  }
}

export class ShellUnavailableError extends ShellError {
  constructor(message = "Shell Provider is unavailable", options?: ErrorOptions) {
    super("shell_unavailable", message, options);
    this.name = "ShellUnavailableError";
  }
}

export class ShellExecutionFailedError extends ShellError {
  constructor(message: string, options?: ErrorOptions) {
    super("shell_execution_failed", message, options);
    this.name = "ShellExecutionFailedError";
  }
}
