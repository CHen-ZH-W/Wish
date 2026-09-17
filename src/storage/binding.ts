import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  StorageBackend,
  StorageBackendLease,
  StorageBackendRequirement,
  StorageBackendResolver,
  StorageFacet,
  StorageFacetBackend,
} from "./backend.js";

/**
 * One configured Backend selection. Consumers inject this service instead of
 * depending on a concrete file/sqlite/remote Provider plugin.
 */
export abstract class StorageBackendService extends Service
  implements StorageBackendResolver {
  abstract readonly id: string;

  constructor(ctx: Context) {
    super(ctx, "storageBackend");
  }

  acquire(
    backendId: string,
    requirement?: StorageBackendRequirement,
  ): StorageBackendLease {
    if (backendId !== this.id) {
      throw new TypeError(
        `Storage Backend selection is "${this.id}", not "${backendId}"`,
      );
    }
    return this.ctx.storage.acquire(backendId, requirement);
  }

  backend(
    backendId: string,
    requirement?: StorageBackendRequirement,
  ): StorageBackend {
    if (backendId !== this.id) {
      throw new TypeError(
        `Storage Backend selection is "${this.id}", not "${backendId}"`,
      );
    }
    return this.ctx.storage.backend(backendId, requirement);
  }

  resolve<F extends StorageFacet>(
    backendId: string,
    facet: F,
  ): StorageFacetBackend<F> {
    this.backend(backendId);
    return this.ctx.storage.resolve(backendId, facet);
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    storageBackend: StorageBackendService;
  }
}

export default StorageBackendService;
