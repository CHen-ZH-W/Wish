import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "./fixtures/candidates.mjs";
import { captureTaskTrace } from "../dist/evolution/observations.js";
import { createEvolutionControl } from "../dist/evolution/consumers/webui-control.js";

const at = "2026-10-22T00:00:00.000Z", sha = "a".repeat(64);
function trace(sessionId, taskId, sourceKind = "production") {
  const runId = `run-${taskId}-${sourceKind}`;
  return captureTaskTrace({ sessionId, runId, sourceKind,
    history: { sessionId, historyRevision: "imported-host-evidence", records: [] }, attempts: [],
    events: [{ schemaVersion: 1, type: "run.opened", runId, scope: sessionId, occurredAt: at }, { schemaVersion: 1, type: "run.completed", runId, occurredAt: at }],
    outcome: { runId, taskId, verifierId: "host-import-verifier", verifierVersion: 1, result: "failed", sourceKind, evidenceDigest: sha },
  });
}
test("real Host advisory surfaces independent scoped evidence without model work or leaked generations", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-trigger-service-"));
  const originalFetch = globalThis.fetch; let requests = 0, host, application, retiredTrigger;
  globalThis.fetch = async () => { requests++; throw new Error("Advisory must never call a model"); };
  try {
    host = await boot(directory, { WISH_EVOLUTION_ENABLED: "1", WISH_EVOLUTION_TRIGGER_MODE: "advisory" });
    const ctx = host.surfaceContext, evolution = ctx.get("evolution"), trigger = ctx.get("evolutionTrigger");
    assert.ok(evolution); assert.equal(trigger.mode, "advisory"); retiredTrigger = trigger;
    application = await ctx.get("application").open();
    const first = await application.createSession({ workspaceRoot: directory }), second = await application.createSession({ workspaceRoot: directory });
    const included = ["task-one", "task-two", "task-three"].map(id => trace(first.sessionId, id));
    const excluded = [trace(first.sessionId, "heldout", "held-out"), trace(first.sessionId, "self-generated", "evolution"), trace(second.sessionId, "other-one"), trace(second.sessionId, "other-two"), trace(second.sessionId, "other-heldout", "held-out")];
    for (const item of [...included, ...excluded]) await evolution.recordTrace(item);
    const before = ctx.get("runEngine").lifecycleSnapshot().generations;
    const control = createEvolutionControl(evolution, () => trigger), signal = new AbortController().signal;
    const [one, two] = await Promise.all([control.inspectSession(application, first.sessionId, signal), control.inspectSession(application, second.sessionId, signal)]);
    assert.equal(one.trigger.mode, "advisory"); assert.equal(one.trigger.suggestions.length, 1); assert.equal(two.trigger.suggestions.length, 0);
    assert.deepEqual(new Set(one.trigger.suggestions[0].taskIds), new Set(["task-one", "task-two", "task-three"]));
    assert.equal(one.trigger.suggestions[0].failureCategory, "harness"); assert.equal(one.trigger.suggestions[0].confidence, 0.5);
    assert.deepEqual(new Set(one.traces.map(item => item.id)), new Set(included.map(item => item.id)));
    for (let repeat = 0; repeat < 3; repeat++) await trigger.inspectSession(first.sessionId);
    assert.equal(ctx.get("runEngine").lifecycleSnapshot().generations, before, "Advisory reads must not open extra Application generations");
    assert.equal((await trigger.trigger.snapshot()).dispatches.length, 0); assert.equal((await evolution.list()).length, 0);
    assert.equal((await ctx.get("candidates").history()).validations.length, 0); assert.equal((await ctx.get("experiments").list()).length, 0); assert.equal(requests, 0);
    await application.runGeneration?.retire(); application = undefined;
    await host.dispose(); host = undefined;
    await assert.rejects(retiredTrigger.inspectSession(first.sessionId), /evolution_trigger_closed/);
    await assert.rejects(retiredTrigger.trigger.snapshot(), /evolution_trigger_store_closed/);
  } finally {
    await application?.runGeneration?.retire(); await host?.dispose(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true });
  }
});
