import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import { GoalContextProvider, GoalRuntime, DomainGoalStateStore, MemoryGoalStateStore } from "../dist/goal/index.js";
import { createGoalTools } from "../dist/goal/consumers/model-tools.js";
import { createGoalSessionFeature } from "../dist/goal/consumers/session-feature.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";

function resolver(kv) {
  return { backend(id) { return { id, capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv }; } };
}

test("Goal state machine is durable, exact-revision CAS, and restart-disarmed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-goal-"));
  let storageRevision = 0;
  const kv = new FileKvStorageBackend({ backendId: "fixture", rootDirectory: directory, revision: () => `r-${++storageRevision}` });
  const storage = resolver(kv);
  try {
    const first = new GoalRuntime({ store: new DomainGoalStateStore({ storage, backendId: "fixture" }), defaultMaxGoalRounds: 4,
      id: () => "goal-1", now: () => new Date("2026-09-26T01:00:00Z") });
    const created = await first.create({ sessionId: "session-goal", objective: "Ship the feature" });
    assert.equal(created.activation, "armed"); assert.equal(created.revision, 1); assert.equal(created.roundsStarted, 0);
    const edited = await first.edit({ sessionId: "session-goal", ref: created, maxGoalRounds: 5 });
    assert.equal(edited.revision, 2); assert.equal(edited.maxGoalRounds, 5);
    await assert.rejects(first.pause({ sessionId: "session-goal", ref: created }), error => error.code === "goal_stale_revision");
    const paused = await first.pause({ sessionId: "session-goal", ref: edited }); assert.equal(paused.phase, "paused"); assert.equal(paused.activation, "disarmed");
    const resumed = await first.resume({ sessionId: "session-goal", ref: paused }); assert.equal(resumed.activation, "armed");
    const blocked = await first.block({ sessionId: "session-goal", ref: resumed, reason: { code: "external-dependency", message: "Waiting for API access" } });
    assert.equal(blocked.phase, "blocked"); assert.equal(blocked.blockedReason.code, "external-dependency");
    const resumedAgain = await first.resume({ sessionId: "session-goal", ref: blocked }); assert.equal(resumedAgain.blockedReason, undefined);
    const complete = await first.complete({ sessionId: "session-goal", ref: resumedAgain }); assert.equal(complete.phase, "complete");
    await first.close();

    const recovered = new GoalRuntime({ store: new DomainGoalStateStore({ storage, backendId: "fixture" }) });
    const view = await recovered.get({ sessionId: "session-goal" });
    assert.equal(view.phase, "complete"); assert.equal(view.activation, "disarmed"); assert.equal(view.revision, complete.revision);
    await recovered.close();
  } finally { await kv.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Storage CAS rejects one of two concurrent exact-revision mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-goal-cas-"));
  let revision = 0;
  const kv = new FileKvStorageBackend({ backendId: "fixture", rootDirectory: directory, revision: () => `r-${++revision}` });
  const storage = resolver(kv);
  try {
    const first = new GoalRuntime({ store: new DomainGoalStateStore({ storage, backendId: "fixture" }), id: () => "goal-cas" });
    const created = await first.create({ sessionId: "session-cas", objective: "CAS" });
    const second = new GoalRuntime({ store: new DomainGoalStateStore({ storage, backendId: "fixture" }) });
    const results = await Promise.allSettled([
      first.edit({ sessionId: "session-cas", ref: created, objective: "First" }),
      second.edit({ sessionId: "session-cas", ref: created, objective: "Second" }),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "goal_stale_revision").length, 1);
    await first.close(); await second.close();
  } finally { await kv.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Goal tools require trusted direct-human provenance and project current Context", async () => {
  const goal = new GoalRuntime({ store: new MemoryGoalStateStore(), id: () => "goal-tools" });
  const registry = new ToolRegistry(); for (const tool of createGoalTools(goal)) registry.register(tool);
  const executor = new ToolExecutor({ registry, authorization: {
    authorize() { return { status: "allowed", policyVersion: "goal-policy-v1" }; },
    revalidate() { return { status: "valid", policyVersion: "goal-policy-v1" }; },
  } });
  const snapshot = registry.captureSnapshot({ authorityVersion: "goal-authority-v1", availableTools: registry.list().map(tool => tool.name) });
  const subject = { agentId: "wish", sessionId: "session-tools", runId: "run-tools", userTurnId: "turn-tools", stepId: "step-tools" };
  async function call(name, input, userTurn) {
    const parsed = registry.parseCall({ id: `${name}-${Math.random()}`, name, argumentsJson: JSON.stringify(input) }); assert.equal(parsed.ok, true);
    return executor.execute({ call: parsed.call, context: Object.freeze({ cwd: process.cwd(), workspace: {}, permissions: { subject }, userTurn }),
      scope: { runId: subject.runId, userTurnId: subject.userTurnId, stepId: subject.stepId }, snapshot });
  }
  const direct = Object.freeze({ runId: "run-tools", userTurnId: "turn-tools", ordinal: 1, inputSource: "user",
    provenance: Object.freeze({ origin: "run_input", source: "user", receivedAt: "2026-09-26T00:00:00Z" }) });
  const denied = await call("create_goal", { objective: "Denied" }, Object.freeze({ ...direct, parentRunId: "parent" }));
  assert.equal(denied.ok, false); assert.equal(denied.error.code, "permission_denied");
  const created = await call("create_goal", { objective: "Long work", max_goal_rounds: 6 }, direct);
  assert.equal(created.ok, true); assert.equal(created.output.goal.activation, "armed");
  const read = await call("get_goal", {}, undefined); assert.equal(read.ok, true); assert.equal(read.output.goal.id, "goal-tools");
  const updated = await call("update_goal", { goal_id: created.output.goal.id, revision: created.output.goal.revision, action: "pause" }, direct);
  assert.equal(updated.ok, true); assert.equal(updated.output.goal.phase, "paused");

  const feature = createGoalSessionFeature(goal);
  const featureView = await feature.inspect("session-tools");
  assert.equal(featureView.key, "goal");
  await feature.act("session-tools", "resume", featureView.token);
  assert.equal((await goal.get({ sessionId: "session-tools" })).phase, "active");

  const provider = new GoalContextProvider(goal);
  const projected = await provider.provide({ runId: "run-tools", userTurnId: "turn-tools", stepId: "step-tools", sessionId: "session-tools",
    model: { provider: "fixture", model: "model" }, workspace: { cwd: process.cwd(), fingerprint: "workspace", revision: "v1", instructions: [] },
    runtime: { capturedAt: "2026-09-26T00:00:00Z", stateVersion: 1, userTurnOrdinal: 1, stepOrdinal: 1 } });
  assert.equal(projected.length, 1); assert.match(projected[0].message.content, /process-local/u);
  await goal.close();
});
