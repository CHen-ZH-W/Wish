import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import {
  ModelCatalogPersistence,
} from "../catalog-persistence.js";
import type { ModelCatalogStore } from "../catalog.js";
import { DomainModelCatalogStore } from "./domain-store.js";

export interface Config {
  readonly backendId?: string;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
});

/** Cordis Domain Provider binding ModelCatalogStore to selected Storage KV. */
export class DomainModelCatalogProvider extends ModelCatalogPersistence {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;

  private readonly store: DomainModelCatalogStore;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.store = new DomainModelCatalogStore({
      storage: ctx.storageBackend,
      backendId,
    });
  }

  open(): ModelCatalogStore {
    return this.store;
  }
}

export default DomainModelCatalogProvider;
