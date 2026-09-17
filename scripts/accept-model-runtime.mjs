import assert from "node:assert/strict";
import test from "node:test";

import {
  loadModelsConfiguration,
  loadModelsConfigurationFile,
  parseModelReference,
  resolveConfiguredModel,
} from "../dist/models/config.js";
import {
  createDefaultModelAdapterRegistry,
  ModelAdapterRegistry,
} from "../dist/models/registry.js";
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

test("generated defaults expose current Providers and DeepSeek compatibility", () => {
  const configuration = loadModelsConfiguration({ environment: {} });

  assert.deepEqual(configuration.defaultModel, {
    provider: "deepseek",
    model: "deepseek-flash",
  });
  assert.deepEqual(configuration.fallbackModels, []);
  assert.equal(configuration.maxRetries, 2);
  assert.deepEqual(configuration.providers.map((provider) => provider.id), [
    "deepseek",
    "anthropic",
    "openai",
    "openrouter",
    "vercel-ai-gateway",
    "groq",
    "cerebras",
    "xai",
    "zai",
    "huggingface",
    "fireworks",
    "opencode",
    "opencode-go",
    "minimax",
    "minimax-cn",
    "moonshotai",
    "moonshotai-cn",
  ]);
  assert.ok(
    configuration.providers.reduce(
      (count, provider) => count + provider.models.length,
      0,
    ) > 500,
  );
  assert.deepEqual(
    configuration.providers[0].models.map((model) => model.id),
    [
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
    ],
  );

  const flash = resolveConfiguredModel(
    configuration,
    "deepseek/deepseek-flash",
  );
  assert.equal(flash.baseUrl, "https://api.deepseek.com");
  assert.deepEqual(flash.auth, {
    type: "bearer",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  });
  assert.equal(flash.developerRoleMode, "system-fallback");
  assert.equal(flash.request.supportsTemperature, false);
  assert.equal(flash.request.maxTokensField, "max_tokens");
  assert.deepEqual(flash.request.extraBody, {
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  assert.equal(flash.spec.contextWindowTokens, 1_000_000);
  assert.equal(flash.spec.maxOutputTokens, 393_216);
  assert.equal(flash.spec.input.image, true);
  assert.equal(flash.spec.toolCalling, true);
  assert.equal(flash.spec.price, undefined, "tiered current pricing must not be flattened");

  const legacyFlash = resolveConfiguredModel(configuration, "deepseek/deepseek-v4-flash");
  assert.equal(legacyFlash.spec.status, "deprecated");
  assert.equal(legacyFlash.spec.input.image, true);
  assert.equal(legacyFlash.spec.price, undefined);

  const vision = resolveConfiguredModel(
    configuration,
    "deepseek/deepseek-v4-flash-vision-exp",
  );
  assert.equal(vision.spec.input.image, true);
  assert.equal(vision.spec.status, "deprecated");
  assert.equal(vision.spec.price, undefined);

  const openai = resolveConfiguredModel(configuration, "openai/gpt-5.6");
  assert.equal(openai.protocol, "openai-responses");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.deepEqual(openai.auth, {
    type: "bearer",
    apiKeyEnv: "OPENAI_API_KEY",
  });
  assert.equal(openai.developerRoleMode, "native");
  assert.equal(openai.spec.developerRole, true);
  assert.equal(openai.request.maxTokensField, "max_output_tokens");
  assert.deepEqual(openai.request.extraBody, { store: false });

  const selected = loadModelsConfiguration({
    environment: { WISH_MODEL: "deepseek/deepseek-v4-pro" },
  });
  assert.deepEqual(selected.defaultModel, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
  });
});

test("ConfiguredModel samples a late-bound default without rewriting explicit requests", () => {
  const configuration = loadModelsConfiguration({ json: fixtureConfiguration(), environment: {} });
  let selected = "openai/primary";
  const model = new ConfiguredModel({ configuration, registry: createDefaultModelAdapterRegistry(), defaultModel: () => selected });
  assert.deepEqual(model.getDefaultModel(), { provider: "openai", model: "primary" });
  selected = "openai/secondary";
  assert.deepEqual(model.getDefaultModel(), { provider: "openai", model: "secondary" });
  assert.equal(model.resolve("openai/primary").spec.id, "primary");
});

test("schemaVersion 2 overlays generated Providers and upserts Models", () => {
  const configuration = loadModelsConfiguration({
    json: {
      schemaVersion: 2,
      defaultModel: "local/qwen-local",
      fallbackModels: ["deepseek/deepseek-v4-flash"],
      maxRetries: 4,
      providers: [
        {
          id: "deepseek",
          baseUrl: "https://deepseek-proxy.example.test/v1",
          headers: { "x-tenant": { fromEnv: "TENANT_ID" } },
          request: { extraBody: { trace: true } },
          models: [{
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash Overridden",
            defaultMaxOutputTokens: 16384,
            input: { image: true },
          }],
        },
        {
          id: "local",
          protocol: "openai-chat-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
          auth: { type: "none" },
          developerRoleMode: "system-fallback",
          models: [{ id: "qwen-local", toolCalling: true }],
        },
      ],
    },
    environment: {},
  });

  assert.equal(configuration.providers.length, 18);
  assert.deepEqual(configuration.defaultModel, {
    provider: "local",
    model: "qwen-local",
  });
  assert.deepEqual(configuration.fallbackModels, [{
    provider: "deepseek",
    model: "deepseek-v4-flash",
  }]);
  assert.equal(configuration.maxRetries, 4);

  const flash = resolveConfiguredModel(
    configuration,
    "deepseek/deepseek-v4-flash",
  );
  assert.equal(flash.spec.name, "DeepSeek V4 Flash Overridden");
  assert.equal(flash.spec.contextWindowTokens, 1_000_000);
  assert.equal(flash.spec.maxOutputTokens, 393_216);
  assert.equal(flash.spec.defaultMaxOutputTokens, 16_384);
  assert.equal(flash.spec.input.text, true);
  assert.equal(flash.spec.input.image, true);
  assert.equal(flash.headers["x-tenant"].fromEnv, "TENANT_ID");
  assert.deepEqual(flash.request.extraBody, {
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    trace: true,
  });
  assert.equal(
    configuration.providers.find((provider) => provider.id === "deepseek")
      .models.length,
    4,
  );
});

test("generated DeepSeek profile maps an authenticated thinking Tool request", async () => {
  const requests = [];
  const configuration = loadModelsConfiguration({ environment: {} });
  const model = new ConfiguredModel({
    configuration,
    registry: createDefaultModelAdapterRegistry(),
    environment: { DEEPSEEK_API_KEY: "deepseek-test-key" },
    async fetch(url, init) {
      requests.push({ url: String(url), init });
      const completion = {
        choices: [{
          delta: { content: "done" },
          finish_reason: "stop",
          index: 0,
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      };
      return new Response(
        `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const events = await collect(model.stream({
    model: configuration.defaultModel,
    messages: [
      { role: "developer", content: "Work carefully" },
      { role: "user", content: "Inspect the project" },
    ],
    tools: [{
      name: "read",
      description: "Read a file",
      inputSchemaJson: '{"type":"object"}',
    }],
    temperature: 0.2,
  }));

  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "text_delta",
    "done",
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(
    requests[0].init.headers.authorization,
    "Bearer deepseek-test-key",
  );
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "Work carefully");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
  assert.equal("max_tokens" in body, false, "model capability must not become a request default");
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(body.tools[0].function.name, "read");
  assert.equal("temperature" in body, false);
});

test("model request defaults, user preferences and explicit limits have distinct precedence", async () => {
  const configuration = loadModelsConfiguration({
    json: {
      schemaVersion: 1,
      defaultModel: "fixture/one",
      providers: [{
        id: "fixture", protocol: "openai-chat-completions", baseUrl: "https://fixture.example.test/v1",
        auth: { type: "none" }, developerRoleMode: "native",
        models: [
          { id: "one", developerRole: true, maxOutputTokens: 2048, defaultMaxOutputTokens: 1024 },
          { id: "two", developerRole: true, maxOutputTokens: 4096 },
        ],
      }],
    },
  });
  const captured = [];
  const registry = new ModelAdapterRegistry();
  registry.register("openai-chat-completions", () => ({
    async *stream(input) {
      captured.push(input.maxOutputTokens);
      yield { type: "done" };
    },
  }));
  let preference;
  const model = new ConfiguredModel({
    configuration, registry,
    maxOutputTokens: (reference, configured) => reference.model === "one" ? preference ?? configured : configured,
  });
  await collect(model.stream(request({ provider: "fixture", model: "one" })));
  preference = 1536;
  await collect(model.stream(request({ provider: "fixture", model: "one" })));
  await collect(model.stream({ ...request({ provider: "fixture", model: "one" }), maxOutputTokens: 512 }));
  await collect(model.stream(request({ provider: "fixture", model: "two" })));
  assert.deepEqual(captured, [1024, 1536, 512, undefined]);
  const invalid = await collect(model.stream({ ...request({ provider: "fixture", model: "one" }), maxOutputTokens: 4096 }));
  assert.equal(invalid.at(-1).error.code, "invalid_request");
  assert.equal(captured.length, 4, "invalid request must not reach its Adapter");
  assert.throws(() => loadModelsConfiguration({
    json: { schemaVersion: 1, defaultModel: "fixture/one", providers: [{
      id: "fixture", protocol: "openai-chat-completions", baseUrl: "https://fixture.example.test/v1",
      auth: { type: "none" }, developerRoleMode: "native",
      models: [{ id: "one", developerRole: true, maxOutputTokens: 2048, defaultMaxOutputTokens: 4096 }],
    }] },
  }), /defaultMaxOutputTokens exceeds maxOutputTokens/u);
});

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

  assert.throws(
    () => loadModelsConfiguration({
      json: {
        schemaVersion: 2,
        providers: [{ id: "deepseek" }, { id: "deepseek" }],
      },
    }),
    /Provider overlay id "deepseek" is duplicated/u,
  );
  assert.throws(
    () => loadModelsConfiguration({
      json: {
        schemaVersion: 2,
        providers: [{
          id: "deepseek",
          models: [
            { id: "deepseek-v4-flash" },
            { id: "deepseek-v4-flash" },
          ],
        }],
      },
    }),
    /Model overlay id "deepseek-v4-flash" is duplicated/u,
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
