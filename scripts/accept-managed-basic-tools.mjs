import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Tools from "../dist/tools/service.js";
import Write from "../dist/filesystem/consumers/model-tools/write-entry.js";
import Read from "../dist/filesystem/consumers/model-tools/read-entry.js";
import Edit from "../dist/filesystem/consumers/model-tools/edit-entry.js";
import { Grep } from "../dist/filesystem/search/consumers/plugin.js";
import { Bash } from "../dist/shell/consumers/plugin.js";
import { LocalFilesystemBackend } from "../dist/filesystem/providers/local.js";
import { ToolExecutor } from "../dist/core/tools/executor.js";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { installPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

for (const [name, plugin] of [["read", Read], ["write", Write], ["edit", Edit], ["grep", Grep], ["bash", Bash]]) {
  test(`${name} stops, reloads, and follows a required Provider without duplicate Tools or live old references`, async () => {
    const root = new Context();
    try {
      await root.plugin(Loader);
      const inspection = installPluginInspection(root), lifecycle = installPluginLifecycle(root, inspection);
      const provider = { apply(ctx) { for (const key of ["filesystem", "filesystemSearch", "shell", "toolOutputArtifacts"]) ctx.provide(key, {}); } };
      let dependency = await root.plugin(provider);
      await root.plugin(Tools);
      const registry = root.tools.registry, register = registry.register.bind(registry); let current;
      registry.register = definition => { current = definition; return register(definition); };
      root.loader.builtins.sample = plugin;
      await root.loader.create({ id: "sample", name: "cordis:sample" });
      const selection = { instanceId: inspection.inspect().instanceId, entryIds: ["sample"] };
      const before = await lifecycle.collect(selection);
      assert.equal(before.owners[0].status.disposition, "direct");
      const old = current, prepared = root.pluginLifecycle.prepareStop(before, selection);
      await assert.rejects(old.execute({}, {}, {}), /_closed/);
      await assert.rejects(old.resolveCapabilities({}, {}), /_closed/);
      for (const guard of prepared.guards) await guard.close();
      const entry = root.loader.resolve("sample");
      await entry.update({ disabled: true });
      assert.equal(registry.has(name), false);
      await entry.update({ disabled: false });
      assert.equal(registry.list().filter(tool => tool.name === name).length, 1);
      assert.notEqual(current, old);
      const second = current;
      await dependency.dispose();
      assert.equal(registry.has(name), false);
      assert.equal(entry.fiber.state, 0);
      await assert.rejects(second.execute({}, {}, {}), /_closed/);
      dependency = await root.plugin(provider); await root.loader.await();
      assert.equal(registry.list().filter(tool => tool.name === name).length, 1);
      await assert.rejects(old.execute({}, {}, {}), /_closed/);
    } finally { await root.fiber.dispose(); }
  });
}

test("managed Write waits for the accepted file mutation and rejects retained calls before replacement", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-write-"));
  const root = new Context(), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  try {
    await root.plugin(Loader);
    const inspection = installPluginInspection(root), lifecycle = installPluginLifecycle(root, inspection);
    const backend = new LocalFilesystemBackend();
    root.provide("filesystem", new Proxy(backend, { get(target, key) {
      if (key === "writeFile") return async input => { entered.resolve(); await finish.promise; return target.writeFile(input); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }));
    await root.plugin(Tools);
    const registry = root.tools.registry, register = registry.register.bind(registry); let retained;
    registry.register = definition => { retained = definition; return register(definition); };
    root.loader.builtins.write = Write;
    await root.loader.create({ id: "write", name: "cordis:write" });
    const parsed = registry.parseCall({ id: "one", name: "write", argumentsJson: JSON.stringify({ path: "result.txt", content: "accepted exactly once" }) });
    assert.equal(parsed.ok, true);
    const executor = new ToolExecutor({ registry, authorization: {
      authorize() { return { status: "allowed", policyVersion: "policy-1" }; },
      revalidate() { return { status: "valid", policyVersion: "policy-1" }; },
    } });
    const work = executor.execute({ call: parsed.call, context: basicToolContext(directory),
      scope: { runId: "run", userTurnId: "turn", stepId: "step" },
      snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
    });
    await entered.promise;
    const selection = { instanceId: inspection.inspect().instanceId, entryIds: ["write"] };
    const before = await lifecycle.collect(selection);
    assert.equal(before.owners[0].status.disposition, "drain");
    const prepared = root.pluginLifecycle.prepareStop(before, selection);
    const old = retained;
    await assert.rejects(old.execute({}, {}, {}), /write_consumer_closed/);
    let closed = false;
    const closing = prepared.guards[0].close().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    finish.resolve();
    const result = await work; assert.equal(result.ok, true, JSON.stringify(result));
    await closing;
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "accepted exactly once");
    const entry = root.loader.resolve("write");
    await entry.update({ disabled: true });
    assert.equal(registry.has("write"), false);
    await entry.update({ disabled: false });
    assert.equal(registry.list().filter(item => item.name === "write").length, 1);
    await assert.rejects(old.resolveCapabilities({}, {}), /write_consumer_closed/);
    assert.notEqual(retained, old);
  } finally { finish.resolve(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
