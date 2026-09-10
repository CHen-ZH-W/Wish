import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context, Service } from "@deepseek-ai/cordis";

import { bootstrap } from "../dist/boot/bootstrap.js";
import Runtime, {
  Config as RuntimeConfig,
} from "../dist/core/runtime/service.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });
let runSequence = 0;

class StubAgentLoop extends Service {
  constructor(ctx) {
    super(ctx, "agentLoop");
  }

  open() {
    return Object.freeze({
      sessions: Object.freeze({ manager: {} }),
      models: Object.freeze({ configuredModel: {} }),
      stepPipeline: {
        async execute({ snapshot }) {
          return {
            status: "continue",
            reason: "fixture_continue",
            memory: snapshot.step.ordinal,
          };
        },
      },
    });
  }
}

test("Runtime owns Core construction and follows AgentLoop generations", async () => {
  const root = new Context();
  const generations = [];
  let disposals = 0;
  const consumer = root.plugin({
    inject: ["runEngine"],
    apply(ctx) {
      generations.push(ctx.runEngine);
      ctx.effect(() => () => {
        disposals += 1;
      }, "runtime consumer");
    },
  });
  const runtimeProvider = root.plugin(Runtime, {
    maxSteps: 2,
    generationDrainTimeoutMs: 1_000,
  });
  assert.equal(runtimeProvider.state, fiberState.pending);
  assert.equal(consumer.state, fiberState.pending);

  let agentLoopProvider;
  try {
    agentLoopProvider = await root.plugin(StubAgentLoop);
    await consumer.await();
    assert.equal(runtimeProvider.state, fiberState.active);
    assert.equal(consumer.state, fiberState.active);
    assert.equal(root.runEngine.maxSteps, 2);
    assert.equal(root.runEngine.generationDrainTimeoutMs, 1_000);
    assert.equal(await executedSteps(root.runEngine), 2);

    await agentLoopProvider.dispose();
    assert.equal(root.get("agentLoop"), undefined);
    assert.equal(root.get("runEngine"), undefined);
    assert.equal(consumer.state, fiberState.pending);
    assert.equal(disposals, 1);
    assert.deepEqual(consumer.getEffects(), []);

    agentLoopProvider = await root.plugin(StubAgentLoop);
    await consumer.await();
    assert.equal(root.runEngine.maxSteps, 2);
    assert.equal(consumer.state, fiberState.active);
    assert.equal(generations.length, 2);

    const first = root.runEngine;
    await runtimeProvider.update({
      maxSteps: 3,
      generationDrainTimeoutMs: 2_000,
    });
    await consumer.await();
    assert.notEqual(root.runEngine, first);
    assert.equal(root.runEngine.maxSteps, 3);
    assert.equal(root.runEngine.generationDrainTimeoutMs, 2_000);
    assert.equal(await executedSteps(root.runEngine), 3);
    assert.equal(disposals, 2);
    assert.equal(generations.length, 3);

    assert.throws(
      () => runtimeProvider.update({ maxSteps: 0 }),
      /expected number >= 1/u,
    );
    assert.equal(root.runEngine.maxSteps, 3);
    assert.equal(consumer.state, fiberState.active);
  } finally {
    await root.fiber.dispose();
  }

  assert.equal(consumer.state, fiberState.disposed);
  assert.deepEqual(consumer.getEffects(), []);
  assert.equal(disposals, 3);
});

test("Loader updates and disables Runtime by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-loader-runtime-"));
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

    const id = "include:runtime";
    const entry = booted.context.loader.resolve(id);
    const first = booted.surfaceContext.get("runEngine");
    await booted.context.loader.update(id, { config: { maxSteps: 3 } });
    await booted.context.loader.resolve("include:application").fiber.await();
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.notEqual(booted.surfaceContext.get("runEngine"), first);
    assert.equal(booted.surfaceContext.get("runEngine").maxSteps, 3);
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );

    await assert.rejects(
      booted.context.loader.update(id, { config: { maxSteps: 0 } }),
      /expected number >= 1/u,
    );
    assert.equal(booted.surfaceContext.get("runEngine").maxSteps, 3);

    await booted.context.loader.update(id, { disabled: true });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(entry.disabled, true);
    assert.equal(booted.surfaceContext.get("runEngine"), undefined);
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
    assert.equal(booted.surfaceContext.get("runEngine").maxSteps, 3);
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(booted?.context.get("runEngine"), undefined);
  assert.deepEqual(booted?.context.fiber.getEffects(), []);
});

test("Runtime schema and source keep Application and Core algorithms narrow", async () => {
  assert.deepEqual(RuntimeConfig({
    maxSteps: 2,
    generationDrainTimeoutMs: 1_000,
  }), {
    maxSteps: 2,
    generationDrainTimeoutMs: 1_000,
  });
  assert.throws(
    () => RuntimeConfig({ maxSteps: 0 }),
    /expected number >= 1/u,
  );
  assert.throws(
    () => RuntimeConfig({ generationDrainTimeoutMs: 0 }),
    /expected number >= 1/u,
  );

  const [serviceSource, agentServiceSource, facadeSource, applicationSource, coreSource, profile] =
    await Promise.all([
      readFile(join(repositoryRoot, "src/core/runtime/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/core/agent/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/application.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/core/runtime/runtime.ts"), "utf8"),
      readFile(join(repositoryRoot, "config/cordis.yml"), "utf8"),
    ]);

  assert.match(serviceSource, /new CoreRuntime/u);
  assert.match(serviceSource, /new RunGeneration/u);
  assert.match(serviceSource, /this\.ctx\.agentLoop\.open/u);
  assert.match(serviceSource, /super\(ctx, "runEngine"\)/u);
  assert.doesNotMatch(facadeSource, /new Runtime/u);
  assert.doesNotMatch(facadeSource, /options\.runtime/u);
  assert.doesNotMatch(facadeSource, /new Agent/u);
  assert.match(agentServiceSource, /new CoreAgent/u);
  assert.match(agentServiceSource, /this\.ctx\.runEngine\.open/u);
  assert.match(applicationSource, /this\.ctx\.agents\.open/u);
  assert.doesNotMatch(applicationSource, /readonly maxSteps/u);
  assert.doesNotMatch(coreSource, /@deepseek-ai\/cordis/u);
  assert.match(
    profile,
    /id: runtime\s+name: 'cordis:runtime'\s+config:\s+maxSteps:/u,
  );
  assert.doesNotMatch(
    profile,
    /id: application\s+name: 'cordis:application'[\s\S]*?maxSteps:/u,
  );
});

async function executedSteps(service) {
  const resources = service.open({});
  const handle = resources.runtime.startRun(
    { id: "fixture-agent", configuration: { agentInstructions: [] } },
    { scope: `scope-${++runSequence}`, payload: { text: "continue" } },
  );
  const completion = await handle.completion;
  assert.equal(completion.status, "failed");
  assert.equal(completion.error.code, "max_steps_exceeded");
  return completion.snapshot.userTurns[0].steps.length;
}
