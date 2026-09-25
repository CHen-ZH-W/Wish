import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

for (const [id, key, save, read] of [
  ["plan-storage", "plan", service => service.enter({ sessionId: "fixture", goal: "Keep durable plan" }), service => service.get({ sessionId: "fixture" })],
  ["tasks-storage", "tasks", service => service.replace("fixture", [{ id: "one", title: "Verify", dependencies: [], execution: { role: "reviewer", readOnly: true, timeoutMs: 1000 } }], 0), service => service.get("fixture")],
  ["coordinator-storage", "coordinator", service => service.enter({ runId: "fixture", sessionId: "fixture", goal: "Coordinate verification" }), service => service.get({ runId: "fixture" })],
]) test(`${key} restores its own durable state after a managed dependency-closure replacement`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-domain-")); let booted;
  try {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const ctx = booted.surfaceContext, previous = ctx.get(key), state = await save(previous);
    const change = async preference => {
      const snapshot = booted.pluginManagement.snapshot();
      const selection = { instanceId: snapshot.inspection.instanceId, entryIds: [`include:${id}`] };
      const before = await booted.context.pluginLifecycle.collect(selection);
      const result = await booted.pluginManagement.change({ requestId: preference, revision: snapshot.revision, preference, selection });
      assert.equal(result.status, "succeeded", JSON.stringify({ result, reports: before.reports }));
    };
    await change("disabled"); assert.equal(ctx.get(key), undefined);
    await assert.rejects(read(previous), /closed/);
    await change("enabled"); assert.notEqual(ctx.get(key), previous);
    assert.deepEqual(await read(ctx.get(key)), state);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
