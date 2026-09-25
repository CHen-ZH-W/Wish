import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
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

  private readonly store: ModelCatalogStore;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.work = new PluginWorkOwner(ctx, { code: "model_catalog", codeReload: true });
    const store = new DomainModelCatalogStore({
      storage: ctx.storageBackend,
      backendId,
    });
    this.store = { load: () => this.work.run(() => store.load()), save: value => this.work.run(() => store.save(value)) };
  }

  open(): ModelCatalogStore {
    this.work.assertAttached();
    return this.store;
  }
}

export default DomainModelCatalogProvider;
