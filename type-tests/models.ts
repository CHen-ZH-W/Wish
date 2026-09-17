import type { Model } from "../src/core/model/model.js";
import type {
  ModelContextWindowSource,
  ModelInputTokenCounter,
} from "../src/context/types.js";
import {
  loadModelsConfiguration,
  resolveConfiguredModel,
} from "../src/models/config.js";
import { ModelAdapterRegistry } from "../src/models/registry.js";
import {
  ConfiguredModel,
  createConfiguredModelResources,
  createConfiguredModelRequestTokenCounter,
} from "../src/models/runtime.js";
import { ModelCatalog } from "../src/models/catalog.js";
import {
  ModelRequestTokenCounter,
  type ModelRequestTokenizer,
} from "../src/models/input-tokens.js";
import { FileCatalogStore } from "../src/models/persistence/file-store.js";
import {
  DomainModelCatalogStore,
  modelCatalogDomain,
} from "../src/models/persistence/domain-store.js";
import type { StorageBackendResolver } from "../src/storage/index.js";
import { TokenizerUsageEstimator } from "../src/models/usage.js";
import type { ModelDependencies } from "../src/models/runtime.js";
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
const configuredRuntime = new ConfiguredModel({
  configuration,
  registry,
  environment: { MODEL_API_KEY: "secret" },
  fetch: async () => new Response(),
});
const configuredModel: Model = configuredRuntime;
const contextWindows: ModelContextWindowSource = configuredRuntime;
const requestTokenizer: ModelRequestTokenizer = {
  method: "fixture-request-tokenizer-v1",
  count() {
    return 42;
  },
};
const requestTokenCounter = new ModelRequestTokenCounter();
requestTokenCounter.register(configuration.defaultModel, requestTokenizer);
const contextTokenCounter: ModelInputTokenCounter = requestTokenCounter;
const configuredRequestTokenCounter: ModelInputTokenCounter =
  createConfiguredModelRequestTokenCounter({
    configuration,
    environment: { MODEL_API_KEY: "secret" },
    fetch: async () => new Response(),
  });
const resources: ModelDependencies = createConfiguredModelResources({
  configuration,
  registry,
  usageEstimator: new TokenizerUsageEstimator(),
  environment: { MODEL_API_KEY: "secret" },
  fetch: async () => new Response(),
});
const catalog = new ModelCatalog({
  configuration,
  store: new FileCatalogStore({ path: ".wish/models-catalog.json" }),
});
declare const storage: StorageBackendResolver;
const domainCatalog = new DomainModelCatalogStore({
  storage,
  backendId: "file",
});

void resolved;
void configuredModel;
void contextWindows;
void contextTokenCounter;
void configuredRequestTokenCounter;
void resources;
void catalog.list();
void domainCatalog.load();
void modelCatalogDomain;
