import assert from "node:assert/strict";
import test from "node:test";
import { Runtime } from "../dist/core/runtime/runtime.js";
import { StepExecutionCoordinator } from "../dist/composition/step-execution.js";

const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
const definition = { id: "agent" };
const input = { scope: "session", payload: { text: "first" } };

test("one Run pins the old pipeline through durable Step finish, then uses the new implementation with its queues and memory intact", async () => {
  const boundary = new StepExecutionCoordinator(), entered = deferred(), finish = deferred(), committing = deferred(), committed = deferred();
  const calls = [], releases = []; let version = 1, changed = false;
  const source = boundary.source(() => {
    const captured = version;
    return { pipeline: { async execute({ snapshot, memory }) {
      calls.push({ version: captured, runId: snapshot.run.runId, turn: snapshot.userTurn.ordinal,
        step: snapshot.step.ordinal, steering: snapshot.steering, memory });
      if (calls.length === 1) { entered.resolve(); await finish.promise; return { status: "continue", reason: "tools", memory: "old-memory" }; }
      return { status: "completed", result: `v${captured}` };
    } }, release() { releases.push(captured); } };
  });
  const runtime = new Runtime({ stepPipeline: source, lifecycle: {
    openRun() {}, finishRun() {}, openUserTurn() {}, finishUserTurn() {}, openStep() {},
    async finishStep() { if (calls.length === 1) { committing.resolve(); await committed.promise; } },
  } });
  const handle = runtime.startRun(definition, input);
  await entered.promise;
  const replacement = boundary.replace(async () => { assert.deepEqual(releases, [1]); version = 2; changed = true; });
  assert.equal(runtime.control("agent", handle.runId, { type: "steer", text: "continue planning" }).accepted, true);
  assert.equal(runtime.control("agent", handle.runId, { type: "follow_up", text: "second", payload: { text: "second" } }).accepted, true);
  finish.resolve(); await committing.promise;
  assert.equal(changed, false); assert.equal(boundary.snapshot().activeSteps, 1);
  committed.resolve(); await replacement;
  const completion = await handle.completion;
  assert.equal(completion.status, "completed");
  assert.deepEqual(calls.map(call => [call.version, call.turn, call.step]), [[1, 1, 1], [2, 1, 2], [2, 2, 1]]);
  assert.ok(calls.every(call => call.runId === handle.runId));
  assert.equal(calls[1].memory, "old-memory");
  assert.equal(calls[1].steering[0].text, "continue planning");
  assert.deepEqual(releases, [1, 2, 2]);
  assert.deepEqual(boundary.snapshot(), { phase: "ready", activeSteps: 0 });
});

test("abort while waiting for replacement creates no phantom Step or Tool execution", async () => {
  const boundary = new StepExecutionCoordinator(), updating = deferred(), updated = deferred(); let opened = 0;
  const replacement = boundary.replace(async () => { updating.resolve(); await updated.promise; });
  await updating.promise;
  const runtime = new Runtime({ stepPipeline: boundary.source(() => { opened++; throw Error("must not open"); }) });
  const handle = runtime.startRun(definition, input);
  await tick();
  runtime.control("agent", handle.runId, { type: "abort", reason: "user_cancelled", source: "user" });
  const completion = await handle.completion;
  assert.equal(completion.status, "aborted"); assert.equal(completion.cancellation.source, "user");
  assert.equal(completion.snapshot.userTurns[0].steps.length, 0); assert.equal(opened, 0);
  updated.resolve(); await replacement;
});

test("cancel before mutation reopens the original pipeline without aborting an admitted Step", async () => {
  const boundary = new StepExecutionCoordinator(), entered = deferred(), finish = deferred(), controller = new AbortController();
  let mutated = false;
  const runtime = new Runtime({ stepPipeline: boundary.source(() => ({ pipeline: { async execute() {
    entered.resolve(); await finish.promise; return { status: "completed", result: "old" };
  } }, release() {} })) });
  const handle = runtime.startRun(definition, input); await entered.promise;
  const replacement = boundary.replace(async () => { mutated = true; }, { signal: controller.signal });
  const rejected = assert.rejects(replacement, /cancel update/);
  controller.abort(Error("cancel update")); await rejected;
  assert.equal(mutated, false); assert.equal(boundary.snapshot().phase, "ready");
  finish.resolve(); assert.equal((await handle.completion).status, "completed");
});

test("replacement failure fences later Steps and never automatically retries side effects", async () => {
  const boundary = new StepExecutionCoordinator(); let attempts = 0, executions = 0;
  await assert.rejects(boundary.replace(async () => { attempts++; throw Error("activation failed"); }), /activation failed/);
  const runtime = new Runtime({ stepPipeline: boundary.source(() => { executions++; throw Error("must not execute"); }) });
  const completion = await runtime.startRun(definition, input).completion;
  assert.equal(completion.status, "failed"); assert.equal(completion.snapshot.userTurns[0].steps.length, 0);
  await assert.rejects(boundary.replace(async () => { attempts++; }), { code: "step_execution_failed" });
  assert.equal(attempts, 1); assert.equal(executions, 0);
});

test("failed Step finishing still releases its lease exactly once", async () => {
  const boundary = new StepExecutionCoordinator(); let releases = 0;
  const runtime = new Runtime({ stepPipeline: boundary.source(() => ({
    pipeline: { async execute() { return { status: "completed", result: "value" }; } }, release() { releases++; },
  })), lifecycle: { openRun() {}, finishRun() {}, openUserTurn() {}, finishUserTurn() {}, openStep() {}, finishStep() { throw Error("journal failed"); } } });
  assert.equal((await runtime.startRun(definition, input).completion).status, "failed");
  assert.equal(releases, 1); assert.equal(boundary.snapshot().activeSteps, 0);
});

test("failed resource release prevents replacement and Root close wakes blocked acquisitions", async () => {
  const boundary = new StepExecutionCoordinator(), signal = new AbortController().signal;
  const lease = await boundary.source(() => ({ pipeline: { execute() {} }, release() { throw Error("cleanup failed"); } })).acquire({ signal });
  const replacement = boundary.replace(async () => { throw Error("must not replace"); });
  const rejected = assert.rejects(replacement, { code: "step_execution_failed" });
  assert.throws(() => lease.release(), /cleanup failed/); lease.release(); await rejected;
  const other = new StepExecutionCoordinator(), done = deferred();
  const update = other.replace(() => done.promise), failedUpdate = assert.rejects(update, { code: "step_execution_closed" });
  const waiting = other.source(() => { throw Error("must not acquire"); }).acquire({ signal });
  const closed = assert.rejects(waiting, { code: "step_execution_closed" });
  other.close(); await closed; done.resolve(); await failedUpdate;
});

test("a shared execution owner drains every concurrent Run before replacing its implementation", async () => {
  const boundary = new StepExecutionCoordinator(), opened = deferred(), first = deferred(), second = deferred();
  let entered = 0, replaced = false;
  const runtime = new Runtime({ stepPipeline: boundary.source(() => ({ pipeline: { async execute({ snapshot }) {
    if (++entered === 2) opened.resolve();
    await (snapshot.run.scope === "one" ? first.promise : second.promise);
    return { status: "completed", result: "done" };
  } }, release() {} })) });
  const one = runtime.startRun(definition, { ...input, scope: "one" });
  const two = runtime.startRun(definition, { ...input, scope: "two" });
  await opened.promise;
  const update = boundary.replace(async () => { replaced = true; });
  first.resolve(); await one.completion;
  assert.equal(replaced, false); assert.equal(boundary.snapshot().activeSteps, 1);
  second.resolve(); await two.completion; await update;
  assert.equal(replaced, true);
});
