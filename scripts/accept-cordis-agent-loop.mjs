import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import AgentLoop, {
  Config as AgentLoopConfig,
} from "../dist/core/agent-loop/service.js";
import { bootstrap } from "../dist/boot/bootstrap.js";
import Compaction from "../dist/compaction/service.js";
import ContextEngine from "../dist/context/service.js";
import * as ModelPlugins from "../dist/models/plugins.js";
import Models from "../dist/models/service.js";
import Sessions from "../dist/sessions/service.js";
import * as BasicToolPlugins from "../dist/tools/plugins.js";
import Tools from "../dist/tools/service.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });

test("AgentLoop owns the Step pipeline and follows all injected capabilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cordis-agent-loop-"));
  const root = new Context();
  root.provide("launch", {
    cwd: repositoryRoot,
    homeDirectory: directory,
    environment: {},
  });
  const generations = [];
  let disposals = 0;
  const consumer = root.plugin({
    inject: ["agentLoop"],
    apply(ctx) {
      generations.push(ctx.agentLoop);
      ctx.effect(() => () => {
        disposals += 1;
      }, "agent loop consumer");
    },
  });
  const agentLoopProvider = root.plugin(AgentLoop, { maxParallelCalls: 2 });
  assert.equal(agentLoopProvider.state, fiberState.pending);
  assert.equal(consumer.state, fiberState.pending);

  try {
    await root.plugin(Sessions, { dataDirectory: "./state" });
    await root.plugin(Models);
    await root.plugin(ModelPlugins.OpenAIChatCompletions);
    await root.plugin(ContextEngine, { reservedOutputTokens: 256 });
    await root.plugin(Compaction, {
      keepRecentTokens: 512,
      summaryMaxOutputTokens: 128,
    });
    await root.plugin(Tools);
    await root.plugin(BasicToolPlugins.Read);
    assert.equal(agentLoopProvider.state, fiberState.active);
    await consumer.await();
    assert.equal(consumer.state, fiberState.active);
    assert.equal(root.agentLoop.maxParallelCalls, 2);
    assert.deepEqual(root.tools.registry.list().map((tool) => tool.name), ["read"]);

    const configuration = await root.models.load({
      dataDirectory: directory,
      configurationJson: JSON.stringify(fixtureModels()),
    });
    const resources = root.agentLoop.open({
      dataDirectory: join(directory, "state"),
      agentId: "wish",
      agentInstructions: [],
      modelsConfiguration: configuration,
      reservedOutputTokens: 256,
      keepRecentTokens: 512,
      summaryMaxOutputTokens: 128,
    });
    assert.equal(typeof resources.sessions.manager.create, "function");
    assert.equal(
      resources.models.configuredModel.getDefaultModel().model,
      "model",
    );
    assert.equal(typeof resources.stepPipeline.execute, "function");

    const first = root.agentLoop;
    await agentLoopProvider.update({ maxParallelCalls: 3 });
    await consumer.await();
    assert.notEqual(root.agentLoop, first);
    assert.equal(root.agentLoop.maxParallelCalls, 3);
    assert.equal(disposals, 1);
    assert.equal(generations.length, 2);

    assert.throws(
      () => agentLoopProvider.update({ maxParallelCalls: 0 }),
      /expected number >= 1/u,
    );
    assert.equal(root.agentLoop.maxParallelCalls, 3);
    assert.equal(consumer.state, fiberState.active);

    await agentLoopProvider.dispose();
    assert.equal(root.get("agentLoop"), undefined);
    assert.equal(consumer.state, fiberState.pending);
    assert.equal(disposals, 2);
    assert.deepEqual(consumer.getEffects(), []);

    await root.plugin(AgentLoop, { maxParallelCalls: 4 });
    await consumer.await();
    assert.equal(root.agentLoop.maxParallelCalls, 4);
    assert.equal(generations.length, 3);
  } finally {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }

  assert.equal(consumer.state, fiberState.disposed);
  assert.deepEqual(consumer.getEffects(), []);
  assert.equal(disposals, 3);
});

test("Loader updates and disables AgentLoop by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-loader-agent-loop-"));
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
      homeDirectory: directory,
      environment: {},
      configurationFile,
    });
    assert.equal(await booted.completion, 0);

    const id = "include:agent-loop";
    const entry = booted.context.loader.resolve(id);
    const first = booted.surfaceContext.get("agentLoop");
    await booted.context.loader.update(id, {
      config: { maxParallelCalls: 3 },
    });
    await booted.context.loader.resolve("include:application").fiber.await();
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.notEqual(booted.surfaceContext.get("agentLoop"), first);
    assert.equal(booted.surfaceContext.get("agentLoop").maxParallelCalls, 3);
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );

    await assert.rejects(
      booted.context.loader.update(id, {
        config: { maxParallelCalls: 0 },
      }),
      /expected number >= 1/u,
    );
    assert.equal(booted.surfaceContext.get("agentLoop").maxParallelCalls, 3);

    await booted.context.loader.update(id, { disabled: true });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(entry.disabled, true);
    assert.equal(booted.surfaceContext.get("agentLoop"), undefined);
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.pending,
    );
    assert.deepEqual(
      booted.context.loader.resolve("include:application").fiber.getEffects(),
      [],
    );

    await booted.context.loader.update(id, { disabled: false });
    await booted.context.loader.resolve("include:application").fiber.await();
    assert.equal(entry.disabled, false);
    assert.equal(booted.surfaceContext.get("agentLoop").maxParallelCalls, 3);
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(booted?.context.get("agentLoop"), undefined);
  assert.deepEqual(booted?.context.fiber.getEffects(), []);
});

test("AgentLoop schema and source keep Core algorithms pure and Application narrow", async () => {
  assert.deepEqual(AgentLoopConfig({ maxParallelCalls: 2 }), {
    maxParallelCalls: 2,
  });
  assert.throws(
    () => AgentLoopConfig({ maxParallelCalls: 0 }),
    /expected number >= 1/u,
  );

  const [serviceSource, runtimeSource, agentServiceSource, facadeSource, applicationSource, ...coreSources] =
    await Promise.all([
      readFile(join(repositoryRoot, "src/core/agent-loop/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/core/runtime/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/core/agent/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/application.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/core/agent/agent.ts"), "utf8"),
      readFile(
        join(repositoryRoot, "src/core/agent-loop/agent-loop.ts"),
        "utf8",
      ),
      readFile(join(repositoryRoot, "src/core/runtime/runtime.ts"), "utf8"),
    ]);

  for (const construction of [
    "new ToolExecutor",
    "new BoundedToolScheduler",
    "new CoreAgentLoop",
    "new ContextOverflowRecoveryPipeline",
    "new SessionTranscriptPipeline",
    "createSessionInputRenderer",
    "createBasicToolResultRenderer",
  ]) {
    assert.equal(facadeSource.includes(construction), false);
    assert.equal(serviceSource.includes(construction), true);
  }
  assert.match(
    runtimeSource,
    /stepPipeline: agentLoop\.stepPipeline/u,
  );
  assert.doesNotMatch(facadeSource, /new Runtime/u);
  assert.doesNotMatch(facadeSource, /new Agent/u);
  assert.match(agentServiceSource, /new CoreAgent/u);
  assert.match(agentServiceSource, /this\.ctx\.runEngine\.open/u);
  assert.match(runtimeSource, /this\.ctx\.agentLoop\.open/u);
  assert.match(applicationSource, /this\.ctx\.agents\.open/u);
  for (const source of coreSources) {
    assert.doesNotMatch(source, /@deepseek-ai\/cordis/u);
  }
});

function fixtureModels() {
  return {
    schemaVersion: 1,
    defaultModel: "fixture/model",
    fallbackModels: [],
    maxRetries: 0,
    providers: [{
      id: "fixture",
      protocol: "openai-chat-completions",
      baseUrl: "https://fixture.example.test/v1",
      auth: { type: "none" },
      developerRoleMode: "native",
      models: [{
        id: "model",
        status: "active",
        contextWindowTokens: 4_096,
        maxOutputTokens: 1_024,
        input: { text: true, image: false },
        reasoning: false,
        toolCalling: true,
        developerRole: true,
      }],
    }],
  };
}
