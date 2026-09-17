import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Context, Logger } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import { HOST_PLUGIN_CATALOG, MODEL_TOOL_PLUGIN_CATALOG, installWishPluginCatalog } from "../dist/boot/plugin-catalog.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

test("plugin catalogs contain entrypoint data, never eagerly imported business implementations", async () => {
  const source = await readFile(join(repository, "src/boot/plugin-catalog.ts"), "utf8");
  assert.doesNotMatch(source, /import\s+(?!type\b)[^;]*from\s+["']\.\./u);
  for (const specifier of Object.values({ ...HOST_PLUGIN_CATALOG, ...MODEL_TOOL_PLUGIN_CATALOG })) {
    assert.equal(typeof specifier, "string");
    const url = specifier.startsWith(".") ? new URL(specifier, new URL("../dist/boot/plugin-catalog.js", import.meta.url)) : import.meta.resolve(specifier);
    const module = await import(url);
    const plugin = module.default ?? module;
    assert.ok(typeof plugin === "function" || typeof plugin.apply === "function", specifier);
  }
});

test("catalog aliases belong to the Root effect and explicit embedding overrides remain supported", async () => {
  const root = new Context();
  let activated = false;
  try {
    await root.plugin(Loader);
    installWishPluginCatalog(root);
    assert.equal(import.meta.resolve("cordis:read"), new URL("../dist/filesystem/consumers/model-tools/read-entry.js", import.meta.url).href);
    root.loader.builtins.read = { apply() { activated = true; } };
    await root.loader.create({ id: "override", name: "cordis:read" });
    await root.loader.await();
    assert.equal(activated, true);
  } finally {
    await root.fiber.dispose();
  }
  assert.equal(import.meta.resolve("cordis:read"), "cordis:read");
});

test("native HMR replaces a shipped read Tool through its stable Cordis alias without restarting its registry", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-module-reload-"));
  const root = new Context();
  const logs = [];
  root.logger.exporter({ levels: { default: 3 }, export: message => logs.push(Logger.format({}, message)) });
  try {
    // Mutate only an isolated copy of the actual built business implementation.
    await cp(join(repository, "dist"), join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    const catalog = await import(pathToFileURL(join(directory, "dist/boot/plugin-catalog.js")).href);
    root.baseUrl = pathToFileURL(directory + "/").href;
    await root.plugin(Loader);
    catalog.installWishPluginCatalog(root);
    await root.plugin(Timer);
    root.provide("filesystem", {});
    const registryId = await root.loader.create({ id: "tools", name: "cordis:tools" });
    const readId = await root.loader.create({ id: "read", name: "cordis:read" });
    await root.loader.await();
    const registryFiber = root.loader.resolve(registryId).fiber;
    const registry = root.tools.registry;
    const original = root.loader.resolve(readId).fiber;
    const originalDescription = registry.describe("read").description;
    const pid = process.pid;
    const hmr = await root.plugin(Hmr, { root: ["dist"], ignored: ["**/node_modules"], debounce: 25 });
    const filename = join(directory, "dist/filesystem/consumers/model-tools/read.js");
    const code = await readFile(filename, "utf8");
    assert.ok(code.includes("Read a UTF-8 text file"));
    await change(root, filename, code.replace("Read a UTF-8 text file", "Read version two UTF-8 text"));
    assert.equal(process.pid, pid);
    assert.equal(root.loader.resolve(registryId).fiber, registryFiber);
    assert.equal(root.tools.registry, registry);
    assert.equal(original.state, 4);
    assert.deepEqual(original.getEffects(), []);
    assert.notEqual(root.loader.resolve(readId).fiber, original);
    assert.match(registry.describe("read").description, /Read version two/);
    assert.equal(root.loader.resolve(readId).options.name, "cordis:read");
    assert.equal(registry.list().filter(tool => tool.name === "read").length, 1);

    const active = root.loader.resolve(readId).fiber;
    await change(root, filename, "this is invalid JavaScript @", false);
    assert.equal(root.loader.resolve(readId).fiber, active, "failed import leaves the old plugin running");
    assert.match(registry.describe("read").description, /Read version two/);
    await change(root, filename, code);
    assert.equal(registry.describe("read").description, originalDescription);

    await root.loader.resolve(readId).update({ disabled: true }, false, true);
    assert.equal(registry.has("read"), false);
    await change(root, filename, code.replace("Read a UTF-8 text file", "Read version three UTF-8 text"));
    assert.equal(root.loader.resolve(readId).disabled, true);
    assert.equal(registry.has("read"), false, "code changes never enable a disabled plugin");
    await root.loader.resolve(readId).update({ disabled: false }, false, true);
    await root.loader.await();
    assert.match(registry.describe("read").description, /Read version three/);
    await hmr.dispose();
  } catch (error) {
    throw new Error(`${error.message}\nCordis log:\n${logs.join("\n")}`, { cause: error });
  } finally {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shipped bootstrap and profile reload a real Tool without replacing the Host or unrelated application services", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-bootstrap-module-reload-"));
  let booted;
  const reloaded = [];
  try {
    await cp(join(repository, "dist"), join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")).href);
    booted = await bootstrap({
      surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "1", WISH_DATA_DIR: join(directory, "data") },
    });
    assert.equal(await booted.completion, 0);
    const root = booted.context;
    root.on("hmr/reload", batch => reloaded.push(...Array.from(batch.values(), item => item.filename)));
    const unrelated = new Map([...root.loader.entries()]
      .filter(entry => entry.id !== "include:tool-read")
      .map(entry => [entry.id, entry.fiber]));
    const read = root.loader.resolve("include:tool-read");
    const original = read.fiber;
    const registry = root.loader.resolve("include:tools").ctx.get("tools").registry;
    const pid = process.pid;
    const filename = join(directory, "dist/filesystem/consumers/model-tools/read.js");

    // Product entrypoints statically depend on bootstrap. Its dependency graph
    // must not turn the Tool into an external that requires a process restart.
    const seen = new Set();
    const visit = async job => {
      if (!job || seen.has(job.url)) return;
      seen.add(job.url);
      if (job.url.startsWith("node:") || job.url.includes("/node_modules/")) return;
      await Promise.all(Array.from(await job.linked, visit));
    };
    await visit(root.loader.internal.loadCache.get(pathToFileURL(join(directory, "dist/boot/bootstrap.js")).href));
    assert.equal(seen.has(pathToFileURL(filename).href), false);
    const code = await readFile(filename, "utf8");
    const invalidCall = { id: "invalid-path", name: "read", argumentsJson: '{"path":""}' };
    assert.match(JSON.stringify(registry.parseCall(invalidCall)), /Read path must be a non-empty string/);
    await change(root, filename, code
      .replace("Read a UTF-8 text file", "Read bootstrap version two UTF-8 text")
      .replace("Read path must be a non-empty string", "Read bootstrap version two requires a path"));
    assert.match(registry.describe("read").description, /Read bootstrap version two/);
    assert.match(JSON.stringify(registry.parseCall(invalidCall)), /Read bootstrap version two requires a path/);
    assert.equal(process.pid, pid);
    for (const [id, fiber] of unrelated) assert.ok(root.loader.resolve(id).fiber === fiber, `${id} was replaced`);
    assert.equal(original.state, 4);
    assert.deepEqual(original.getEffects(), []);
    assert.notEqual(read.fiber, original);
    assert.equal(read.options.name, "cordis:read");
  } catch (error) {
    throw new Error(`${error.message}\nReloaded:\n${reloaded.join("\n")}\nCoordination: ${JSON.stringify(booted?.codeReload.snapshot())}`, { cause: error });
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

async function change(root, filename, code, succeeds = true) {
  // These are distinct edits, not one editor-save burst. Chokidar coalesces
  // rapid writes even after a previous HMR reload has already completed.
  await new Promise(resolve => setTimeout(resolve, 120));
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error("native HMR did not settle")); }, 5000);
    const done = () => { clearTimeout(timer); remove(); resolve(); };
    const remove = succeeds
      ? root.on("hmr/reload", done)
      : root.logger.exporter({ levels: { default: 2 }, export: message => {
        if (message.type === "warn" && message.args.some(arg => arg instanceof SyntaxError)) done();
      } });
  });
  await writeFile(filename, code);
  await completed;
  await root.loader.await();
}
