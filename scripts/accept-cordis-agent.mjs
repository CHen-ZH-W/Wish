import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context, Service } from "@deepseek-ai/cordis";

import Agents, {
  Config as AgentsConfig,
} from "../dist/core/agent/service.js";
import { bootstrap } from "../dist/boot/bootstrap.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });

class StubRuntime extends Service {
  constructor(ctx) {
    super(ctx, "runEngine");
  }

  open(input) {
    const generation = {
      id: "stub-generation",
      state: "accepting",
      startRun(definition, runInput) {
        return Object.freeze({
          agentId: definition.id,
          runId: runInput.runId ?? "run-1",
          initialUserTurnId: "turn-1",
          scope: runInput.scope,
          completion: Promise.resolve({ status: "completed" }),
        });
      },
      control(agentId, runId, control) {
        return Object.freeze({
          accepted: true,
          kind: control.type,
          agentId,
          runId,
        });
      },
      async *observe() {},
      snapshot() {
        return { id: this.id, state: this.state, activeRuns: [] };
      },
      retire() {
        this.state = "retired";
        return Promise.resolve();
      },
    };
    return Object.freeze({
      sessions: Object.freeze({ manager: {} }),
      models: Object.freeze({ configuredModel: {} }),
      runtime: generation,
      generation,
      input,
    });
  }
}

test("Agents owns definitions and follows the Runtime generation", async () => {
  const root = new Context();
  const generations = [];
  let disposals = 0;
  const consumer = root.plugin({
    inject: ["agents"],
    apply(ctx) {
      generations.push(ctx.agents);
      ctx.effect(() => () => {
        disposals += 1;
      }, "agents consumer");
    },
  });
  const provider = root.plugin(Agents, {
    agentId: "first-agent",
    agentInstructions: "Follow the first instructions.",
  });
  assert.equal(provider.state, fiberState.pending);
  assert.equal(consumer.state, fiberState.pending);

  let runtimeProvider;
  try {
    runtimeProvider = await root.plugin(StubRuntime);
    await consumer.await();
    assert.equal(provider.state, fiberState.active);
    assert.equal(root.agents.definition.id, "first-agent");
    assert.equal(
      root.agents.agentInstructions[0].content,
      "Follow the first instructions.",
    );

    const resources = root.agents.open({ dataDirectory: "state" });
    assert.equal(resources.input.agentId, "first-agent");
    assert.equal(
      resources.input.agentInstructions[0].content,
      "Follow the first instructions.",
    );
    assert.deepEqual(resources.agent.definition, root.agents.definition);
    assert.equal(resources.generation.id, "stub-generation");
    const handle = resources.agent.startRun({
      scope: "session-1",
      payload: { text: "hello" },
    });
    assert.equal(handle.agentId, "first-agent");

    await runtimeProvider.dispose();
    assert.equal(root.get("runEngine"), undefined);
    assert.equal(root.get("agents"), undefined);
    assert.equal(consumer.state, fiberState.pending);
    assert.equal(disposals, 1);
    assert.deepEqual(consumer.getEffects(), []);

    runtimeProvider = await root.plugin(StubRuntime);
    await consumer.await();
    assert.equal(generations.length, 2);

    const first = root.agents;
    await provider.update({
      agentId: "second-agent",
      agentInstructions: "Follow the second instructions.",
    });
    await consumer.await();
    assert.notEqual(root.agents, first);
    assert.equal(root.agents.agentId, "second-agent");
    assert.equal(disposals, 2);
    assert.equal(generations.length, 3);

    assert.throws(
      () => provider.update({ agentId: 42 }),
      /expected string/u,
    );
    assert.equal(root.agents.agentId, "second-agent");

    await provider.dispose();
    assert.equal(root.get("agents"), undefined);
    assert.equal(consumer.state, fiberState.pending);
    assert.equal(disposals, 3);
    assert.deepEqual(consumer.getEffects(), []);
  } finally {
    await root.fiber.dispose();
  }
  assert.equal(consumer.state, fiberState.disposed);
});

test("Loader updates and disables Agents by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-loader-agents-"));
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

    const id = "include:agents";
    const entry = booted.context.loader.resolve(id);
    const first = booted.surfaceContext.get("agents");
    await booted.context.loader.update(id, {
      config: {
        agentId: "configured-agent",
        agentInstructions: "Use the configured generation.",
      },
    });
    await booted.context.loader.resolve("include:application").fiber.await();
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.notEqual(booted.surfaceContext.get("agents"), first);
    assert.equal(booted.surfaceContext.get("agents").agentId, "configured-agent");
    const configuration = await booted.surfaceContext
      .get("application")
      .resolve();
    assert.equal(configuration.agentId, "configured-agent");
    assert.equal(
      configuration.agentInstructions[0].content,
      "Use the configured generation.",
    );

    await assert.rejects(
      booted.context.loader.update(id, { config: { agentId: 42 } }),
      /expected string/u,
    );
    assert.equal(booted.surfaceContext.get("agents").agentId, "configured-agent");

    await booted.context.loader.update(id, { disabled: true });
    assert.equal(entry.disabled, true);
    assert.equal(booted.surfaceContext.get("agents"), undefined);
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
    assert.equal(booted.surfaceContext.get("agents").agentId, "configured-agent");
    assert.equal(
      booted.context.loader.resolve("include:application").fiber.state,
      fiberState.active,
    );
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(booted?.context.get("agents"), undefined);
  assert.deepEqual(booted?.context.fiber.getEffects(), []);
});

test("Agents owns construction while Core Agent remains framework-free", async () => {
  assert.deepEqual(AgentsConfig({ agentId: "wish" }), { agentId: "wish" });
  assert.throws(() => AgentsConfig({ agentId: 42 }), /expected string/u);

  const [service, core, facade, application, bootstrapSource, profile] =
    await Promise.all([
      readFile(join(repositoryRoot, "src/core/agent/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/core/agent/agent.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/application.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/boot/bootstrap.ts"), "utf8"),
      readFile(join(repositoryRoot, "config/cordis.yml"), "utf8"),
    ]);

  assert.match(service, /new CoreAgent/u);
  assert.match(service, /this\.ctx\.runEngine\.open/u);
  assert.match(service, /super\(ctx, "agents"\)/u);
  assert.doesNotMatch(core, /@deepseek-ai\/cordis/u);
  assert.doesNotMatch(facade, /new Agent/u);
  assert.doesNotMatch(facade, /options\.runtime/u);
  assert.match(application, /this\.ctx\.agents\.open/u);
  assert.doesNotMatch(application, /this\.ctx\.runEngine\.open/u);
  assert.match(bootstrapSource, /builtins\.agents = Agents/u);
  assert.match(profile, /id: agents\s+name: 'cordis:agents'/u);
  assert.ok(profile.indexOf("id: runtime") < profile.indexOf("id: agents"));
  assert.ok(profile.indexOf("id: agents") < profile.indexOf("id: application"));
});
