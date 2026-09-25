import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import { bootstrap } from "../dist/boot/bootstrap.js";
import Models, {
  Config as ModelsConfig,
} from "../dist/models/service.js";
import { SettingsService } from "../dist/settings/service.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });

test("Model plugins follow Models and own Adapter and Pricing registrations", async () => {
  const environment = { FIXTURE_API_KEY: "first-secret" };
  const root = new Context();
  root.provide("launch", {
    cwd: repositoryRoot,
    homeDirectory: repositoryRoot,
    environment,
  });
  const observedHeaders = [];
  const adapter = {
    inject: ["models"],
    apply(ctx) {
      ctx.models.register("fixture-protocol", ({ headers }) => ({
        async *stream(request) {
          observedHeaders.push(headers);
          yield { type: "start", model: request.model };
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", finishReason: "stop" };
        },
      }));
      ctx.models.registerPricing({
        provider: "fixture",
        quote(input) {
          return {
            version: "fixture-price-v1",
            currency: input.currency,
            inputPerMillionTokens: 1,
            outputPerMillionTokens: 2,
            requestedModel: input.requestedModel,
            billedModel: input.requestedModel,
            period: "flat",
            pricedAt: new Date(input.requestedAt).toISOString(),
            timeBasis: "request_started",
          };
        },
      });
    },
  };
  let adapterFiber = root.plugin(adapter);
  assert.equal(adapterFiber.state, fiberState.pending);

  let provider;
  try {
    provider = await root.plugin(Models);
    await adapterFiber.await();
    assert.deepEqual(root.models.registry.protocols(), ["fixture-protocol"]);
    assert.deepEqual(adapterFiber.getEffects().map((effect) => effect.label), [
      'models.register("fixture-protocol")',
      'models.registerPricing("fixture")',
    ]);
    assert.equal(root.models.pricing.resolve({
      requestedModel: { provider: "fixture", model: "model" },
      requestedAt: Date.parse("2026-09-19T00:00:00.000Z"),
      currency: "USD",
    }).version, "fixture-price-v1");

    const configuration = await root.models.load({
      dataDirectory: repositoryRoot,
      configurationJson: JSON.stringify({
        schemaVersion: 1,
        defaultModel: "fixture/model",
        maxRetries: 0,
        providers: [{
          id: "fixture",
          protocol: "fixture-protocol",
          baseUrl: "https://fixture.example.test/v1",
          auth: { type: "bearer", apiKeyEnv: "FIXTURE_API_KEY" },
          developerRoleMode: "native",
          models: [{
            id: "model",
            status: "active",
            input: { text: true, image: false },
            reasoning: false,
            toolCalling: false,
            developerRole: true,
          }],
        }],
      }),
    });
    const resources = root.models.open(configuration, {
      fetch: async () => new Response(),
    });
    assert.equal(resources.configuredModel.getDefaultModel().model, "model");
    assert.equal(resources.requestCounter.constructor.name, "ModelRequestTokenCounter");

    await collect(resources.configuredModel.stream(request()));
    assert.equal(observedHeaders[0].authorization, "Bearer first-secret");
    environment.FIXTURE_API_KEY = "rotated-secret";
    await collect(resources.configuredModel.stream(request()));
    assert.equal(observedHeaders[1].authorization, "Bearer rotated-secret");

    await adapterFiber.dispose();
    assert.deepEqual(root.models.registry.protocols(), []);
    assert.equal(root.models.pricing.resolve({
      requestedModel: { provider: "fixture", model: "model" },
      requestedAt: Date.parse("2026-09-19T00:00:00.000Z"),
      currency: "USD",
    }), undefined);
    assert.deepEqual(adapterFiber.getEffects(), []);
    assert.equal(
      (await collect(resources.configuredModel.stream(request()))).at(-1).error.code,
      "provider_error",
    );

    adapterFiber = await root.plugin(adapter);
    assert.deepEqual(root.models.registry.protocols(), ["fixture-protocol"]);
    assert.equal(
      (await collect(resources.configuredModel.stream(request()))).at(-1).type,
      "done",
    );

    const registry = root.models.registry;
    await provider.dispose();
    assert.equal(root.get("models"), undefined);
    assert.equal(adapterFiber.state, fiberState.pending);
    assert.deepEqual(registry.protocols(), []);
    assert.deepEqual(adapterFiber.getEffects(), []);
  } finally {
    await root.fiber.dispose();
  }

  assert.equal(adapterFiber.state, fiberState.disposed);
});

test("Models owns a WebUI setting that changes the default sampled by new Runs", async () => {
  const root = new Context();
  root.provide("launch", {
    surface: "webui",
    cwd: repositoryRoot,
    homeDirectory: repositoryRoot,
    environment: {},
  });
  let document = { version: 1, revision: "initial", sections: { models: { "default-model": "fixture/removed" } } };
  new SettingsService(root, {
    writable: true,
    read: () => document,
    save: async (_revision, sections) => document = { version: 1, revision: "saved", sections },
    close: async () => {},
  });
  const seenLimits = [];
  const adapter = root.plugin({
    inject: ["models"],
    apply(ctx) {
      ctx.models.register("fixture-protocol", () => ({ async *stream(request) { seenLimits.push(request.maxOutputTokens); } }));
    },
  });
  try {
    await root.plugin(Models); await adapter;
    const configuration = await root.models.load({
      dataDirectory: repositoryRoot,
      configurationJson: JSON.stringify({
        schemaVersion: 1,
        defaultModel: "fixture/primary",
        maxRetries: 0,
        providers: [{
          id: "fixture", protocol: "fixture-protocol", baseUrl: "https://fixture.example.test/v1",
          auth: { type: "none" }, developerRoleMode: "native",
          models: [
            { id: "primary", developerRole: true, maxOutputTokens: 2048, defaultMaxOutputTokens: 1024 },
            { id: "secondary", developerRole: true, maxOutputTokens: 4096 },
          ],
        }],
      }),
    });
    const configured = root.models.open(configuration).configuredModel;
    const settings = root.settings.port.describe().sections.find(section => section.namespace === "models");
    assert.ok(settings);
    assert.deepEqual(settings.fields[0].options.map(option => option.value), ["fixture/primary", "fixture/secondary"]);
    assert.equal(settings.value["default-model"], "fixture/removed", "removed choices stay visible for repair");
    assert.deepEqual(configured.getDefaultModel(), { provider: "fixture", model: "primary" });
    await root.settings.port.replace({ namespace: "models", revision: settings.revision, user: { "default-model": "fixture/secondary" } });
    assert.deepEqual(configured.getDefaultModel(), { provider: "fixture", model: "secondary" });
    const primaryRequest = { model: { provider: "fixture", model: "primary" }, instructions: [], messages: [{ role: "user", content: "hello" }], tools: [] };
    await collect(configured.stream(primaryRequest));
    assert.deepEqual(seenLimits, [1024]);
    const next = root.settings.port.describe().sections.find(section => section.namespace === "models");
    assert.deepEqual(next.fields[0].options[0].attributes, {
      provider: "fixture", model: "primary", maxOutputTokens: 2048, defaultMaxOutputTokens: 1024,
    });
    await root.settings.port.replace({ namespace: "models", revision: next.revision, user: {
      ...next.user, "max-output-token-overrides": JSON.stringify({ "fixture/primary": 1536 }),
    } });
    await collect(configured.stream(primaryRequest));
    assert.deepEqual(seenLimits, [1024, 1536]);
    const current = root.settings.port.describe().sections.find(section => section.namespace === "models");
    await assert.rejects(root.settings.port.replace({ namespace: "models", revision: current.revision, user: {
      ...current.user, "max-output-token-overrides": JSON.stringify({ "fixture/primary": 3000 }),
    } }), { code: "settings_validation_failed" });
    await collect(configured.stream(primaryRequest));
    assert.deepEqual(seenLimits, [1024, 1536, 1536], "rejected values must not affect live requests");
  } finally { await root.fiber.dispose(); }
  assert.equal(root.get("settings"), undefined);
});

test("saved retired DeepSeek selections resolve to current Flash without discarding user settings", async () => {
  const root = new Context();
  root.provide("launch", { surface: "webui", cwd: repositoryRoot, homeDirectory: repositoryRoot, environment: {} });
  let document = { version: 1, revision: "initial", sections: { models: { "default-model": "deepseek/deepseek-v4-flash-vision-exp" } } };
  new SettingsService(root, {
    writable: true, read: () => document,
    save: async (_revision, sections) => document = { version: 1, revision: "saved", sections },
    close: async () => {},
  });
  const adapter = root.plugin({ inject: ["models"], apply(ctx) {
    for (const protocol of ["openai-chat-completions", "openai-responses", "anthropic-messages"]) {
      ctx.models.register(protocol, () => ({ async *stream() {} }));
    }
  } });
  try {
    await root.plugin(Models); await adapter;
    const configuration = await root.models.load({ dataDirectory: repositoryRoot });
    const model = root.models.open(configuration).configuredModel;
    assert.deepEqual(model.getDefaultModel(), { provider: "deepseek", model: "deepseek-flash" });
    const settings = root.settings.port.describe().sections.find(section => section.namespace === "models");
    assert.equal(settings.user["default-model"], "deepseek/deepseek-v4-flash-vision-exp", "stored preference remains visible and recoverable");
    assert.match(settings.fields[0].options.find(option => option.value === "deepseek/deepseek-v4-flash-vision-exp").label, /已退役兼容名/u);
    await root.settings.port.replace({ namespace: "models", revision: settings.revision, user: { "default-model": "deepseek/deepseek-v4-flash" } });
    assert.deepEqual(model.getDefaultModel(), { provider: "deepseek", model: "deepseek-flash" });
  } finally { await root.fiber.dispose(); }
});

test("Models owns its settings registration across caller Fiber replacement", async () => {
  const root = new Context();
  root.provide("launch", { surface: "webui", cwd: repositoryRoot, homeDirectory: repositoryRoot, environment: {} });
  new SettingsService(root, {
    writable: true, read: () => ({ version: 1, revision: "initial", sections: {} }),
    save: async () => {}, close: async () => {},
  });
  const adapter = root.plugin({ inject: ["models"], apply(ctx) {
    ctx.models.register("fixture-protocol", () => ({ async *stream() {} }));
  } });
  try {
    const provider = await root.plugin(Models); await adapter;
    let configured;
    const consumer = await root.plugin({ inject: ["models"], async apply(ctx) {
      const configuration = await ctx.models.load({ dataDirectory: repositoryRoot, configurationJson: JSON.stringify({
        schemaVersion: 1, defaultModel: "fixture/primary", maxRetries: 0,
        providers: [{ id: "fixture", protocol: "fixture-protocol", baseUrl: "https://fixture.example.test/v1",
          auth: { type: "none" }, developerRoleMode: "native", models: [{ id: "primary", developerRole: true }] }],
      }) });
      configured = ctx.models.open(configuration).configuredModel;
    } });
    assert.ok(root.settings.port.describe().sections.some(section => section.namespace === "models"));
    assert.equal(consumer.getEffects().some(effect => effect.label === "settings:models"), false);
    assert.equal(provider.getEffects().some(effect => effect.label === "settings:models"), true);
    await consumer.dispose();
    assert.ok(root.settings.port.describe().sections.some(section => section.namespace === "models"));
    assert.deepEqual(configured.getDefaultModel(), { provider: "fixture", model: "primary" });
  } finally { await root.fiber.dispose(); }
});

test("Loader updates and disables Models and one Adapter by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-loader-models-"));
  const configurationFile = join(directory, "cordis.yml");
  await writeFile(
    configurationFile,
    await readFile(join(repositoryRoot, "config/cordis.yml"), "utf8"),
  );
  let booted;
  try {
    booted = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      cwd: repositoryRoot,
      homeDirectory: repositoryRoot,
      environment: {},
      configurationFile,
    });
    assert.equal(await booted.completion, 0);
    assert.deepEqual(booted.surfaceContext.get("models").registry.protocols(), [
      "openai-chat-completions",
      "openai-responses",
      "anthropic-messages",
    ]);

    const adapterId = "include:model-openai-responses";
    const adapterEntry = booted.context.loader.resolve(adapterId);
    await booted.context.loader.update(adapterId, { disabled: true });
    assert.equal(booted.context.loader.resolve(adapterId), adapterEntry);
    assert.equal(adapterEntry.disabled, true);
    assert.deepEqual(booted.surfaceContext.get("models").registry.protocols(), [
      "openai-chat-completions",
      "anthropic-messages",
    ]);
    await booted.context.loader.update(adapterId, { disabled: false });
    assert.equal(booted.context.loader.resolve(adapterId), adapterEntry);
    assert.deepEqual(booted.surfaceContext.get("models").registry.protocols(), [
      "openai-chat-completions",
      "anthropic-messages",
      "openai-responses",
    ]);

    const modelsId = "include:models";
    const modelsEntry = booted.context.loader.resolve(modelsId);
    const first = booted.surfaceContext.get("models");
    await booted.context.loader.update(modelsId, { config: { maxRetries: 0 } });
    assert.equal(booted.context.loader.resolve(modelsId), modelsEntry);
    assert.notEqual(booted.surfaceContext.get("models"), first);
    assert.deepEqual(new Set(booted.surfaceContext.get("models").registry.protocols()), new Set([
      "openai-chat-completions",
      "openai-responses",
      "anthropic-messages",
    ]));
    await assert.rejects(
      booted.context.loader.update(modelsId, { config: { maxRetries: -1 } }),
      /expected number >= 0/u,
    );
    assert.equal(booted.surfaceContext.get("models").registry.protocols().length, 3);

    const activeRegistry = booted.surfaceContext.get("models").registry;
    await booted.context.loader.update(modelsId, { disabled: true });
    assert.equal(modelsEntry.disabled, true);
    assert.equal(booted.surfaceContext.get("models"), undefined);
    assert.deepEqual(activeRegistry.protocols(), []);
    for (const id of [
      "include:model-openai-chat-completions",
      "include:model-openai-responses",
      "include:model-anthropic-messages",
      "include:application",
    ]) {
      assert.equal(
        booted.context.loader.resolve(id).fiber.state,
        fiberState.pending,
      );
    }

    await booted.context.loader.update(modelsId, { disabled: false });
    assert.equal(modelsEntry.disabled, false);
    assert.equal(booted.surfaceContext.get("models").registry.protocols().length, 3);
    await booted.context.loader.resolve("include:application").fiber.await();
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(booted?.context.get("models"), undefined);
  assert.deepEqual(booted?.context.fiber.getEffects(), []);
});

test("Models owns its schema and AgentLoop consumes the request stack", async () => {
  assert.deepEqual(ModelsConfig({ maxRetries: 0 }), { maxRetries: 0 });
  assert.throws(
    () => ModelsConfig({ maxRetries: -1 }),
    /expected number >= 0/u,
  );

  const applicationSource = await readFile(
    join(repositoryRoot, "src/apps/application.ts"),
    "utf8",
  );
  for (const construction of [
    "createDefaultModelAdapterRegistry",
    "createConfiguredModelStack",
    "createConfiguredModelRequestTokenCounter",
    "new TokenizerUsageEstimator",
  ]) {
    assert.doesNotMatch(applicationSource, new RegExp(construction, "u"));
  }
  assert.match(applicationSource, /configuredModel: options\.models\.configuredModel/u);
  assert.doesNotMatch(applicationSource, /options\.models\.requestCounter/u);

  const agentLoopSource = await readFile(
    join(repositoryRoot, "src/composition/agent-loop-service.ts"),
    "utf8",
  );
  assert.match(agentLoopSource, /this\.ctx\.models\.open/u);
  assert.match(agentLoopSource, /model: modelStack\.model/u);
  assert.match(agentLoopSource, /modelStack\.configuredModel/u);

  const applicationServiceSource = await readFile(
    join(repositoryRoot, "src/apps/service.ts"),
    "utf8",
  );
  assert.match(applicationServiceSource, /this\.ctx\.models\.load/u);
  assert.match(applicationServiceSource, /this\.ctx\.agents\.open/u);
  assert.doesNotMatch(applicationServiceSource, /this\.ctx\.models\.open/u);
  assert.match(applicationServiceSource, /export interface Config \{\}/u);
  assert.match(
    applicationServiceSource,
    /interface ApplicationConfigurationOverrides[\s\S]*readonly modelsConfigurationPath/u,
  );
});

function request() {
  return {
    model: { provider: "fixture", model: "model" },
    instructions: [],
    messages: [],
    tools: [],
  };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
