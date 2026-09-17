/** Concurrency scope guaranteed by a Storage Backend writer. */
export type StorageWriterConcurrency = "process-local" | "multi-process";

/** One logical KV address. Neither field is a filesystem path. */
export interface KvAddress {
  readonly namespace: string;
  readonly key: string;
}

export interface KvReadRequest extends KvAddress {
  readonly signal?: AbortSignal;
}

export interface KvReadResult {
  /** Caller-owned copy of the persisted bytes. */
  readonly value: Uint8Array;
  readonly revision: string;
}

export type KvPrecondition =
  | { readonly kind: "any" }
  | { readonly kind: "absent" }
  | { readonly kind: "revision"; readonly revision: string };

export interface KvPutRequest extends KvAddress {
  readonly value: Uint8Array;
  readonly precondition: KvPrecondition;
  readonly signal?: AbortSignal;
}

export interface KvWriteResult {
  readonly revision: string;
}

export interface KvDeleteRequest extends KvAddress {
  readonly precondition: KvPrecondition;
  readonly signal?: AbortSignal;
}

export interface KvDeleteResult {
  readonly deleted: boolean;
}

export interface KvListRequest {
  readonly namespace: string;
  readonly signal?: AbortSignal;
}

export interface KvListEntry {
  readonly key: string;
  readonly revision: string;
}

/** Provider-neutral byte KV primitive with explicit CAS semantics. */
export interface KvStorageBackend {
  readonly facet: "kv";

  get(request: KvReadRequest): Promise<KvReadResult | undefined>;
  put(request: KvPutRequest): Promise<KvWriteResult>;
  delete(request: KvDeleteRequest): Promise<KvDeleteResult>;
  list?(request: KvListRequest): Promise<readonly KvListEntry[]>;
}

export const KV_ANY: KvPrecondition = Object.freeze({ kind: "any" });
export const KV_ABSENT: KvPrecondition = Object.freeze({ kind: "absent" });

