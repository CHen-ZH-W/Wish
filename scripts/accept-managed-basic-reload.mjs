import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = dirname(dirname(fileURLToPath(import.meta.url)));

for (const [name, file] of [
  ["read", "filesystem/consumers/model-tools/read-entry.js"],
  ["write", "filesystem/consumers/model-tools/write-entry.js"],
  ["edit", "filesystem/consumers/model-tools/edit-entry.js"],
  ["grep", "filesystem/search/consumers/plugin.js"],
  ["bash", "shell/consumers/plugin.js"],
]) test(`the real bootstrap reloads ${name} and keeps its successor fenced until the change commits`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), `wish-${name}-reload-`)); let booted;
  try {
    await cp(join(repository, "dist"), join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")));
    booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "1", WISH_DATA_DIR: join(directory, "data") } });
    assert.equal(await booted.completion, 0);
    const root = booted.context, entry = root.loader.resolve(`include:tool-${name}`), previous = entry.fiber;
    const stable = new Map(["include:runtime", "include:sessions", "include:tools", "include:application"].map(id => [id, root.loader.resolve(id).fiber]));
    const registry = root.loader.resolve("include:tools").ctx.get("tools").registry;
    const before = registry.describe(name);
    const filename = join(directory, "dist", file), source = await readFile(filename, "utf8");
    if (name === "read") {
      for (const file of ["boot/bootstrap.js", "composition/runtime-service.js", "filesystem/consumers/model-tools/read-entry.js"]) {
        const unchanged = join(directory, "dist", file);
        await writeFile(unchanged, await readFile(unchanged));
      }
      await new Promise(resolve => setTimeout(resolve, 450));
      assert.equal(booted.codeReload.snapshot().phase, "idle", "unchanged compiler output must not request reload/restart");
      assert.equal(entry.fiber, previous);
    }
    assert.ok(source.includes(`"${name}_consumer"`));
    await writeFile(filename, source.replace(`"${name}_consumer"`, `"${name}_consumer_v2"`));
    const deadline = Date.now() + 8000;
    while (booted.codeReload.snapshot().phase !== "succeeded") {
      if (Date.now() > deadline) throw Error(JSON.stringify(booted.codeReload.snapshot()));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.notEqual(entry.fiber, previous);
    assert.equal(previous.state, 4);
    assert.deepEqual(previous.getEffects(), []);
    assert.deepEqual(registry.describe(name), before);
    assert.equal(registry.list().filter(tool => tool.name === name).length, 1);
    for (const [id, fiber] of stable) assert.equal(root.loader.resolve(id).fiber, fiber, id);
    const parsed = registry.parseCall({ id: "invalid", name, argumentsJson: "{}" });
    assert.equal(parsed.ok, false);
    assert.doesNotMatch(JSON.stringify(parsed), /consumer_v2_closed/);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
