import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import { bootstrap } from "../dist/boot/bootstrap.js";
import * as BasicToolPlugins from "../dist/tools/plugins.js";
import Tools from "../dist/tools/service.js";

const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });
const basicNames = ["read", "write", "edit", "grep", "bash"];
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("Tool plugins follow the tools service and own their registrations", async () => {
  const root = new Context();
  const read = root.plugin(BasicToolPlugins.Read);
  assert.equal(read.state, fiberState.pending);

  let toolsProvider;
  const fibers = [read];
  let registry;
  try {
    toolsProvider = await root.plugin(Tools);
    registry = root.tools.registry;
    await read.await();
    for (const plugin of [
      BasicToolPlugins.Write,
      BasicToolPlugins.Edit,
      BasicToolPlugins.Grep,
      BasicToolPlugins.Bash,
    ]) {
      fibers.push(await root.plugin(plugin));
    }

    assert.deepEqual(toolNames(registry), basicNames);
    assert.deepEqual(read.getEffects().map((effect) => effect.label), [
      'tools.register("read")',
    ]);

    const bash = fibers.at(-1);
    await bash.dispose();
    assert.deepEqual(toolNames(registry), basicNames.slice(0, -1));
    assert.deepEqual(bash.getEffects(), []);

    fibers[fibers.length - 1] = await root.plugin(BasicToolPlugins.Bash);
    assert.deepEqual(toolNames(registry), basicNames);

    await toolsProvider.dispose();
    assert.equal(root.get("tools"), undefined);
    assert.deepEqual(toolNames(registry), []);
    for (const fiber of fibers) {
      assert.equal(fiber.state, fiberState.pending);
      assert.deepEqual(fiber.getEffects(), []);
    }
  } finally {
    await root.fiber.dispose();
  }

  for (const fiber of fibers) {
    assert.equal(fiber.state, fiberState.disposed);
  }
});

test("the built-in Loader can disable and restore one Tool by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-loader-tools-"));
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
    assert.deepEqual(
      toolNames(booted.surfaceContext.get("tools").registry),
      basicNames,
    );

    const id = "include:tool-bash";
    const entry = booted.context.loader.resolve(id);
    await booted.context.loader.update(id, { disabled: true });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(entry.disabled, true);
    assert.deepEqual(
      toolNames(booted.surfaceContext.get("tools").registry),
      basicNames.slice(0, -1),
    );

    await booted.context.loader.update(id, { disabled: false });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(entry.disabled, false);
    assert.deepEqual(
      toolNames(booted.surfaceContext.get("tools").registry),
      basicNames,
    );
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(booted?.context.get("tools"), undefined);
  assert.deepEqual(booted?.context.fiber.getEffects(), []);
});

function toolNames(registry) {
  return registry.list().map((tool) => tool.name);
}
