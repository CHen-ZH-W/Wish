import type { StorageFacet } from "./backend.js";

export type StorageErrorCode =
  | "storage_backend_not_found"
  | "storage_facet_unavailable"
  | "storage_conflict"
  | "storage_corruption"
  | "storage_unavailable"
  | "storage_closed";

export interface StorageErrorContext {
  readonly backendId?: string;
  readonly facet?: StorageFacet;
  readonly namespace?: string;
  readonly key?: string;
}

/** Stable failure vocabulary shared by Storage providers and consumers. */
export class StorageError extends Error {
  readonly backendId: string | undefined;
  readonly facet: StorageFacet | undefined;
  readonly namespace: string | undefined;
  readonly key: string | undefined;

  constructor(
    readonly code: StorageErrorCode,
    message: string,
    context: StorageErrorContext = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
    this.backendId = context.backendId;
    this.facet = context.facet;
    this.namespace = context.namespace;
    this.key = context.key;
  }
}

export class StorageBackendNotFoundError extends StorageError {
  constructor(backendId: string) {
    super(
      "storage_backend_not_found",
      `Storage Backend is not registered: ${backendId}`,
      { backendId },
    );
    this.name = "StorageBackendNotFoundError";
  }
}

export class StorageFacetUnavailableError extends StorageError {
  constructor(backendId: string, facet: StorageFacet, detail?: string) {
    super(
      "storage_facet_unavailable",
      `Storage Backend "${backendId}" does not satisfy ${facet}` +
        (detail === undefined ? "" : `: ${detail}`),
      { backendId, facet },
    );
    this.name = "StorageFacetUnavailableError";
  }
}

export class StorageConflictError extends StorageError {
  constructor(
    message: string,
    context: StorageErrorContext = {},
    options?: ErrorOptions,
  ) {
    super("storage_conflict", message, context, options);
    this.name = "StorageConflictError";
  }
}

export class StorageCorruptionError extends StorageError {
  constructor(
    message: string,
    context: StorageErrorContext = {},
    options?: ErrorOptions,
  ) {
    super("storage_corruption", message, context, options);
    this.name = "StorageCorruptionError";
  }
}

export class StorageUnavailableError extends StorageError {
  constructor(
    message: string,
    context: StorageErrorContext = {},
    options?: ErrorOptions,
  ) {
    super("storage_unavailable", message, context, options);
    this.name = "StorageUnavailableError";
  }
}

export class StorageClosedError extends StorageError {
  constructor(backendId: string, facet?: StorageFacet) {
    super(
      "storage_closed",
      `Storage Backend "${backendId}" is closed`,
      { backendId, ...(facet === undefined ? {} : { facet }) },
    );
    this.name = "StorageClosedError";
  }
}
