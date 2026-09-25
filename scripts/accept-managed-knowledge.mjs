import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

test("the default Memory dependency closure stops, rejects old calls, and restores durable proposals once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-memory-")); let booted;
  try {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory,
        WISH_MEMORY_CURATION_ENABLED: "1" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const ctx = booted.surfaceContext, memory = ctx.get("memory");
    const proposal = { operationId: "one", targetId: "test", expectedDocumentVersion: 0,
      actor: { kind: "agent", id: "wish" }, reason: "reusable", title: "Tests", content: "Run focused tests",
      appliesTo: "Wish", keywords: ["test"], evidence: [{ kind: "operator", id: "review", revision: "1", digest: "a".repeat(64) }] };
    const saved = await memory.propose(proposal);
    const before = booted.pluginManagement.snapshot();
    const off = await booted.pluginManagement.change({ requestId: "off", revision: before.revision,
      preference: "disabled", selection: { instanceId: before.inspection.instanceId, entryIds: ["include:memory-storage"] } });
    assert.equal(off.status, "succeeded", JSON.stringify(off));
    assert.equal(ctx.get("memory"), undefined);
    assert.equal(ctx.get("tools").registry.list().some(tool => tool.name.startsWith("memory_")), false);
    await assert.rejects(memory.state(), /memory_closed/);
    await assert.rejects(memory.propose(proposal), /memory_closed/);
    const after = booted.pluginManagement.snapshot();
    const on = await booted.pluginManagement.change({ requestId: "on", revision: after.revision,
      preference: "enabled", selection: { instanceId: after.inspection.instanceId, entryIds: ["include:memory-storage"] } });
    assert.equal(on.status, "succeeded", JSON.stringify(on));
    const restored = ctx.get("memory");
    assert.notEqual(restored, memory);
    assert.equal((await restored.state()).candidates.length, 1);
    assert.equal((await restored.propose(proposal)).id, saved.id);
    for (const name of ["memory_search", "memory_read", "memory_write"]) {
      assert.equal(ctx.get("tools").registry.list().filter(tool => tool.name === name).length, 1);
    }
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
