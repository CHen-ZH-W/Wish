export type WorkspaceErrorCode =
  | "workspace_invalid_root"
  | "workspace_root_not_found"
  | "workspace_root_not_directory"
  | "workspace_root_unavailable"
  | "workspace_instruction_unavailable"
  | "workspace_instruction_too_large";

/** Stable failure vocabulary shared by Workspace providers and consumers. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    readonly requestedRoot?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export class WorkspaceInvalidRootError extends WorkspaceError {
  constructor(requestedRoot?: string) {
    super(
      "workspace_invalid_root",
      "Workspace root must be a non-empty trimmed path without null bytes",
      requestedRoot,
    );
    this.name = "WorkspaceInvalidRootError";
  }
}

export class WorkspaceRootNotFoundError extends WorkspaceError {
  constructor(requestedRoot: string, options?: ErrorOptions) {
    super(
      "workspace_root_not_found",
      `Workspace root does not exist: ${requestedRoot}`,
      requestedRoot,
      options,
    );
    this.name = "WorkspaceRootNotFoundError";
  }
}

export class WorkspaceRootNotDirectoryError extends WorkspaceError {
  constructor(requestedRoot: string) {
    super(
      "workspace_root_not_directory",
      `Workspace root is not a directory: ${requestedRoot}`,
      requestedRoot,
    );
    this.name = "WorkspaceRootNotDirectoryError";
  }
}

export class WorkspaceRootUnavailableError extends WorkspaceError {
  constructor(requestedRoot: string, options?: ErrorOptions) {
    super(
      "workspace_root_unavailable",
      `Workspace root cannot be resolved: ${requestedRoot}`,
      requestedRoot,
      options,
    );
    this.name = "WorkspaceRootUnavailableError";
  }
}

export class WorkspaceInstructionUnavailableError extends WorkspaceError {
  constructor(
    requestedRoot: string,
    readonly source: string,
    options?: ErrorOptions,
  ) {
    super(
      "workspace_instruction_unavailable",
      `Workspace instruction cannot be read: ${source}`,
      requestedRoot,
      options,
    );
    this.name = "WorkspaceInstructionUnavailableError";
  }
}

export class WorkspaceInstructionTooLargeError extends WorkspaceError {
  constructor(
    requestedRoot: string,
    readonly source: string,
    readonly maxBytes: number,
  ) {
    super(
      "workspace_instruction_too_large",
      `Workspace instruction exceeds the ${maxBytes} byte limit: ${source}`,
      requestedRoot,
    );
    this.name = "WorkspaceInstructionTooLargeError";
  }
}
