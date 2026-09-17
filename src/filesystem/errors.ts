export type FilesystemErrorCode =
  | "filesystem_invalid_path"
  | "filesystem_outside_workspace"
  | "filesystem_protected_path"
  | "filesystem_symbolic_link"
  | "filesystem_not_found"
  | "filesystem_not_file"
  | "filesystem_too_large"
  | "filesystem_authority_mismatch"
  | "filesystem_unavailable";

/** Stable failure vocabulary shared by Filesystem providers and consumers. */
export class FilesystemError extends Error {
  constructor(
    readonly code: FilesystemErrorCode,
    message: string,
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FilesystemError";
  }
}

export class FilesystemInvalidPathError extends FilesystemError {
  constructor(path?: string) {
    super(
      "filesystem_invalid_path",
      "Filesystem path must be a non-empty trimmed path without null bytes",
      path,
    );
    this.name = "FilesystemInvalidPathError";
  }
}

export class FilesystemOutsideWorkspaceError extends FilesystemError {
  constructor(path: string) {
    super(
      "filesystem_outside_workspace",
      `Filesystem path is outside the Workspace: ${path}`,
      path,
    );
    this.name = "FilesystemOutsideWorkspaceError";
  }
}

export class FilesystemProtectedPathError extends FilesystemError {
  constructor(path: string) {
    super(
      "filesystem_protected_path",
      `Filesystem path is protected: ${path}`,
      path,
    );
    this.name = "FilesystemProtectedPathError";
  }
}

export class FilesystemSymbolicLinkError extends FilesystemError {
  constructor(path: string) {
    super(
      "filesystem_symbolic_link",
      `Symbolic links are not allowed in Filesystem paths: ${path}`,
      path,
    );
    this.name = "FilesystemSymbolicLinkError";
  }
}

export class FilesystemNotFoundError extends FilesystemError {
  constructor(path: string, options?: ErrorOptions) {
    super(
      "filesystem_not_found",
      `Filesystem path does not exist: ${path}`,
      path,
      options,
    );
    this.name = "FilesystemNotFoundError";
  }
}

export class FilesystemNotFileError extends FilesystemError {
  constructor(path: string) {
    super(
      "filesystem_not_file",
      `Filesystem path is not a regular file: ${path}`,
      path,
    );
    this.name = "FilesystemNotFileError";
  }
}

export class FilesystemTooLargeError extends FilesystemError {
  constructor(path: string, readonly maxBytes: number) {
    super(
      "filesystem_too_large",
      `Filesystem file exceeds the ${maxBytes} byte limit: ${path}`,
      path,
    );
    this.name = "FilesystemTooLargeError";
  }
}

export class FilesystemAuthorityMismatchError extends FilesystemError {
  constructor(path: string, reason: string) {
    super(
      "filesystem_authority_mismatch",
      `Filesystem authority is invalid for ${path}: ${reason}`,
      path,
    );
    this.name = "FilesystemAuthorityMismatchError";
  }
}

export class FilesystemUnavailableError extends FilesystemError {
  constructor(message = "Filesystem Provider is unavailable") {
    super("filesystem_unavailable", message);
    this.name = "FilesystemUnavailableError";
  }
}
