import { Service, type Context } from "@deepseek-ai/cordis";

import type { ModelCatalogStore } from "./catalog.js";

/** Replaceable ModelCatalogStore capability; canonical state stays in the Store. */
export abstract class ModelCatalogPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, "modelCatalogPersistence");
  }

  abstract open(): ModelCatalogStore;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    modelCatalogPersistence: ModelCatalogPersistence;
  }
}

export default ModelCatalogPersistence;
