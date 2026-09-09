import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Context, Service } from "@deepseek-ai/cordis";
import Group from "@deepseek-ai/cordis-plugin-group";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import ConsoleExporter from "@deepseek-ai/cordis-plugin-logger-console";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import Schema from "@deepseek-ai/schemastery";

const require = createRequire(import.meta.url);

const pinnedPackages = Object.freeze({
  "@deepseek-ai/cordis": "4.0.2",
  "@deepseek-ai/cordis-plugin-loader": "1.0.3",
  "@deepseek-ai/cordis-plugin-include": "1.0.7",
  "@deepseek-ai/cordis-plugin-group": "1.0.2",
  "@deepseek-ai/cordis-plugin-hmr": "1.0.17",
  "@deepseek-ai/cordis-plugin-timer": "1.1.4",
  "@deepseek-ai/cordis-plugin-logger-console": "1.0.2",
  "@deepseek-ai/schemastery": "3.18.2",
  "node-addon-require-builtin": "0.1.4",
});

const fiberState = Object.freeze({
  pending: 0,
  active: 2,
  disposed: 4,
});

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major >= 24 || (major === 22 && minor >= 19);
  assert.equal(
    supported,
    true,
    `Cordis HMR baseline requires Node ^22.19.0 or >=24.0.0; received ${process.version}`,
  );
}

function waitForEvent(register, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for Cordis HMR")), timeoutMs);
    const dispose = register((value) => {
      clearTimeout(timeout);
      dispose();
      resolve(value);
    });
  });
}

function fixtureModule(label) {
  return `
import { Service } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";

export const Config = Schema.object({
  label: Schema.string().default("default"),
});

class ProbeService extends Service {
  constructor(ctx, value) {
    super(ctx, "wishT0Probe");
    this.value = value;
  }
}

export function apply(ctx, config) {
  new ProbeService(ctx, config.label);
  globalThis.__wishCordisT0Events.push("apply:${label}:" + config.label);
  ctx.effect(() => () => {
    globalThis.__wishCordisT0Events.push("dispose:${label}:" + config.label);
  });
}
`;
}

const consumerModule = `
export const inject = ["wishT0Probe"];

export function apply(ctx, config) {
  const value = ctx.wishT0Probe.value;
  globalThis.__wishCordisT0Events.push("consume:" + config.id + ":" + value);
  return () => {
    globalThis.__wishCordisT0Events.push("unconsume:" + config.id + ":" + value);
  };
}
`;

test("published Cordis packages are exactly pinned and ESM-loadable", () => {
  assertSupportedNode();

  for (const [name, version] of Object.entries(pinnedPackages)) {
    const manifest = require(`${name}/package.json`);
    assert.equal(manifest.version, version, `${name} must remain exactly pinned`);
  }

  assert.equal(typeof Context, "function");
  assert.equal(typeof Loader, "function");
  assert.equal(typeof Include, "function");
  assert.equal(typeof Group, "function");
  assert.equal(typeof Hmr, "function");
  assert.equal(typeof Timer, "function");
  assert.equal(typeof ConsoleExporter, "function");
  assert.equal(typeof Schema.object, "function");
});

test("service dependencies reactivate and effects unwind with their owner", async () => {
  class ProbeService extends Service {
    constructor(ctx, config) {
      super(ctx, "wishT0Probe");
      this.value = config.value;
    }
  }

  const activations = [];
  let disposals = 0;
  const consumer = Object.assign(
    (ctx) => {
      activations.push(ctx.wishT0Probe.value);
      return () => {
        disposals += 1;
      };
    },
    { inject: ["wishT0Probe"] },
  );

  const root = new Context();
  const consumerFiber = root.plugin(consumer);
  assert.deepEqual(activations, []);
  assert.equal(consumerFiber.state, fiberState.pending);

  const firstProvider = await root.plugin(ProbeService, { value: "first" });
  await consumerFiber.await();
  assert.deepEqual(activations, ["first"]);
  assert.equal(consumerFiber.state, fiberState.active);

  await firstProvider.dispose();
  assert.equal(disposals, 1);
  assert.equal(root.get("wishT0Probe"), undefined);
  assert.equal(consumerFiber.state, fiberState.pending);

  await root.plugin(ProbeService, { value: "second" });
  await consumerFiber.await();
  assert.deepEqual(activations, ["first", "second"]);
  assert.equal(consumerFiber.state, fiberState.active);

  await root.fiber.dispose();
  assert.equal(disposals, 2);
  assert.equal(consumerFiber.state, fiberState.disposed);
});

test("isolated contexts resolve independent implementations of one service", async () => {
  class ProbeService extends Service {
    constructor(ctx, config) {
      super(ctx, "wishT0Probe");
      this.value = config.value;
    }
  }

  const root = new Context();
  const left = root.isolate("wishT0Probe");
  const right = root.isolate("wishT0Probe");

  await left.plugin(ProbeService, { value: "left" });
  await right.plugin(ProbeService, { value: "right" });

  assert.equal(left.wishT0Probe.value, "left");
  assert.equal(right.wishT0Probe.value, "right");
  assert.equal(root.get("wishT0Probe"), undefined);

  await root.fiber.dispose();
});

test("Loader, Include, Group, schemas, and config isolation compose from YAML", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".wish-cordis-t0-config-"));
  const root = new Context();
  globalThis.__wishCordisT0Events = [];

  try {
    await writeFile(join(directory, "provider.mjs"), fixtureModule("provider"));
    await writeFile(join(directory, "consumer.mjs"), consumerModule);
    await writeFile(
      join(directory, "cordis.yml"),
      `- id: left\n  name: '@deepseek-ai/cordis-plugin-group'\n  group: true\n  isolate:\n    wishT0Probe: true\n  config:\n    - id: left-provider\n      name: './provider.mjs'\n      config:\n        label: left\n    - id: left-consumer\n      name: './consumer.mjs'\n      config:\n        id: left\n- id: right\n  name: '@deepseek-ai/cordis-plugin-group'\n  group: true\n  isolate:\n    wishT0Probe: true\n  config:\n    - id: right-provider\n      name: './provider.mjs'\n      config:\n        label: right\n    - id: right-consumer\n      name: './consumer.mjs'\n      config:\n        id: right\n`,
    );

    root.baseUrl = pathToFileURL(directory + sep).href;
    await root.plugin(Loader);
    const includeId = await root.loader.create({
      name: "@deepseek-ai/cordis-plugin-include",
      config: { path: "./cordis.yml" },
    });
    await root.loader.await();

    const consumes = globalThis.__wishCordisT0Events
      .filter((event) => event.startsWith("consume:"))
      .sort();
    assert.deepEqual(consumes, ["consume:left:left", "consume:right:right"]);

    await assert.rejects(
      root.loader.create({
        name: "./provider.mjs",
        config: { label: 42 },
      }),
      /expected string/,
    );

    const leftProviderId = `${includeId}:left-provider`;
    const leftConsumerId = `${includeId}:left-consumer`;
    const leftProvider = root.loader.resolve(leftProviderId);
    const leftConsumer = root.loader.resolve(leftConsumerId);
    const initialProviderFiber = leftProvider.fiber;

    await root.loader.update(leftProviderId, { config: { label: "left-updated" } });
    await root.loader.await();
    assert.equal(root.loader.resolve(leftProviderId), leftProvider);
    assert.equal(leftProvider.fiber, initialProviderFiber);
    assert.equal(leftProvider.fiber.config.label, "left-updated");
    assert.equal(leftConsumer.fiber.state, fiberState.active);
    assert.equal(globalThis.__wishCordisT0Events.includes("dispose:provider:left"), true);
    assert.equal(globalThis.__wishCordisT0Events.includes("consume:left:left-updated"), true);

    await assert.rejects(
      root.loader.update(leftProviderId, { config: { label: 42 } }),
      /expected string/,
    );
    assert.equal(root.loader.resolve(leftProviderId), leftProvider);
    assert.equal(leftProvider.fiber, initialProviderFiber);
    assert.equal(leftProvider.fiber.config.label, "left-updated");

    await root.loader.update(leftProviderId, { disabled: true });
    await root.loader.await();
    assert.equal(root.loader.resolve(leftProviderId), leftProvider);
    assert.equal(leftProvider.fiber, undefined);
    assert.deepEqual(initialProviderFiber.getEffects(), []);
    assert.equal(leftConsumer.fiber.state, fiberState.pending);
    assert.equal(leftConsumer.ctx.get("wishT0Probe"), undefined);
    assert.equal(globalThis.__wishCordisT0Events.includes("dispose:provider:left-updated"), true);
    const updatedActivationsBeforeEnable = globalThis.__wishCordisT0Events.filter(
      (event) => event === "consume:left:left-updated",
    ).length;

    await root.loader.update(leftProviderId, { disabled: false });
    await root.loader.await();
    assert.equal(root.loader.resolve(leftProviderId), leftProvider);
    assert.notEqual(leftProvider.fiber, initialProviderFiber);
    assert.equal(leftProvider.fiber.config.label, "left-updated");
    assert.equal(leftConsumer.fiber.state, fiberState.active);
    assert.ok(
      globalThis.__wishCordisT0Events.filter(
        (event) => event === "consume:left:left-updated",
      ).length > updatedActivationsBeforeEnable,
    );
  } finally {
    await root.fiber.dispose();
    delete globalThis.__wishCordisT0Events;
    await rm(directory, { recursive: true, force: true });
  }
});

test("HMR reloads a Loader-managed ESM plugin and disposes the old generation", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".wish-cordis-t0-hmr-"));
  const root = new Context();
  globalThis.__wishCordisT0Events = [];

  try {
    const pluginPath = join(directory, "hot-plugin.mjs");
    await writeFile(pluginPath, fixtureModule("v1"));

    root.baseUrl = pathToFileURL(directory + sep).href;
    await root.plugin(Loader);
    assert.notEqual(root.loader.internal, undefined, "HMR requires access to Node's internal ESM loader");
    await root.plugin(Timer);
    const hmrFiber = await root.plugin(Hmr, {
      base: ".",
      root: ["."],
      ignored: ["**/node_modules"],
      debounce: 25,
    });
    const pluginId = await root.loader.create({
      name: "./hot-plugin.mjs",
      config: { label: "configured" },
    });
    await root.loader.await();
    assert.deepEqual(globalThis.__wishCordisT0Events, ["apply:v1:configured"]);
    const firstGeneration = root.loader.resolve(pluginId).fiber;

    const reloaded = waitForEvent((resolve) => root.on("hmr/reload", resolve));
    await writeFile(pluginPath, fixtureModule("v2-reloaded"));
    await reloaded;
    await root.loader.await();

    assert.deepEqual(globalThis.__wishCordisT0Events, [
      "apply:v1:configured",
      "dispose:v1:configured",
      "apply:v2-reloaded:configured",
    ]);
    assert.equal(firstGeneration.state, fiberState.disposed);
    assert.deepEqual(firstGeneration.getEffects(), []);
    const secondGeneration = root.loader.resolve(pluginId).fiber;

    await hmrFiber.dispose();
    await root.loader.remove(pluginId);
    assert.equal(globalThis.__wishCordisT0Events.at(-1), "dispose:v2-reloaded:configured");
    assert.equal(secondGeneration.state, fiberState.disposed);
    assert.deepEqual(secondGeneration.getEffects(), []);
  } finally {
    await root.fiber.dispose();
    delete globalThis.__wishCordisT0Events;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the package manifest and lock record the Node baseline and exact Cordis versions", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );

  assert.equal(packageJson.engines.node, "^22.19.0 || >=24.0.0");
  assert.equal(packageLock.packages[""].engines.node, packageJson.engines.node);

  for (const [name, version] of Object.entries(pinnedPackages)) {
    assert.equal(packageJson.dependencies[name], version, `${name} manifest version must be exact`);
    assert.equal(
      packageLock.packages[""].dependencies[name],
      version,
      `${name} root lock requirement must be exact`,
    );
    assert.equal(
      packageLock.packages[`node_modules/${name}`].version,
      version,
      `${name} resolved lock version must be exact`,
    );
  }
});
