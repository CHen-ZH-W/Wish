import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import LocalFilesystem, { LocalFilesystemBackend } from "../dist/filesystem/providers/local.js";
import LocalSearch from "../dist/filesystem/search/providers/local.js";
import HostShell from "../dist/shell/providers/host.js";
import NativeShell from "../dist/shell/providers/linux-native.js";
import BlobArtifacts from "../dist/tools/results/artifacts/providers/blob.js";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { installPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";

for (const [name, plugin, service, methods, operation] of [
  ["filesystem", LocalFilesystem, "filesystem", ["preflight", "resolve", "stat", "readFile", "writeFile"], "writeFile"],
  ["search", LocalSearch, "filesystemSearch", ["search"], "search"],
  ["host-shell", HostShell, "shell", ["preflight", "resolve", "run"], "run"],
  ["native-shell", NativeShell, "shell", ["preflight", "resolve", "run"], "run"],
]) test(`${name} drains its accepted backend operation and fences every old entrypoint`, async () => {
  const root = new Context(), started = Promise.withResolvers(), finish = Promise.withResolvers();
  try {
    await root.plugin(Loader);
    const inspection = installPluginInspection(root), lifecycle = installPluginLifecycle(root, inspection);
    if (service !== "filesystem") root.provide("filesystem", new LocalFilesystemBackend());
    root.loader.builtins.sample = plugin;
    await root.loader.create({ id: "sample", name: "cordis:sample" });
    const old = root.get(service);
    // Control backend settlement while exercising the actual Cordis Provider entrypoint.
    old.backend[operation] = async () => { started.resolve(); await finish.promise; return "completed"; };
    const work = old[operation]({}); await started.promise;
    const selection = { instanceId: inspection.inspect().instanceId, entryIds: ["sample"] };
    const status = await lifecycle.collect(selection);
    assert.equal(status.owners[0].status.disposition, "drain");
    const prepared = root.pluginLifecycle.prepareStop(status, selection);
    for (const method of methods) await assert.rejects(old[method]({}), /_closed/);
    let closed = false;
    const closing = prepared.guards[0].close().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    finish.resolve(); assert.equal(await work, "completed"); await closing;
    const entry = root.loader.resolve("sample");
    await entry.update({ disabled: true });
    await entry.update({ disabled: false });
    assert.notEqual(root.get(service), old);
    for (const method of methods) await assert.rejects(old[method]({}), /_closed/);
  } finally { finish.resolve(); await root.fiber.dispose(); }
});

test("output artifacts finish an admitted Blob write before releasing their Storage lease", async () => {
  const root = new Context(), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let released = false;
  try {
    root.provide("storageBackend", { acquire() { return {
      id: "file", get released() { return released; }, release() { released = true; },
      resolve() { return { async put({ namespace, value }) {
        entered.resolve(); await finish.promise; assert.equal(released, false);
        return { namespace, locator: "record", sha256: "a".repeat(64), size: value.length };
      } }; },
    }; } });
    const fiber = await root.plugin(BlobArtifacts);
    const old = root.toolOutputArtifacts;
    const writing = old.put({ sessionId: "session", runId: "run", userTurnId: "turn", stepId: "step",
      toolCallId: "call", toolName: "bash", mediaType: "text/plain", value: new TextEncoder().encode("output") });
    await entered.promise;
    const closing = fiber.dispose();
    await Promise.resolve(); assert.equal(released, false);
    await assert.rejects(old.put({}), /tool_output_artifacts_closed/);
    finish.resolve(); assert.equal((await writing).kind, "blob"); await closing;
    assert.equal(released, true);
    await assert.rejects(old.get({}), /tool_output_artifacts_closed/);
  } finally { finish.resolve(); await root.fiber.dispose(); }
});
