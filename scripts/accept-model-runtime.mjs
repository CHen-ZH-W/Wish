import assert from "node:assert/strict";
import test from "node:test";

import {
  loadModelsConfiguration,
  loadModelsConfigurationFile,
  parseModelReference,
  resolveConfiguredModel,
} from "../dist/models/config.js";
import { ModelAdapterRegistry } from "../dist/models/registry.js";
import { ConfiguredModel } from "../dist/models/runtime.js";

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function request(model) {
  return {
    model,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  };
}

function fixtureConfiguration() {
  return {
    schemaVersion: 1,
    defaultModel: "openai/primary",
    fallbackModels: ["backup/claude", "openai/secondary", "backup/claude"],
    maxRetries: 3,
    providers: [
      {
        id: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://models.example.test/v1/",
        auth: { type: "bearer", apiKeyEnv: "OPENAI_API_KEY" },
        headers: {
          "x-tenant": "wish",
          "x-region": { fromEnv: "MODEL_REGION" },
        },
        defaultModel: "primary",
        developerRoleMode: "native",
        request: {
          streamUsage: true,
          supportsTemperature: true,
          maxTokensField: "max_tokens",
          extraBody: { service_tier: "auto" },
        },
        catalog: { enabled: true, endpoint: "/models" },
        models: [
          {
            id: "primary",
            name: "Primary",
            status: "active",
            contextWindowTokens: 128000,
            maxOutputTokens: 8192,
            input: { text: true, image: true },
            reasoning: true,
            toolCalling: true,
            developerRole: true,
            price: {
              version: "2026-09-01",
              currency: "USD",
              inputPerMillionTokens: 2,
              cachedInputPerMillionTokens: 0.5,
              outputPerMillionTokens: 8,
            },
            request: {
              maxTokensField: "max_completion_tokens",
              extraBody: { reasoning_effort: "medium" },
            },
          },
          { id: "secondary", developerRole: true },
        ],
      },
      {
        id: "backup",
        protocol: "anthropic-messages",
        baseUrl: "https://anthropic.example.test/v1",
        auth: { type: "x-api-key", apiKeyEnv: "ANTHROPIC_API_KEY" },
        developerRoleMode: "system-fallback",
        models: [{ id: "claude", toolCalling: true }],
      },
    ],
  };
}

test("configuration resolves ordered selections and model overrides immutably", () => {
  const configuration = loadModelsConfiguration({
    json: fixtureConfiguration(),
    environment: {
      WISH_MODEL: "openai/secondary",
      WISH_FALLBACK_MODELS:
        "backup/claude, openai/primary, backup/claude, openai/secondary",
      WISH_MODEL_MAX_RETRIES: "4",
    },
  });

  assert.deepEqual(configuration.defaultModel, {
    provider: "openai",
    model: "secondary",
  });
  assert.deepEqual(configuration.fallbackModels, [
    { provider: "backup", model: "claude" },
    { provider: "openai", model: "primary" },
  ]);
  assert.equal(configuration.maxRetries, 4);
  assert.equal(configuration.providers[0].baseUrl, "https://models.example.test/v1");
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.providers), true);
  assert.equal(Object.isFrozen(configuration.providers[0].models), true);

  const resolved = resolveConfiguredModel(configuration, "openai/primary");
  assert.equal(resolved.request.maxTokensField, "max_completion_tokens");
  assert.deepEqual(resolved.request.extraBody, {
    service_tier: "auto",
    reasoning_effort: "medium",
  });
  assert.equal(resolved.auth.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal("apiKey" in resolved.auth, false);
  assert.equal(Object.isFrozen(resolved.request.extraBody), true);
});

test("full references preserve model ids containing slashes", () => {
  assert.deepEqual(parseModelReference("gateway/org/model"), {
    provider: "gateway",
    model: "org/model",
  });
  assert.throws(() => parseModelReference("ambiguous"), /full provider\/model/u);
});

test("configuration file loading supports injected I/O and environment path", async () => {
  let requestedPath;
  const loaded = await loadModelsConfigurationFile({
    environment: { WISH_MODELS_CONFIG: "/configuration/models.json" },
    async readTextFile(path) {
      requestedPath = path;
      return JSON.stringify(fixtureConfiguration());
    },
  });
  assert.equal(requestedPath, "/configuration/models.json");
  assert.deepEqual(loaded.defaultModel, { provider: "openai", model: "primary" });
});

test("configuration fails early for duplicate, unknown, and protected settings", () => {
  const duplicate = fixtureConfiguration();
  duplicate.providers.push({ ...duplicate.providers[0] });
  assert.throws(
    () => loadModelsConfiguration({ json: duplicate }),
    /Provider id "openai" is duplicated/u,
  );

  const unknownProtocol = fixtureConfiguration();
  unknownProtocol.providers[0].protocol = "future-protocol";
  assert.throws(
    () => loadModelsConfiguration({ json: unknownProtocol }),
    /unknown protocol/u,
  );

  const protectedBody = fixtureConfiguration();
  protectedBody.providers[0].request.extraBody = { model: "override" };
  assert.throws(
    () => loadModelsConfiguration({ json: protectedBody }),
    /cannot override protected field "model"/u,
  );

  const invalidAuthority = fixtureConfiguration();
  invalidAuthority.providers[1].developerRoleMode = "native";
  assert.throws(
    () => loadModelsConfiguration({ json: invalidAuthority }),
    /must be system-fallback for anthropic-messages/u,
  );
});

test("configuration errors never include environment credential values", () => {
  const invalid = fixtureConfiguration();
  invalid.defaultModel = "missing/model";
  const secret = "secret-value-that-must-not-leak";
  assert.throws(
    () => loadModelsConfiguration({
      json: invalid,
      environment: { OPENAI_API_KEY: secret },
    }),
    (error) => !error.message.includes(secret),
  );
});

test("Registry supports external protocols and rejects duplicate registration", () => {
  const registry = new ModelAdapterRegistry();
  const adapter = { async *stream() {} };
  let factoryInput;
  registry.register("fixture-protocol", (input) => {
    factoryInput = input;
    return adapter;
  });
  assert.deepEqual(registry.protocols(), ["fixture-protocol"]);
  assert.throws(
    () => registry.register("fixture-protocol", () => adapter),
    /already registered/u,
  );

  const config = fixtureConfiguration();
  config.providers = [{
    id: "fixture",
    protocol: "fixture-protocol",
    baseUrl: "https://fixture.example.test/v1",
    auth: { type: "none" },
    models: [{ id: "model" }],
    defaultModel: "model",
  }];
  delete config.defaultModel;
  delete config.fallbackModels;
  const loaded = loadModelsConfiguration({
    json: config,
    availableProtocols: registry.protocols(),
  });
  const model = resolveConfiguredModel(loaded, "fixture/model");
  const fetch = async () => new Response();
  assert.equal(registry.create({ model, headers: { "x-test": "yes" }, fetch }), adapter);
  assert.deepEqual(factoryInput.headers, { "x-test": "yes" });
  assert.equal(Object.isFrozen(factoryInput.headers), true);
});

test("ConfiguredModel routes the exact request and resolves credentials per call", async () => {
  const registry = new ModelAdapterRegistry();
  const invocations = [];
  let activeKey = "key-one";
  const factory = (input) => ({
    async *stream(modelRequest, signal) {
      invocations.push({ input, modelRequest, signal });
      yield { type: "start", model: modelRequest.model };
      yield { type: "done", finishReason: "stop" };
    },
  });
  registry.register("openai-chat-completions", factory);
  registry.register("anthropic-messages", factory);
  const configuration = loadModelsConfiguration({ json: fixtureConfiguration() });
  const model = new ConfiguredModel({
    configuration,
    registry,
    environment: () => ({
      OPENAI_API_KEY: activeKey,
      ANTHROPIC_API_KEY: "backup-key",
      MODEL_REGION: "eu-test-1",
    }),
    fetch: async () => new Response(),
  });
  const signal = new AbortController().signal;

  model.setDefaultModel("backup/claude");
  assert.deepEqual(model.getDefaultModel(), { provider: "backup", model: "claude" });
  const first = await collect(model.stream(
    request({ provider: "openai", model: "secondary" }),
    signal,
  ));
  activeKey = "key-two";
  await collect(model.stream(request({ provider: "openai", model: "primary" })));

  assert.deepEqual(first.map((event) => event.type), ["start", "done"]);
  assert.deepEqual(invocations[0].modelRequest.model, {
    provider: "openai",
    model: "secondary",
  });
  assert.equal(invocations[0].input.headers.authorization, "Bearer key-one");
  assert.equal(invocations[0].input.headers["x-region"], "eu-test-1");
  assert.equal(invocations[0].signal, signal);
  assert.equal(invocations[1].input.headers.authorization, "Bearer key-two");
  assert.deepEqual(model.getFallbackModels(), [
    { provider: "backup", model: "claude" },
    { provider: "openai", model: "secondary" },
  ]);
  assert.equal(model.getContextWindowTokens("openai/primary"), 128000);
  assert.equal(model.getPrice("openai/primary").currency, "USD");
});

test("ConfiguredModel returns stable preflight errors and validates Registry at startup", async () => {
  const registry = new ModelAdapterRegistry();
  registry.register("openai-chat-completions", () => ({ async *stream() {} }));
  registry.register("anthropic-messages", () => ({ async *stream() {} }));
  const configuration = loadModelsConfiguration({ json: fixtureConfiguration() });
  const model = new ConfiguredModel({
    configuration,
    registry,
    environment: { MODEL_REGION: "test" },
    fetch: async () => new Response(),
  });

  const missing = await collect(model.stream(
    request({ provider: "openai", model: "primary" }),
  ));
  const unknown = await collect(model.stream(
    request({ provider: "openai", model: "not-configured" }),
  ));
  const controller = new AbortController();
  controller.abort("stop");
  const aborted = await collect(model.stream(
    request({ provider: "openai", model: "primary" }),
    controller.signal,
  ));

  assert.equal(missing[0].error.code, "missing_api_key");
  assert.match(missing[0].error.message, /OPENAI_API_KEY/u);
  assert.equal(unknown[0].error.code, "invalid_request");
  assert.equal(aborted[0].error.code, "aborted");

  const incompleteRegistry = new ModelAdapterRegistry();
  incompleteRegistry.register("openai-chat-completions", () => ({ async *stream() {} }));
  assert.throws(
    () => new ConfiguredModel({
      configuration,
      registry: incompleteRegistry,
      fetch: async () => new Response(),
    }),
    /unregistered protocol "anthropic-messages"/u,
  );
});
