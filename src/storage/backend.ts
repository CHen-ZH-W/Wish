import type {
  KvStorageBackend,
  StorageWriterConcurrency,
} from "./kv.js";
import type { BlobStorageBackend } from "./blob.js";
import type { JournalStorageBackend } from "./journal.js";

export type StorageFacet = "kv" | "blob" | "journal";

export interface KvStorageBackendCapabilities {
  readonly list: boolean;
}

export interface BlobStorageBackendCapabilities {
  readonly contentAddressed: true;
}

export interface JournalStorageBackendCapabilities {
  readonly atomicBatch: true;
  readonly durability: "fsync" | "buffered";
}

/** Provider-declared facts used before a consumer resolves a facet. */
export interface StorageBackendCapabilities {
  readonly writerConcurrency: StorageWriterConcurrency;
  readonly kv?: KvStorageBackendCapabilities;
  readonly blob?: BlobStorageBackendCapabilities;
  readonly journal?: JournalStorageBackendCapabilities;
}

export interface StorageBackend {
  readonly id: string;
  readonly capabilities: StorageBackendCapabilities;
  readonly kv?: KvStorageBackend;
  readonly blob?: BlobStorageBackend;
  readonly journal?: JournalStorageBackend;

  close?(): Promise<void>;
}

export interface StorageBackendRequirement {
  readonly writerConcurrency?: StorageWriterConcurrency;
  readonly kv?: { readonly list?: boolean };
  readonly blob?: true | { readonly contentAddressed?: boolean };
  readonly journal?: true | {
    readonly atomicBatch?: boolean;
    readonly durability?: "fsync" | "buffered";
  };
}

export interface StorageBackendResolver {
  /**
   * Pin one registered Backend generation until the returned lease is
   * released. Provider retirement stops new acquisitions before waiting for
   * existing leases, then closes the physical Backend.
   */
  acquire(
    backendId: string,
    requirement?: StorageBackendRequirement,
  ): StorageBackendLease;
  backend(
    backendId: string,
    requirement?: StorageBackendRequirement,
  ): StorageBackend;
  resolve<F extends StorageFacet>(
    backendId: string,
    facet: F,
  ): StorageFacetBackend<F>;
}

export type StorageFacetBackend<F extends StorageFacet> =
  F extends "kv" ? KvStorageBackend
    : F extends "blob" ? BlobStorageBackend
    : JournalStorageBackend;

/** Explicit lifetime ownership for one resolved Backend generation. */
export interface StorageBackendLease extends StorageBackendResolver {
  readonly id: string;
  readonly released: boolean;
  release(): boolean;
}

export interface StorageBackendRegistration {
  readonly id: string;
  readonly backend: StorageBackend;
  /** This registration's generation, including retirement after removal from the Hub. */
  snapshot(): StorageBackendLifecycleSnapshot;
  /** Reversible fence on new resolutions/acquisitions; admitted leases may finish. */
  suspendAcquisitions(): () => void;
  unregister(): Promise<boolean>;
}

export interface StorageBackendLifecycleSnapshot {
  readonly state: "active" | "retiring" | "closed" | "failed";
  readonly leases: number;
}
