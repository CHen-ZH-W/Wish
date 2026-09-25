import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import { bootstrap } from "../dist/boot/bootstrap.js";
import Compaction, {
  Config as CompactionConfig,
} from "../dist/compaction/service.js";
import ContextEngine, {
  Config as ContextEngineConfig,
} from "../dist/context/service.js";
import * as ModelPlugins from "../dist/models/plugins.js";
import Models from "../dist/models/service.js";
import Sessions from "../dist/sessions/service.js";
import { StorageHub } from "../dist/storage/index.js";
import FileStorage from "../dist/storage/providers/file/plugin.js";
import FileSessionPersistence from
  "../dist/sessions/providers/file/plugin.js";
import BlobToolResultArchiveProvider from
  "../dist/tools/results/providers/blob.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });

test("ContextEngine and Compaction own construction and dependency lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cordis-context-"));
  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  const generations = [];
  let disposals = 0;
  const consumer = root.plugin({
    inject: ["contextEngine", "compaction"],
    apply(ctx) {
      generations.push({
        contextEngine: ctx.contextEngine,
        compaction: ctx.compaction,
      });
      ctx.effect(() => () => {
        disposals += 1;
      }, "context and compaction consumer");
    },
  });
  assert.equal(consumer.state, fiberState.pending);

  let contextProvider;
  let compactionProvider;
  try {
    await root.plugin(StorageHub);
    await root.plugin(FileStorage, {
      id: "file",
      rootDirectory: "./storage",
    });
    await root.plugin(BlobToolResultArchiveProvider, { backendId: "file" });
    await root.plugin(FileSessionPersistence);
    await root.plugin(Sessions, { dataDirectory: "./state" });
    await root.plugin(Models);
    await root.plugin(ModelPlugins.OpenAIChatCompletions);
    assert.equal(consumer.state, fiberState.pending);

    contextProvider = await root.plugin(ContextEngine, {
      reservedOutputTokens: 256,
    });
    assert.equal(consumer.state, fiberState.pending);
    compactionProvider = await root.plugin(Compaction, {
      keepRecentTokens: 512,
      summaryMaxOutputTokens: 128,
    });
    await consumer.await();
    assert.equal(consumer.state, fiberState.active);
    assert.equal(generations.length, 1);

    const configuration = await root.models.load({
      dataDirectory: directory,
      configurationJson: JSON.stringify(fixtureModels()),
    });
    const models = root.models.open(configuration, {
      fetch: async () => new Response(),
    });
    const dynamicContext = root.plugin({
      inject: ["contextEngine"],
      apply(ctx) {
        ctx.contextEngine.registerProvider({
          id: "fixture-dynamic",
          provide() { return []; },
        });
      },
    });
    await dynamicContext.await();
    const context = root.contextEngine.open({
      dataDirectory: join(directory, "state"),
      models,
      configuration: { reservedOutputTokens: 256 },
    });
    const compactor = root.compaction.open({
      dataDirectory: join(directory, "state"),
      models,
      keepRecentTokens: 512,
      summaryMaxOutputTokens: 128,
    });
    assert.equal(context.configuration.reservedOutputTokens, 256);
    assert.deepEqual(context.configuration.providerOrder, [
      "instructions",
      "history",
      "state",
      "fixture-dynamic",
    ]);
    assert.equal(typeof context.forStep, "function");
    assert.equal(context.released, false);
    assert.equal(compactor.keepRecentTokens, 512);
    assert.equal(typeof compactor.compact, "function");
    assert.equal(context.release(), true);
    assert.equal(context.release(), false);
    await dynamicContext.dispose();
    const withoutDynamic = root.contextEngine.open({
      dataDirectory: join(directory, "state"),
      models,
      configuration: { reservedOutputTokens: 256 },
    });
    assert.deepEqual(withoutDynamic.configuration.providerOrder, [
      "instructions",
      "history",
      "state",
    ]);
    withoutDynamic.release();

    const firstContextEngine = root.contextEngine;
    await contextProvider.update({ reservedOutputTokens: 384 });
    await consumer.await();
    assert.notEqual(root.contextEngine, firstContextEngine);
    assert.equal(root.contextEngine.reservedOutputTokens, 384);
    assert.equal(disposals, 1);
    assert.equal(generations.length, 2);
    assert.throws(() => firstContextEngine.open({}), /context_engine_closed/);
    await assert.rejects(context.projector.project({}), /context_engine_closed/);

    const firstCompaction = root.compaction;
    await compactionProvider.update({
      keepRecentTokens: 768,
      summaryMaxOutputTokens: 192,
    });
    await consumer.await();
    assert.notEqual(root.compaction, firstCompaction);
    assert.equal(root.compaction.keepRecentTokens, 768);
    assert.equal(root.compaction.summaryMaxOutputTokens, 192);
    assert.equal(disposals, 2);
    assert.equal(generations.length, 3);
    assert.throws(() => firstCompaction.open({}), /compaction_closed/);
    await assert.rejects(compactor.compact({}), /compaction_closed/);

    assert.throws(
      () => contextProvider.update({ reservedOutputTokens: -1 }),
      /expected number >= 0/u,
    );
    assert.equal(root.contextEngine.reservedOutputTokens, 384);
    assert.equal(consumer.state, fiberState.active);

    await compactionProvider.dispose();
    assert.equal(root.get("compaction"), undefined);
    assert.equal(consumer.state, fiberState.pending);
    assert.equal(disposals, 3);
    assert.deepEqual(consumer.getEffects(), []);

    compactionProvider = await root.plugin(Compaction, {
      keepRecentTokens: 1_024,
      summaryMaxOutputTokens: 256,
    });
    await consumer.await();
    assert.equal(consumer.state, fiberState.active);
    assert.equal(generations.length, 4);
  } finally {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }

  assert.equal(consumer.state, fiberState.disposed);
  assert.deepEqual(consumer.getEffects(), []);
  assert.equal(disposals, 4);
});

test("Loader updates and disables ContextEngine and Compaction by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-loader-context-"));
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
    const stableApplication = booted.context.loader.resolve("include:application").fiber;

    const contextId = "include:context-engine";
    const contextEntry = booted.context.loader.resolve(contextId);
    const firstContextEngine = booted.surfaceContext.get("contextEngine");
    await booted.context.loader.update(contextId, {
      config: { reservedOutputTokens: 384 },
    });
    assert.equal(booted.context.loader.resolve(contextId), contextEntry);
    assert.notEqual(booted.surfaceContext.get("contextEngine"), firstContextEngine);
    assert.equal(
      booted.surfaceContext.get("contextEngine").reservedOutputTokens,
      384,
    );
    await booted.context.loader.resolve("include:application").fiber.await();
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );

    const compactionId = "include:compaction";
    const compactionEntry = booted.context.loader.resolve(compactionId);
    const firstCompaction = booted.surfaceContext.get("compaction");
    await booted.context.loader.update(compactionId, {
      config: {
        keepRecentTokens: 768,
        summaryMaxOutputTokens: 192,
      },
    });
    assert.equal(booted.context.loader.resolve(compactionId), compactionEntry);
    assert.notEqual(booted.surfaceContext.get("compaction"), firstCompaction);
    assert.equal(booted.surfaceContext.get("compaction").keepRecentTokens, 768);
    assert.equal(
      booted.surfaceContext.get("compaction").summaryMaxOutputTokens,
      192,
    );

    await assert.rejects(
      booted.context.loader.update(compactionId, {
        config: { keepRecentTokens: 0 },
      }),
      /expected number >= 1/u,
    );
    assert.equal(booted.surfaceContext.get("compaction").keepRecentTokens, 768);

    await booted.context.loader.update(contextId, { disabled: true });
    assert.equal(booted.context.loader.resolve(contextId), contextEntry);
    assert.equal(contextEntry.disabled, true);
    assert.equal(booted.surfaceContext.get("contextEngine"), undefined);
    assert.equal(
      booted.context.loader.resolve("include:agent-loop").fiber.state,
      fiberState.pending,
    );
    assert.equal(booted.context.loader.resolve("include:application").fiber, stableApplication);
    assert.equal(stableApplication.state, fiberState.active);

    await booted.context.loader.update(contextId, { disabled: false });
    assert.equal(contextEntry.disabled, false);
    assert.equal(
      booted.surfaceContext.get("contextEngine").reservedOutputTokens,
      384,
    );
    await booted.context.loader.resolve("include:application").fiber.await();
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );

    await booted.context.loader.update(compactionId, { disabled: true });
    assert.equal(compactionEntry.disabled, true);
    assert.equal(booted.surfaceContext.get("compaction"), undefined);
    assert.equal(
      booted.context.loader.resolve("include:agent-loop").fiber.state,
      fiberState.pending,
    );
    assert.equal(booted.context.loader.resolve("include:application").fiber, stableApplication);
    assert.equal(stableApplication.state, fiberState.active);
    await booted.context.loader.update(compactionId, { disabled: false });
    assert.equal(compactionEntry.disabled, false);
    assert.equal(booted.surfaceContext.get("compaction").keepRecentTokens, 768);
    await booted.context.loader.resolve("include:application").fiber.await();
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(booted?.context.get("contextEngine"), undefined);
  assert.equal(booted?.context.get("compaction"), undefined);
  assert.deepEqual(booted?.context.fiber.getEffects(), []);
});

test("schemas reject invalid generations and AgentLoop consumes capabilities", async () => {
  assert.deepEqual(ContextEngineConfig({ reservedOutputTokens: 0 }), {
    reservedOutputTokens: 0,
  });
  assert.deepEqual(CompactionConfig({
    keepRecentTokens: 512,
    summaryMaxOutputTokens: 128,
  }), {
    keepRecentTokens: 512,
    summaryMaxOutputTokens: 128,
  });
  assert.throws(
    () => ContextEngineConfig({ reservedOutputTokens: -1 }),
    /expected number >= 0/u,
  );
  assert.throws(
    () => CompactionConfig({ summaryMaxOutputTokens: 0 }),
    /expected number >= 1/u,
  );

  const applicationSource = await readFile(
    join(repositoryRoot, "src/apps/application.ts"),
    "utf8",
  );
  const agentLoopSource = await readFile(
    join(repositoryRoot, "src/composition/agent-loop-service.ts"),
    "utf8",
  );
  for (const construction of [
    "new FileToolResultArchive",
    "createContextBundle(",
    "new ModelCompactionSummarizer",
    "new SessionCompactor",
  ]) {
    assert.equal(applicationSource.includes(construction), false);
  }
  assert.doesNotMatch(applicationSource, /options\.context/u);
  assert.doesNotMatch(applicationSource, /options\.compaction/u);
  assert.match(agentLoopSource, /this\.ctx\.contextEngine\.open/u);
  assert.match(agentLoopSource, /this\.ctx\.compaction\.open/u);

  const contextEngineSource = await readFile(
    join(repositoryRoot, "src/context/service.ts"),
    "utf8",
  );
  assert.doesNotMatch(contextEngineSource, /new FileToolResultArchive/u);
  assert.match(contextEngineSource, /this\.ctx\.toolResultArchive\.open/u);
  assert.match(
    contextEngineSource,
    /inject = \["sessions", "models", "toolResultArchive"\]/u,
  );

  const runtimeSource = await readFile(
    join(repositoryRoot, "src/composition/runtime-service.ts"),
    "utf8",
  );
  assert.match(runtimeSource, /this\.ctx\.get\("agentLoop"\)/u);

  const applicationServiceSource = await readFile(
    join(repositoryRoot, "src/apps/service.ts"),
    "utf8",
  );
  assert.match(applicationServiceSource, /this\.ctx\.agents\.open/u);
  assert.doesNotMatch(applicationServiceSource, /this\.ctx\.contextEngine\.open/u);
  assert.doesNotMatch(applicationServiceSource, /this\.ctx\.compaction\.open/u);
  assert.doesNotMatch(applicationServiceSource, /readonly reservedOutputTokens/u);
  assert.doesNotMatch(applicationServiceSource, /readonly keepRecentTokens/u);
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
