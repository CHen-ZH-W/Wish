import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import Application from "../dist/apps/service.js";
import { ApplicationFacade } from "../dist/apps/application.js";
import { SessionFeatureRegistry } from "../dist/apps/session-features.js";
import { FileSessionStore } from "../dist/sessions/providers/file/store.js";
import { SessionManager } from "../dist/sessions/session.js";
import { StorageHub } from "../dist/storage/index.js";
import FileStorage from "../dist/storage/providers/file/plugin.js";
import RuntimeHistory from "../dist/core/runtime/durability/providers/journal.js";
import { JournalRuntimeLifecycleAuthority } from "../dist/core/runtime/durability/journal.js";
import PromptHistory from "../dist/system-prompt/history/provider.js";
import ToolArchive from "../dist/tools/results/providers/blob.js";
import RuntimeFeature from "../dist/composition/runtime-session-feature.js";
import PromptFeature from "../dist/system-prompt/consumers/session-feature.js";
import ArchiveFeature from "../dist/tools/results/consumers/session-feature.js";
import { DomainSessionReasoningStore } from "../dist/models/session-reasoning.js";
import { DomainSessionPermissionProfileStore } from "../dist/permissions/session-profiles.js";

test("startup maintenance reclaims old deleted owners, preserves archived/unknown owners, and drains on unload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-session-retention-")), root = new Context();
  const store = new FileSessionStore({ rootDirectory: join(directory, "sessions") }), manager = new SessionManager(store);
  root.provide("launch", { cwd: directory, homeDirectory: directory, environment: {} });
  root.provide("sessions", { manager, dataDirectory: directory });
  root.provide("agents", { agentId: "wish" });
  root.provide("models", { async sweepDeletedSessions() {} });
  let archive;
  try {
    await root.plugin(StorageHub);
    await root.plugin(FileStorage, { id: "file", rootDirectory: join(directory, "storage") });
    const initial = root.storageBackend.acquire("file", { journal: { atomicBatch: true, durability: "fsync" } });
    const authority = new JournalRuntimeLifecycleAuthority({ backendId: "file", journal: initial.resolve("file", "journal").open({ namespace: "runtime/lifecycle" }) });
    try {
      const run = { runId: "run-protected", agentId: "wish", scope: "protected" };
      await authority.openRun(run);
      await authority.openUserTurn({ run, userTurn: { id: "protected-turn" } });
      await authority.openStep({ run, userTurn: { userTurnId: "protected-turn" }, step: { stepId: "protected-step" } });
      const input = { call: { id: "protected-call", name: "write", status: "ready", input: {} },
        descriptor: { recoveryPolicy: "needs-reconciliation" }, context: {},
        scope: { runId: run.runId, userTurnId: "protected-turn", stepId: "protected-step" }, snapshot: {} };
      await authority.prepare(input); await authority.markDispatched({ ...input, grant: { grantId: "protected-grant" } });
    } finally { await authority.close(); initial.release(); }
    await root.plugin(RuntimeHistory);
    await root.plugin(PromptHistory);
    await root.plugin(ToolArchive);
    archive = root.toolResultArchive.open();
    const snapshot = id => ({ sessionId: id, runId: `run-${id}`, userTurnId: `turn-${id}`, stepId: `step-${id}`,
      capturedAt: "2026-01-01T00:00:00.000Z", model: { provider: "fixture", model: "model" }, digest: "a".repeat(64),
      sections: [{ channel: "instructions", role: "system", content: `private prompt ${id}` }] });
    for (const id of ["deleted", "kept", "archived", "unknown", "protected"]) {
      if (id !== "unknown") await manager.create({ sessionId: id, agentId: "wish", scope: directory });
      await root.systemPromptHistory.record(snapshot(id));
      await archive.archive({ ...snapshot(id), result: { ok: true, callId: `call-${id}`, toolName: "read", output: { value: id }, phase: "completed" } });
      if (id === "protected") continue;
      const run = { runId: `run-${id}`, agentId: "wish", scope: id };
      await root.runtimeLifecycle.openRun(run);
      await root.runtimeLifecycle.finishRun({ snapshot: run, status: "completed" });
    }
    // Simulate a historical deletion that predated cleanup hooks.
    await manager.delete({ sessionId: "deleted" });
    await manager.delete({ sessionId: "protected" });
    await manager.archive({ sessionId: "archived" });
    await root.plugin(Application);
    await root.plugin(RuntimeFeature); await root.plugin(PromptFeature); await root.plugin(ArchiveFeature);
    const deadline = Date.now() + 5_000;
    while ((await root.runtimeLifecycle.readEvents("run-deleted")).length) {
      assert.ok(Date.now() < deadline, "scheduled startup pass did not run"); await delay(20);
    }
    assert.deepEqual(await root.systemPromptHistory.list("deleted"), []);
    assert.deepEqual(new Set(await root.toolResultArchive.sessionIds()), new Set(["kept", "archived", "unknown", "protected"]));
    for (const id of ["kept", "archived", "unknown", "protected"]) assert.equal((await root.systemPromptHistory.list(id)).length, 1);
    assert.equal((await root.runtimeLifecycle.recoverySnapshot()).pendingReconciliations.length, 1);

    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const unregister = root.application.registerSessionFeature("fixture-maintenance", {
      purgeOrder: 1, retainOwnershipOnUnload: false, async inspect() {}, async act() {},
      async sweepDeletedSessions() { entered.resolve(); await release.promise; },
    });
    const first = root.application.sweepDeletedSessions(), second = root.application.sweepDeletedSessions();
    assert.equal(first, second, "concurrent requests must share one cleanup pass");
    await entered.promise; release.resolve(); await first; unregister();
    let attempts = 0;
    const removeRetry = root.application.registerSessionFeature("fixture-retry", {
      purgeOrder: 1, retainOwnershipOnUnload: false, async inspect() {}, async act() {},
      async sweepDeletedSessions() { if (++attempts === 1) throw new Error("temporary cleanup failure"); },
    });
    await assert.rejects(root.application.sweepDeletedSessions(), /temporary cleanup failure/);
    await root.application.sweepDeletedSessions(); assert.equal(attempts, 2); removeRetry();

    const features = new SessionFeatureRegistry();
    features.register("prompts", { async inspect() {}, async act() {}, purgeSession: id => root.systemPromptHistory.purgeSession(id) });
    features.register("runtime", { purgeOrder: 1000, async inspect() {}, async act() {}, purgeSession: id => root.runtimeLifecycle.purgeSession(id) });
    const model = { provider: "fixture", model: "model" };
    const facade = new ApplicationFacade({ sessions: { manager }, agent: { definition: { id: "wish" },
      startRun() { throw new Error("No model work in this fixture"); }, control() {}, async *observe() {} }, sessionFeatures: features,
      models: { configuredModel: { getDefaultModel: () => model, resolve: () => ({ ref: model }) } } });
    await facade.deleteSession({ sessionId: "kept" });
    assert.deepEqual(await root.systemPromptHistory.list("kept"), []);
    assert.deepEqual(await root.runtimeLifecycle.readEvents("run-kept"), []);

    const lease = root.storageBackend.acquire("file", { kv: { list: true } });
    try {
      const reasoning = new DomainSessionReasoningStore(lease, "file"), permissions = new DomainSessionPermissionProfileStore(lease, "file");
      for (const id of ["deleted", "archived"]) {
        await reasoning.put({ schemaVersion: 1, sessionId: id, model, effort: "high" });
        await permissions.put({ schemaVersion: 1, sessionId: id, profile: "read-only" });
      }
      const deleted = id => manager.wasDeleted({ sessionId: id });
      await reasoning.sweepDeletedSessions(deleted); await permissions.sweepDeletedSessions(deleted);
      assert.equal(await reasoning.get("deleted"), undefined); assert.equal(await permissions.get("deleted"), undefined);
      assert.ok(await reasoning.get("archived")); assert.ok(await permissions.get("archived"));
    } finally { lease.release(); }
  } finally {
    archive?.release(); await root.fiber.dispose(); await store.close(); await rm(directory, { recursive: true, force: true });
  }
});
