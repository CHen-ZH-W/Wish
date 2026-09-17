export type TmuxErrorCode =
  | "tmux_invalid_input"
  | "tmux_conflict"
  | "tmux_not_found"
  | "tmux_unavailable"
  | "tmux_execution_failed";

/** Stable failure vocabulary shared by tmux providers and consumers. */
export class TmuxError extends Error {
  constructor(
    readonly code: TmuxErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TmuxError";
  }
}

export class TmuxInvalidInputError extends TmuxError {
  constructor(message: string) {
    super("tmux_invalid_input", message);
    this.name = "TmuxInvalidInputError";
  }
}

export class TmuxConflictError extends TmuxError {
  constructor(message: string, options?: ErrorOptions) {
    super("tmux_conflict", message, options);
    this.name = "TmuxConflictError";
  }
}

export class TmuxNotFoundError extends TmuxError {
  constructor(message: string, options?: ErrorOptions) {
    super("tmux_not_found", message, options);
    this.name = "TmuxNotFoundError";
  }
}

export class TmuxUnavailableError extends TmuxError {
  constructor(message = "tmux is unavailable", options?: ErrorOptions) {
    super("tmux_unavailable", message, options);
    this.name = "TmuxUnavailableError";
  }
}

export class TmuxExecutionFailedError extends TmuxError {
  constructor(message: string, options?: ErrorOptions) {
    super("tmux_execution_failed", message, options);
    this.name = "TmuxExecutionFailedError";
  }
}
