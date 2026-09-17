export type FilesystemSearchErrorCode =
  | "invalid_pattern"
  | "invalid_request"
  | "unavailable"
  | "search_limit_exceeded"
  | "search_failed";

export class FilesystemSearchError extends Error {
  constructor(
    readonly code: FilesystemSearchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FilesystemSearchError";
  }
}
