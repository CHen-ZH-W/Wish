/** Stable, provider-neutral identity for immutable bytes. */
export interface BlobReference {
  readonly namespace: string;
  /** Opaque, versioned Provider locator. It is never a filesystem path. */
  readonly locator: string;
  readonly sha256: string;
  readonly size: number;
}

export interface BlobPutRequest {
  readonly namespace: string;
  readonly value: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface BlobReadRequest {
  readonly reference: BlobReference;
  readonly signal?: AbortSignal;
}

export interface BlobStat {
  readonly reference: BlobReference;
}

/** Immutable, content-addressed byte storage. */
export interface BlobStorageBackend {
  readonly facet: "blob";

  put(request: BlobPutRequest): Promise<BlobReference>;
  get(request: BlobReadRequest): Promise<Uint8Array | undefined>;
  stat(request: BlobReadRequest): Promise<BlobStat | undefined>;
}
