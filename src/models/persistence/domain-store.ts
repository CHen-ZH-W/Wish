import {
  snapshotCatalog,
  type ModelCatalogSnapshot,
  type ModelCatalogStore,
} from "../catalog.js";
import type { StorageBackendResolver } from "../../storage/backend.js";
import {
  DOMAIN_ABSENT,
  StorageDomain,
  type DomainSpec,
  type ResolvedStorageDomain,
} from "../../storage/domain.js";
import { KV_ANY } from "../../storage/kv.js";

const MODEL_CATALOG_DOMAIN_ID = "models/catalog";

export const modelCatalogDomain: DomainSpec<void, ModelCatalogSnapshot> =
  Object.freeze({
    id: MODEL_CATALOG_DOMAIN_ID,
    schemaVersion: 1,
    shape: "global" as const,
    requirements: Object.freeze({
      kv: Object.freeze({ list: false }),
    }),
    resolve(): {
      readonly default: typeof DOMAIN_ABSENT;
    } {
      return Object.freeze({ default: DOMAIN_ABSENT });
    },
    encode(value: ModelCatalogSnapshot): Uint8Array {
      return new TextEncoder().encode(JSON.stringify(snapshotCatalog(value)));
    },
    decode(payload: Uint8Array): unknown {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      return JSON.parse(text) as unknown;
    },
    validate(value: unknown): ModelCatalogSnapshot {
      return snapshotCatalog(value);
    },
  });

export interface DomainModelCatalogStoreOptions {
  readonly storage: StorageBackendResolver;
  readonly backendId: string;
}

/** ModelCatalogStore adapter over the provider-neutral models/catalog Domain. */
export class DomainModelCatalogStore implements ModelCatalogStore {
  private readonly domain: ResolvedStorageDomain<ModelCatalogSnapshot>;

  constructor(options: DomainModelCatalogStoreOptions) {
    this.domain = new StorageDomain({
      storage: options.storage,
      backendId: options.backendId,
      spec: modelCatalogDomain,
    }).resolve(undefined);
  }

  async load(): Promise<ModelCatalogSnapshot | undefined> {
    return (await this.domain.load())?.value;
  }

  async save(snapshot: ModelCatalogSnapshot): Promise<void> {
    await this.domain.save(snapshotCatalog(snapshot), KV_ANY);
  }
}
