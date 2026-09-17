import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  StorageBackend,
  StorageBackendLease,
  StorageBackendRegistration,
  StorageBackendRequirement,
  StorageBackendResolver,
  StorageFacet,
  StorageFacetBackend,
} from "./backend.js";
import {
  StorageBackendNotFoundError,
  StorageClosedError,
  StorageConflictError,
  StorageFacetUnavailableError,
  StorageUnavailableError,
} from "./errors.js";

/** Cordis lifecycle hub for replaceable, named Storage Backends. */
export class StorageHub extends Service implements StorageBackendResolver {
  private readonly backends = new Map<string, BackendRecord>();

  constructor(ctx: Context) {
    super(ctx, "storage");
  }

  /** Register one Backend for exactly the lifetime of the calling plugin fiber. */
  register(backend: StorageBackend): StorageBackendRegistration {
    validateBackend(backend);
    if (this.backends.has(backend.id)) {
      throw new StorageConflictError(
        `Storage Backend "${backend.id}" is already registered`,
        { backendId: backend.id },
      );
    }
    const record: BackendRecord = {
      backend,
      leases: 0,
      state: "active",
      fences: new Set(),
    };
    this.backends.set(backend.id, record);

    let active = true;
    let closing: Promise<void> | undefined;
    const registration: StorageBackendRegistration = Object.freeze({
      id: backend.id,
      backend,
      snapshot: () => Object.freeze({ state: record.state, leases: record.leases }),
      suspendAcquisitions: () => {
        if (record.state !== "active") throw new StorageClosedError(backend.id);
        const fence = Symbol(); record.fences.add(fence);
        return () => { record.fences.delete(fence); };
      },
      unregister: async (): Promise<boolean> => {
        if (!active) {
          await closing;
          return false;
        }
        active = false;
        if (this.backends.get(backend.id) === record) {
          this.backends.delete(backend.id);
        }
        record.state = "retiring";
        closing = retireBackend(record);
        await closing;
        return true;
      },
    });

    try {
      this.ctx.effect(() => async () => {
        await registration.unregister();
      }, `storage.register(${JSON.stringify(backend.id)})`);
    } catch (error: unknown) {
      if (this.backends.get(backend.id) === record) {
        this.backends.delete(backend.id);
      }
      record.state = "retiring";
      active = false;
      throw error;
    }
    return registration;
  }

  has(backendId: string): boolean {
    return this.backends.has(requireBackendId(backendId));
  }

  ids(): readonly string[] {
    return Object.freeze([...this.backends.keys()].sort());
  }

  acquire(
    backendId: string,
    requirement: StorageBackendRequirement = {},
  ): StorageBackendLease {
    const id = requireBackendId(backendId);
    const record = this.backends.get(id);
    if (record === undefined || record.state !== "active" || record.fences.size > 0) {
      throw new StorageBackendNotFoundError(id);
    }
    return createBackendLease(record, id, requirement);
  }

  backend(
    backendId: string,
    requirement: StorageBackendRequirement = {},
  ): StorageBackend {
    const id = requireBackendId(backendId);
    const record = this.backends.get(id);
    if (record === undefined || record.state !== "active" || record.fences.size > 0) {
      throw new StorageBackendNotFoundError(id);
    }
    validateRequirement(record.backend, requirement);
    return record.backend;
  }

  resolve<F extends StorageFacet>(
    backendId: string,
    facet: F,
  ): StorageFacetBackend<F> {
    const backend = this.backend(backendId);
    const resolved = backend[facet];
    if (resolved === undefined) {
      throw new StorageFacetUnavailableError(backend.id, facet);
    }
    return resolved as unknown as StorageFacetBackend<F>;
  }
}

interface BackendRecord {
  readonly backend: StorageBackend;
  readonly fences: Set<symbol>;
  leases: number;
  state: "active" | "retiring" | "closed" | "failed";
  resolveDrained?: () => void;
}

function createBackendLease(
  record: BackendRecord,
  id: string,
  requirement: StorageBackendRequirement,
): StorageBackendLease {
  validateRequirement(record.backend, requirement);
  record.leases += 1;

  let released = false;
  const assertActive = (): BackendRecord => {
    if (released) throw new StorageClosedError(id);
    return record;
  };
  const lease: StorageBackendLease = {
    id,
    get released(): boolean {
      return released;
    },
    acquire(
      requestedId: string,
      requestedRequirement: StorageBackendRequirement = {},
    ): StorageBackendLease {
      assertLeaseBackendId(id, requestedId);
      const current = assertActive();
      if (current.state !== "active" || current.fences.size > 0) {
        throw new StorageBackendNotFoundError(id);
      }
      return createBackendLease(current, id, requestedRequirement);
    },
    backend(
      requestedId: string,
      requestedRequirement: StorageBackendRequirement = {},
    ): StorageBackend {
      assertLeaseBackendId(id, requestedId);
      const current = assertActive();
      validateRequirement(current.backend, requestedRequirement);
      return current.backend;
    },
    resolve<F extends StorageFacet>(
      requestedId: string,
      facet: F,
    ): StorageFacetBackend<F> {
      const backend = this.backend(requestedId);
      const resolved = backend[facet];
      if (resolved === undefined) {
        throw new StorageFacetUnavailableError(backend.id, facet);
      }
      return resolved as unknown as StorageFacetBackend<F>;
    },
    release(): boolean {
      if (released) return false;
      released = true;
      record.leases -= 1;
      if (record.leases === 0) record.resolveDrained?.();
      return true;
    },
  };
  return Object.freeze(lease);
}

async function retireBackend(record: BackendRecord): Promise<void> {
  if (record.leases > 0) {
    await new Promise<void>((resolve) => {
      record.resolveDrained = resolve;
      if (record.leases === 0) resolve();
    });
  }
  try {
    await closeBackend(record.backend);
    record.state = "closed";
  } catch (error: unknown) {
    record.state = "failed";
    throw error;
  } finally {
    delete record.resolveDrained;
  }
}

async function closeBackend(backend: StorageBackend): Promise<void> {
  if (backend.close === undefined) return;
  try {
    await backend.close();
  } catch (error: unknown) {
    throw new StorageUnavailableError(
      `Storage Backend "${backend.id}" failed to close`,
      { backendId: backend.id },
      { cause: error },
    );
  }
}

function validateBackend(backend: StorageBackend): void {
  if (backend === null || typeof backend !== "object") {
    throw new TypeError("Storage Backend must be an object");
  }
  requireBackendId(backend.id);
  if (backend.capabilities === null || typeof backend.capabilities !== "object") {
    throw new TypeError("Storage Backend capabilities must be an object");
  }
  if (
    backend.capabilities.writerConcurrency !== "process-local" &&
    backend.capabilities.writerConcurrency !== "multi-process"
  ) {
    throw new TypeError("Storage Backend writerConcurrency is invalid");
  }
  validateFacet(backend, "kv");
  validateFacet(backend, "blob");
  validateFacet(backend, "journal");
  if (backend.kv !== undefined) {
    if (
      backend.kv.facet !== "kv" || typeof backend.kv.get !== "function" ||
      typeof backend.kv.put !== "function" ||
      typeof backend.kv.delete !== "function"
    ) throw new TypeError("Storage Backend KV facet is invalid");
    if (
      backend.capabilities.kv?.list === true &&
      typeof backend.kv.list !== "function"
    ) throw new TypeError("Storage Backend declares KV list without implementing it");
  }
  if (
    backend.blob !== undefined &&
    (backend.blob.facet !== "blob" || typeof backend.blob.put !== "function" ||
      typeof backend.blob.get !== "function" ||
      typeof backend.blob.stat !== "function")
  ) throw new TypeError("Storage Backend Blob facet is invalid");
  if (
    backend.capabilities.blob !== undefined &&
    backend.capabilities.blob.contentAddressed !== true
  ) throw new TypeError("Storage Backend Blob capabilities are invalid");
  if (
    backend.journal !== undefined &&
    (backend.journal.facet !== "journal" ||
      typeof backend.journal.open !== "function")
  ) throw new TypeError("Storage Backend Journal facet is invalid");
  if (
    backend.capabilities.journal !== undefined &&
    (backend.capabilities.journal.atomicBatch !== true ||
      (backend.capabilities.journal.durability !== "fsync" &&
        backend.capabilities.journal.durability !== "buffered"))
  ) throw new TypeError("Storage Backend Journal capabilities are invalid");
}

function validateFacet(
  backend: StorageBackend,
  facet: StorageFacet,
): void {
  const declared = backend.capabilities[facet] !== undefined;
  const provided = backend[facet] !== undefined;
  if (declared !== provided) {
    throw new TypeError(
      `Storage Backend "${backend.id}" ${facet} capability and facet disagree`,
    );
  }
  if (provided && backend[facet]?.facet !== facet) {
    throw new TypeError(`Storage Backend "${backend.id}" ${facet} facet is invalid`);
  }
}

function validateRequirement(
  backend: StorageBackend,
  requirement: StorageBackendRequirement,
): void {
  if (requirement === null || typeof requirement !== "object") {
    throw new TypeError("Storage Backend requirement must be an object");
  }
  if (
    requirement.writerConcurrency !== undefined &&
    requirement.writerConcurrency !== backend.capabilities.writerConcurrency
  ) {
    throw new StorageFacetUnavailableError(
      backend.id,
      "kv",
      `requires ${requirement.writerConcurrency} writer concurrency`,
    );
  }
  if (requirement.kv !== undefined) {
    if (backend.kv === undefined || backend.capabilities.kv === undefined) {
      throw new StorageFacetUnavailableError(backend.id, "kv");
    }
    if (requirement.kv.list === true && !backend.capabilities.kv.list) {
      throw new StorageFacetUnavailableError(backend.id, "kv", "list is required");
    }
  }
  if (requirement.blob !== undefined) {
    if (backend.blob === undefined || backend.capabilities.blob === undefined) {
      throw new StorageFacetUnavailableError(backend.id, "blob");
    }
    if (
      requirement.blob !== true &&
      requirement.blob.contentAddressed === true &&
      backend.capabilities.blob.contentAddressed !== true
    ) {
      throw new StorageFacetUnavailableError(
        backend.id,
        "blob",
        "content-addressed storage is required",
      );
    }
  }
  if (requirement.journal !== undefined) {
    if (
      backend.journal === undefined || backend.capabilities.journal === undefined
    ) throw new StorageFacetUnavailableError(backend.id, "journal");
    if (
      requirement.journal !== true &&
      requirement.journal.atomicBatch === true &&
      backend.capabilities.journal.atomicBatch !== true
    ) {
      throw new StorageFacetUnavailableError(
        backend.id,
        "journal",
        "atomic batch append is required",
      );
    }
    if (
      requirement.journal !== true &&
      requirement.journal.durability !== undefined &&
      requirement.journal.durability !==
        backend.capabilities.journal.durability
    ) {
      throw new StorageFacetUnavailableError(
        backend.id,
        "journal",
        `${requirement.journal.durability} durability is required`,
      );
    }
  }
}

function requireBackendId(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw new TypeError("Storage Backend id must be a valid identifier");
  return value;
}

function assertLeaseBackendId(expected: string, actual: string): void {
  const id = requireBackendId(actual);
  if (id !== expected) {
    throw new TypeError(
      `Storage Backend lease is for "${expected}", not "${id}"`,
    );
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    storage: StorageHub;
  }
}

export default StorageHub;
