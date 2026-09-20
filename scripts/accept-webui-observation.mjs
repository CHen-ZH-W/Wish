import test from "node:test";
import assert from "node:assert/strict";
import { ContextObservations, ObservedContextProjector } from "../dist/context/observation.js";
import { SessionFeatureRegistry } from "../dist/apps/session-features.js";
import { SubagentRuntime, MemorySubagentRecordStore } from "../dist/subagents/index.js";

test("Context observation uses actual projection order, contains no prompt bodies and preserves unknown budgets", async () => {
  const observations = new ContextObservations();
  const projector = new ObservedContextProjector({}, observations.record);
  const input = { sessionId: "s", runId: "r", userTurnId: "turn", stepId: "step" };
  const projection = await projector.projectFromProviders({ providerInput: input,
    request: { model: { provider: "fixture", model: "m" }, instructions: [{ role: "system", content: "PRIVATE STABLE BODY" }], messages: [{ role: "user", content: "PRIVATE USER BODY" }], tools: [] }, currentUserMessageIndex: 0,
    providers: [{ id: "private-provider", provide: () => [{ id: "instructions", kind: "instruction", placement: "stable_prefix", message: { role: "developer", content: "PRIVATE INSTRUCTION BODY" } }] }],
  });
  assert.equal(projection.request.messages[0].content, "PRIVATE INSTRUCTION BODY");
  const [view] = observations.list("s"); assert.equal(view.budget.status, "unknown");
  assert.deepEqual(view.instructions, [{ index: 0, role: "system", chars: 19 }]);
  assert.deepEqual(view.messages.map(item => item.role), ["developer", "user"]); assert.equal(view.providers[0].items[0].included, true);
  assert.equal(JSON.stringify(view).includes("PRIVATE"), false); assert.deepEqual(observations.list("other"), []); assert.ok(Object.isFrozen(view.messages));
  for (let i = 0; i < 120; i++) observations.record({ ...input, stepId: String(i) }, projection);
  assert.equal(observations.list("s").length, 100);
});
test("a failing optional feature does not suppress another module or expose its raw error", async () => {
  const registry = new SessionFeatureRegistry();
  registry.register("broken", { async inspect() { throw new Error("PRIVATE filesystem error"); }, async act() {} });
  registry.register("working", { async inspect() { return { key: "working", title: "Working", text: "Available", token: {}, actions: [] }; }, async act() {} });
  const views = await registry.inspect("s"); assert.equal(views[1].text, "Available"); assert.deepEqual(views[0].actions, []); assert.equal(JSON.stringify(views).includes("PRIVATE"), false);
  assert.equal(views[0].titleEn, "Module information unavailable");
  assert.ok(views[0].textEn.includes("other modules are unaffected"));
});
test("an unloaded feature's late result cannot reappear as an actionable view", async () => {
  const registry = new SessionFeatureRegistry(); let release;
  const unregister = registry.register("departing", { inspect: () => new Promise(resolve => { release = resolve; }), async act() { assert.fail("old action executed"); } });
  const pending = registry.inspect("s"); unregister();
  release({ key: "departing", title: "Old", text: "Old", token: { version: 1 }, actions: [{ name: "approve", label: "Approve" }] });
  assert.deepEqual(await pending, []);
  await assert.rejects(registry.act("s", "departing", "approve", {}), /unavailable/);
});
test("Subagent Session observation reads only owned records and never discovers, refreshes or stops processes", async () => {
  const store = new MemorySubagentRecordStore();
  const record = { schemaVersion: 1, id: "child", parentAgentId: "a", parentSessionId: "s", parentRunId: "r", workspaceRoot: "/workspace", childSessionId: "child-session", childRunId: "child-run", role: "worker", task: "example", status: "lost", createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z" };
  await store.create(record);
  const unexpected = () => { throw new Error("Observation must not touch processes"); };
  const runtime = new SubagentRuntime({ store, execution: { list: unexpected, inspect: unexpected, start: unexpected, stop: unexpected }, launcher: { resolve: unexpected } });
  try {
    assert.equal((await runtime.observeSession({ parentAgentId: "a", parentSessionId: "s", workspaceRoot: "/workspace" }))[0].status, "lost");
    assert.deepEqual(await runtime.observeSession({ parentAgentId: "a", parentSessionId: "other", workspaceRoot: "/workspace" }), []);
    assert.deepEqual(await runtime.observeSession({ parentAgentId: "a", parentSessionId: "s", workspaceRoot: "/other" }), []);
  } finally { await runtime.close(); }
});
