import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";

import { Runtime } from "../dist/core/runtime/runtime.js";
import { GoalRuntime, MemoryGoalStateStore } from "../dist/goal/index.js";
import GoalRoundDriver from "../dist/goal/round-driver.js";

function services() {
  const sequence = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return { ids: { runId: () => `run-${++sequence.run}`, userTurnId: () => `turn-${++sequence.turn}`,
    controlId: () => `control-${++sequence.control}`, eventId: () => `event-${++sequence.event}` },
    now: () => `2026-09-26T02:00:${String(++sequence.time).padStart(2, "0")}Z` };
}
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
async function collect(iterable) { const values = []; for await (const value of iterable) values.push(value); return values; }

async function fixture(goalOptions = {}, additions = {}) {
  const root = new Context();
  const goal = new GoalRuntime({ store: new MemoryGoalStateStore(), id: () => "goal-round", ...goalOptions });
  let registeredPolicy;
  root.provide("goal", goal);
  for (const [name, value] of Object.entries(additions)) root.provide(name, value);
  root.provide("runEngine", { registerContinuationPolicy(value) { registeredPolicy = value; return () => { if (registeredPolicy === value) registeredPolicy = undefined; }; } });
  const driver = await root.plugin(GoalRoundDriver);
  assert.ok(registeredPolicy);
  const policy = Object.freeze({
    openUserTurn(input) { return registeredPolicy?.openUserTurn?.(input); },
    afterUserTurn(input) { return registeredPolicy?.afterUserTurn?.(input) ?? { type: "none" }; },
    finishRun(input) { return registeredPolicy?.finishRun?.(input); },
  });
  return { root, goal, policy, driver };
}

test("GoalRoundDriver holds one Run, admits at UserTurn open, and follows up until complete", async () => {
  const { root, goal, policy } = await fixture();
  const snapshots = [];
  const runtime = new Runtime({ ...services(), continuationPolicy: policy, stepPipeline: {
    async execute({ snapshot }) {
      snapshots.push(snapshot);
      if (snapshot.userTurn.ordinal === 1) {
        await goal.create({ sessionId: snapshot.run.scope, objective: "Finish autonomously", maxGoalRounds: 3 });
      } else {
        const current = await goal.get({ sessionId: snapshot.run.scope });
        assert.equal(snapshot.userTurn.provenance.source, "wish-goal-round-driver");
        assert.deepEqual(snapshot.userTurn.input.continuation, { kind: "goal_round", goalId: current.id, revision: current.revision, round: 1 });
        assert.equal(current.roundsStarted, 1);
        await goal.complete({ sessionId: snapshot.run.scope, ref: current });
      }
      return { status: "completed", result: `turn-${snapshot.userTurn.ordinal}` };
    },
  } });
  const handle = runtime.startRun({ id: "wish" }, { scope: "session-round", payload: { text: "start" }, inputSource: "user" });
  const eventsPromise = collect(runtime.observe("wish", handle.runId));
  const completion = await handle.completion; const events = await eventsPromise;
  assert.equal(completion.status, "completed"); assert.equal(completion.snapshot.userTurns.length, 2);
  assert.equal((await goal.get({ sessionId: "session-round" })).phase, "complete");
  assert.equal(events.filter(event => event.payload.type === "run.completion_deferred").length, 1);
  assert.equal(events.filter(event => event.payload.type === "run.completion_released").length, 1);
  await root.fiber.dispose(); await goal.close();
});

test("driver unload releases its hold and disarms without changing durable phase", async () => {
  const { root, goal, policy, driver } = await fixture();
  let runtime; let handle; let externalHold;
  runtime = new Runtime({ ...services(), continuationPolicy: policy, stepPipeline: {
    async execute({ snapshot }) {
      await goal.create({ sessionId: snapshot.run.scope, objective: "Survive reload" });
      externalHold = runtime.deferRunCompletion(handle.runId, "waiting for Subagent result");
      return { status: "completed", result: "created" };
    },
  } });
  handle = runtime.startRun({ id: "wish" }, { scope: "session-unload", payload: { text: "start" }, inputSource: "user" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.activeRuns()[0].snapshot.completionHolds, 2);
  await driver.dispose();
  assert.equal(runtime.activeRuns()[0].snapshot.completionHolds, 1);
  const current = await goal.get({ sessionId: "session-unload" });
  assert.equal(current.phase, "active"); assert.equal(current.activation, "disarmed");
  externalHold.release();
  assert.equal((await handle.completion).status, "completed");
  await root.fiber.dispose(); await goal.close();
});

test("pending Plan review gates and disarms automatic Goal continuation", async () => {
  const { root, goal, policy } = await fixture({}, { plan: {
    get() { return { active: true, review: { status: "pending" } }; },
  } });
  const runtime = new Runtime({ ...services(), continuationPolicy: policy, stepPipeline: {
    async execute({ snapshot }) {
      await goal.create({ sessionId: snapshot.run.scope, objective: "Wait for review" });
      return { status: "completed", result: "review submitted" };
    },
  } });
  const completion = await runtime.startRun({ id: "wish" }, { scope: "session-plan-gate", payload: { text: "start" }, inputSource: "user" }).completion;
  const current = await goal.get({ sessionId: "session-plan-gate" });
  assert.equal(completion.status, "completed"); assert.equal(completion.snapshot.userTurns.length, 1);
  assert.equal(current.phase, "active"); assert.equal(current.activation, "disarmed"); assert.equal(current.roundsStarted, 0);
  await root.fiber.dispose(); await goal.close();
});

test("Workflow/Subagent-style external hold runs before the next Goal round", async () => {
  const { root, goal, policy } = await fixture();
  const inputs = []; let runtime; let handle; let externalHold;
  runtime = new Runtime({ ...services(), continuationPolicy: policy, stepPipeline: {
    async execute({ snapshot }) {
      inputs.push(snapshot.userTurn.input.text);
      if (snapshot.userTurn.ordinal === 1) {
        await goal.create({ sessionId: snapshot.run.scope, objective: "Yield to child", maxGoalRounds: 2 });
        externalHold = runtime.deferRunCompletion(handle.runId, "waiting for Workflow workflow-1");
      } else if (snapshot.userTurn.provenance.source === "wish-goal-round-driver") {
        const current = await goal.get({ sessionId: snapshot.run.scope });
        await goal.complete({ sessionId: snapshot.run.scope, ref: current });
      }
      return { status: "completed", result: "done" };
    },
  } });
  handle = runtime.startRun({ id: "wish" }, { scope: "session-hold-priority", payload: { text: "initial" }, inputSource: "user" });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(externalHold); assert.equal(runtime.activeRuns()[0].awaitingFollowUp, true);
  assert.equal(runtime.control("wish", handle.runId, { type: "follow_up", source: "wish-workflow-result", payload: { text: "workflow-result" }, text: "workflow-result" }).accepted, true);
  externalHold.release();
  const completion = await handle.completion;
  assert.equal(completion.status, "completed"); assert.equal(inputs.length, 3); assert.deepEqual(inputs.slice(0, 2), ["initial", "workflow-result"]);
  assert.match(inputs[2], /Continue the active Goal/u); assert.equal((await goal.get({ sessionId: "session-hold-priority" })).roundsStarted, 1);
  await root.fiber.dispose(); await goal.close();
});

test("round limit blocks durably and releases the Goal hold", async () => {
  const { root, goal, policy } = await fixture();
  const runtime = new Runtime({ ...services(), continuationPolicy: policy, stepPipeline: {
    async execute({ snapshot }) {
      if (snapshot.userTurn.ordinal === 1) await goal.create({ sessionId: snapshot.run.scope, objective: "Bounded", maxGoalRounds: 1 });
      return { status: "completed", result: "done" };
    },
  } });
  const completion = await runtime.startRun({ id: "wish" }, { scope: "session-limit", payload: { text: "start" }, inputSource: "user" }).completion;
  const current = await goal.get({ sessionId: "session-limit" });
  assert.equal(completion.status, "completed"); assert.equal(completion.snapshot.userTurns.length, 2);
  assert.equal(current.phase, "blocked"); assert.equal(current.blockedReason.code, "round-limit"); assert.equal(current.roundsStarted, 1);
  await root.fiber.dispose(); await goal.close();
});

test("failed Goal round disarms, while cancellation pauses the exact active Goal", async () => {
  {
    const { root, goal, policy } = await fixture();
    const runtime = new Runtime({ ...services(), continuationPolicy: policy, stepPipeline: {
      async execute({ snapshot }) {
        if (snapshot.userTurn.ordinal === 1) { await goal.create({ sessionId: snapshot.run.scope, objective: "May fail" }); return { status: "completed", result: "created" }; }
        return { status: "failed", error: { code: "fixture_failure", message: "round failed", retryable: false } };
      },
    } });
    const completion = await runtime.startRun({ id: "wish" }, { scope: "session-failed", payload: { text: "start" }, inputSource: "user" }).completion;
    assert.equal(completion.status, "failed"); assert.equal((await goal.get({ sessionId: "session-failed" })).activation, "disarmed");
    await root.fiber.dispose(); await goal.close();
  }
  {
    const { root, goal, policy } = await fixture(); const entered = deferred();
    const runtime = new Runtime({ ...services(), continuationPolicy: policy, stepPipeline: {
      async execute({ snapshot, signal }) {
        if (snapshot.userTurn.ordinal === 1) { await goal.create({ sessionId: snapshot.run.scope, objective: "May cancel" }); return { status: "completed", result: "created" }; }
        entered.resolve(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); return { status: "aborted" };
      },
    } });
    const handle = runtime.startRun({ id: "wish" }, { scope: "session-cancel", payload: { text: "start" }, inputSource: "user" });
    await entered.promise; runtime.control("wish", handle.runId, { type: "abort", source: "wish-webui", reason: "user_stop" });
    const completion = await handle.completion; const current = await goal.get({ sessionId: "session-cancel" });
    assert.equal(completion.status, "aborted"); assert.equal(current.phase, "paused"); assert.equal(current.activation, "disarmed");
    await root.fiber.dispose(); await goal.close();
  }
});
