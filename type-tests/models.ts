import type { Model } from "../src/core/model/model.js";
import {
  loadModelsConfiguration,
  resolveConfiguredModel,
} from "../src/models/config.js";
import { ModelAdapterRegistry } from "../src/models/registry.js";
import { ConfiguredModel } from "../src/models/runtime.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { FileCatalogStore } from "../src/storage/models/file-catalog-store.js";
import type {
  ModelAdapterFactory,
  ModelSpec,
  ProviderProfile,
} from "../src/models/types.js";

const modelSpec: ModelSpec = {
  id: "model",
  status: "active",
  input: { text: true, image: true },
  reasoning: true,
  toolCalling: true,
  developerRole: true,
};

const provider: ProviderProfile = {
  id: "provider",
  protocol: "fixture",
  baseUrl: "https://example.test/v1",
  auth: { type: "bearer", apiKeyEnv: "MODEL_API_KEY" },
  headers: {},
  defaultModel: "model",
  developerRoleMode: "native",
  request: {
    streamUsage: true,
    supportsTemperature: true,
    maxTokensField: "max_tokens",
    extraBody: {},
  },
  catalog: { enabled: false },
  models: [modelSpec],
};

const registry = new ModelAdapterRegistry();
const factory: ModelAdapterFactory = (_input): Model => ({ async *stream() {} });
registry.register("fixture", factory);
const configuration = loadModelsConfiguration({
  json: { schemaVersion: 1, providers: [provider] },
  availableProtocols: registry.protocols(),
});
const resolved = resolveConfiguredModel(configuration, configuration.defaultModel);
const configuredModel: Model = new ConfiguredModel({
  configuration,
  registry,
  environment: { MODEL_API_KEY: "secret" },
  fetch: async () => new Response(),
});
const catalog = new ModelCatalog({
  configuration,
  store: new FileCatalogStore({ path: ".wish/models-catalog.json" }),
});

void resolved;
void configuredModel;
void catalog.list();
