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

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });

test("Model Adapter plugins follow Models and own their registrations", async () => {
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
    ]);

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
    join(repositoryRoot, "src/core/agent-loop/service.ts"),
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
    messages: [],
    tools: [],
  };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
