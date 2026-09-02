import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../dist/core/agent/agent.js";
import {
  EventCursorExpiredError,
  RuntimeEventStream,
} from "../dist/core/events/event.js";
import {
  applyRuntimeTransition,
  createRunState,
  Runtime,
} from "../dist/core/runtime/runtime.js";

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function deterministicServices() {
  const counters = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return {
    ids: {
      runId: () => `run-${++counters.run}`,
      userTurnId: () => `turn-${++counters.turn}`,
      controlId: () => `control-${++counters.control}`,
      eventId: () => `event-${++counters.event}`,
    },
    now: () => `2026-01-01T00:00:${String(++counters.time).padStart(2, "0")}Z`,
  };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function flushWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("outer Run loop starts follow-up UserTurns while inner Step ordinals reset", async () => {
  const services = deterministicServices();
  const executions = [];
  let agent;
  let handle;
  const runtime = new Runtime({
    ...services,
    maxSteps: 4,
    stepPipeline: {
      async execute(input) {
        executions.push({
          runId: input.snapshot.run.runId,
          userTurnId: input.snapshot.userTurn.userTurnId,
          turn: input.snapshot.userTurn.ordinal,
          step: input.snapshot.step.ordinal,
          text: input.snapshot.userTurn.input.text,
        });
        if (input.snapshot.userTurn.ordinal === 1 && input.snapshot.step.ordinal === 1) {
          const receipt = agent.control(handle.runId, {
            type: "follow_up",
            id: "follow-1",
            payload: { text: "second" },
            text: "second",
          });
          assert.equal(receipt.accepted, true);
          const duplicate = agent.control(handle.runId, {
            type: "follow_up",
            id: "follow-1",
            payload: { text: "must not duplicate" },
            text: "must not duplicate",
          });
          assert.equal(duplicate.accepted, true);
          assert.equal(duplicate.reason, "duplicate_control");
          return { status: "continue", reason: "tool_calls", memory: ["first"] };
        }
        return {
          status: "completed",
          result: `${input.snapshot.userTurn.input.text}:done`,
        };
      },
    },
  });
  agent = new Agent({ id: "coding-agent" }, runtime);
  handle = agent.startRun({ scope: "conversation:1", payload: { text: "first" } });
  const eventsPromise = collect(agent.observe(handle.runId));

  const completion = await handle.completion;
  const events = await eventsPromise;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result, "second:done");
  assert.equal(completion.snapshot.runId, handle.runId);
  assert.equal(completion.snapshot.userTurns.length, 2);
  assert.equal(Object.isFrozen(completion.snapshot.userTurns[0].input), true);
  assert.notEqual(
    completion.snapshot.userTurns[0].id,
    completion.snapshot.userTurns[1].id,
  );
  assert.deepEqual(
    completion.snapshot.userTurns.map((turn) => turn.steps.map((step) => step.ordinal)),
    [[1, 2], [1]],
  );
  assert.equal(new Set(executions.map((item) => item.runId)).size, 1);
  assert.equal(
    events.filter((event) => event.payload.type === "user_turn.started").length,
    2,
  );
});

test("in-flight steering is ordered, delivered once, and forces the next Step", async () => {
  const services = deterministicServices();
  const entered = deferred();
  const release = deferred();
  const snapshots = [];
  const runtime = new Runtime({
    ...services,
    maxSteps: 3,
    snapshotProvider: {
      capture() {
        return { authority: { version: 7 } };
      },
    },
    stepPipeline: {
      async execute(input) {
        snapshots.push(input.snapshot);
        if (input.snapshot.step.ordinal === 1) {
          entered.resolve();
          await release.promise;
        }
        return { status: "completed", result: "done" };
      },
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const handle = agent.startRun({ scope: "conversation:steer", payload: "task" });
  await entered.promise;

  assert.equal(agent.control(handle.runId, {
    type: "steer",
    id: "steer-1",
    text: "first correction",
  }).accepted, true);
  const duplicate = agent.control(handle.runId, {
    type: "steer",
    id: "steer-1",
    text: "must not replace the original",
  });
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.reason, "duplicate_control");
  assert.equal(agent.control(handle.runId, {
    type: "steer",
    id: "steer-2",
    text: "second correction",
  }).accepted, true);
  release.resolve();

  const completion = await handle.completion;
  assert.equal(completion.status, "completed");
  assert.equal(snapshots.length, 2);
  assert.deepEqual(
    snapshots[1].steering.map((message) => message.text),
    ["first correction", "second correction"],
  );
  assert.equal(snapshots[0].steering.length, 0);
  assert.equal(Object.isFrozen(snapshots[1]), true);
  assert.equal(Object.isFrozen(snapshots[1].environment.authority), true);
});

test("abort preserves the first cause and rejects repeated or late control", async () => {
  const services = deterministicServices();
  const entered = deferred();
  const runtime = new Runtime({
    ...services,
    stepPipeline: {
      async execute(input) {
        entered.resolve();
        if (!input.signal.aborted) {
          await new Promise((resolve) => {
            input.signal.addEventListener("abort", resolve, { once: true });
          });
        }
        return { status: "aborted" };
      },
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const handle = agent.startRun({ scope: "conversation:abort", payload: "task" });
  await entered.promise;

  const first = agent.control(handle.runId, {
    type: "abort",
    id: "abort-1",
    reason: "user_stop",
    source: "cli",
    requestedAt: "2026-01-01T01:00:00Z",
  });
  const repeated = agent.control(handle.runId, {
    type: "abort",
    id: "abort-2",
    reason: "timeout",
  });

  assert.equal(first.accepted, true);
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.reason, "already_cancelled");
  assert.deepEqual(repeated.cancellation, first.cancellation);

  const completion = await handle.completion;
  assert.equal(completion.status, "aborted");
  assert.equal(completion.cancellation.reason, "user_stop");
  assert.equal(completion.cancellation.source, "cli");
  assert.equal(
    agent.control(handle.runId, { type: "steer", text: "too late" }).reason,
    "run_already_terminal",
  );
});

test("Step budget failure terminates the Run before a queued follow-up", async () => {
  const services = deterministicServices();
  let agent;
  let handle;
  const runtime = new Runtime({
    ...services,
    maxSteps: 2,
    stepPipeline: {
      async execute(input) {
        if (input.snapshot.step.ordinal === 1) {
          assert.equal(agent.control(handle.runId, {
            type: "follow_up",
            id: "never-run",
            payload: "queued",
          }).accepted, true);
        }
        return {
          status: "continue",
          reason: "tool_calls",
          memory: input.snapshot.step.ordinal,
        };
      },
    },
  });
  agent = new Agent({ id: "coding-agent" }, runtime);
  handle = agent.startRun({ scope: "conversation:budget", payload: "initial" });

  const completion = await handle.completion;
  assert.equal(completion.status, "failed");
  assert.equal(completion.error.code, "max_steps_exceeded");
  assert.equal(completion.snapshot.userTurns.length, 1);
  assert.equal(completion.snapshot.userTurns[0].steps.length, 2);
  assert.equal(completion.snapshot.queuedFollowUps, 0);
});

test("a completion hold keeps the Run active without keeping a UserTurn open", async () => {
  const services = deterministicServices();
  const runtime = new Runtime({
    ...services,
    stepPipeline: {
      async execute() {
        return { status: "completed", result: "done" };
      },
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const handle = agent.startRun({ scope: "conversation:hold", payload: "task" });
  const hold = runtime.deferRunCompletion(handle.runId, "external result");
  assert.ok(hold);

  await flushWork();
  const active = runtime.activeRuns();
  assert.equal(active.length, 1);
  assert.equal(active[0].awaitingFollowUp, true);
  assert.equal(active[0].snapshot.currentUserTurnId, undefined);

  hold.release();
  const completion = await handle.completion;
  assert.equal(completion.status, "completed");
  assert.equal(runtime.activeRuns().length, 0);
});

test("scope is exclusive only while active and terminal events remain observable", async () => {
  const services = deterministicServices();
  const entered = deferred();
  const release = deferred();
  const runtime = new Runtime({
    ...services,
    stepPipeline: {
      async execute(input) {
        if (input.snapshot.userTurn.input === "wait") {
          entered.resolve();
          await release.promise;
        }
        return { status: "completed", result: input.snapshot.userTurn.input };
      },
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const first = agent.startRun({ scope: "shared", payload: "wait" });
  await entered.promise;
  assert.throws(
    () => agent.startRun({ scope: "shared", payload: "conflict" }),
    /already has an active Run/u,
  );
  release.resolve();
  await first.completion;

  const retainedEvents = await collect(agent.observe(first.runId));
  assert.equal(retainedEvents.at(-1).payload.type, "run.completed");

  const second = agent.startRun({ scope: "shared", payload: "next" });
  assert.equal(runtime.runForScope("shared").runId, second.runId);
  await second.completion;
});

test("lifecycle ordering is authoritative while diagnostic observers fail open", async () => {
  const services = deterministicServices();
  const order = [];
  const lifecycle = {
    openRun() { order.push("run.open"); },
    finishRun() { order.push("run.finish"); },
    openUserTurn() { order.push("turn.open"); },
    finishUserTurn() { order.push("turn.finish"); },
    openStep() { order.push("step.open"); },
    finishStep() { order.push("step.finish"); },
  };
  const runtime = new Runtime({
    ...services,
    lifecycle,
    observers: [{
      onTransition() {
        throw new Error("diagnostic failure");
      },
    }],
    userTurnPipeline: {
      async process(input) {
        order.push("turn.process");
        return `${input.result}:processed`;
      },
    },
    stepPipeline: {
      async execute() {
        order.push("step.execute");
        return { status: "completed", result: "done" };
      },
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const completion = await agent.startRun({
    scope: "conversation:lifecycle",
    payload: "task",
  }).completion;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result, "done:processed");
  assert.deepEqual(order, [
    "run.open",
    "turn.open",
    "step.open",
    "step.execute",
    "step.finish",
    "turn.process",
    "turn.finish",
    "run.finish",
  ]);
});

test("a lifecycle commit failure fails the active Step, UserTurn, and Run", async () => {
  const services = deterministicServices();
  const runtime = new Runtime({
    ...services,
    lifecycle: {
      openRun() {},
      finishRun() {},
      openUserTurn() {},
      finishUserTurn() {},
      openStep() {},
      finishStep() {
        throw new Error("journal unavailable");
      },
    },
    stepPipeline: {
      async execute() {
        return { status: "completed", result: "must not complete" };
      },
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const completion = await agent.startRun({
    scope: "conversation:lifecycle-failure",
    payload: "task",
  }).completion;

  assert.equal(completion.status, "failed");
  assert.equal(completion.error.code, "lifecycle_commit_failed");
  assert.equal(completion.snapshot.status, "failed");
  assert.equal(completion.snapshot.userTurns[0].status, "failed");
  assert.equal(completion.snapshot.userTurns[0].steps[0].status, "failed");
});

test("stopping an observer does not cancel its Run", async () => {
  const services = deterministicServices();
  const entered = deferred();
  const release = deferred();
  const runtime = new Runtime({
    ...services,
    stepPipeline: {
      async execute() {
        entered.resolve();
        await release.promise;
        return { status: "completed", result: "done" };
      },
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const handle = agent.startRun({ scope: "conversation:observer", payload: "task" });
  const observer = new AbortController();
  const observed = collect(agent.observe(handle.runId, { signal: observer.signal }));
  await entered.promise;
  observer.abort();
  await observed;

  assert.equal(runtime.activeRuns()[0].cancelled, false);
  release.resolve();
  assert.equal((await handle.completion).status, "completed");
});

test("reserved follow-up capacity never bypasses the UTF-8 byte limit", async () => {
  const services = deterministicServices();
  const entered = deferred();
  const runtime = new Runtime({
    ...services,
    followUpQueueLimits: { maxEntries: 0, maxBytes: 4 },
    stepPipeline: {
      async execute(input) {
        if (input.snapshot.userTurn.ordinal === 1) {
          entered.resolve();
          await new Promise((resolve) => {
            input.signal.addEventListener("abort", resolve, { once: true });
          });
          return { status: "aborted" };
        }
        return { status: "completed", result: "unexpected" };
      },
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const handle = agent.startRun({ scope: "conversation:bytes", payload: "task" });
  await entered.promise;

  const reserved = agent.control(handle.runId, {
    type: "follow_up",
    id: "reserved",
    payload: "one",
    text: "éé",
    reserveCapacity: true,
  });
  const oversized = agent.control(handle.runId, {
    type: "follow_up",
    id: "oversized",
    payload: "two",
    text: "a",
    reserveCapacity: true,
  });
  assert.equal(reserved.accepted, true);
  assert.equal(oversized.accepted, false);
  assert.equal(oversized.reason, "next_turn_queue_bytes_exceeded");

  agent.control(handle.runId, { type: "abort", reason: "test_complete" });
  assert.equal((await handle.completion).status, "aborted");
});

test("bounded event replay fails explicitly when an observer cursor expires", async () => {
  const stream = new RuntimeEventStream("run-events", 2);
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    stream.publish({
      eventId: `event-${sequence}`,
      occurredAt: `time-${sequence}`,
      transition: { type: `event-${sequence}` },
    });
  }
  stream.close();

  await assert.rejects(
    async () => await collect(stream.observe({ afterSequence: 0 })),
    (error) => error instanceof EventCursorExpiredError &&
      error.earliestAvailable === 2,
  );
  const replay = await collect(stream.observe({ afterSequence: 1 }));
  assert.deepEqual(replay.map((event) => event.sequence), [2, 3]);
  assert.equal(Object.isFrozen(replay[0]), true);
});

test("Runtime snapshots direct definitions, metadata, and queued follow-up payloads", async () => {
  const services = deterministicServices();
  const entered = deferred();
  const release = deferred();
  const executions = [];
  const configuration = { routing: { candidates: ["primary"] } };
  const metadata = { owner: { team: "core" } };
  const initialPayload = { message: { text: "first" } };
  const runtime = new Runtime({
    ...services,
    stepPipeline: {
      async execute(input) {
        executions.push({
          configuration: input.definition.configuration,
          input: input.snapshot.userTurn.input,
        });
        if (input.snapshot.userTurn.ordinal === 1) {
          entered.resolve();
          await release.promise;
        }
        return {
          status: "completed",
          result: input.snapshot.userTurn.input.message.text,
        };
      },
    },
  });
  const handle = runtime.startRun(
    { id: "direct-agent", configuration },
    { scope: "direct", payload: initialPayload, metadata },
  );

  configuration.routing.candidates.push("later");
  metadata.owner.team = "changed";
  initialPayload.message.text = "changed";
  await entered.promise;

  const followUpPayload = { message: { text: "second" } };
  assert.equal(runtime.control("direct-agent", handle.runId, {
    type: "follow_up",
    id: "follow-snapshot",
    payload: followUpPayload,
    text: "second",
  }).accepted, true);
  followUpPayload.message.text = "changed";
  release.resolve();

  const completion = await handle.completion;
  assert.equal(completion.status, "completed");
  assert.deepEqual(executions, [
    {
      configuration: { routing: { candidates: ["primary"] } },
      input: { message: { text: "first" } },
    },
    {
      configuration: { routing: { candidates: ["primary"] } },
      input: { message: { text: "second" } },
    },
  ]);
  assert.deepEqual(completion.snapshot.metadata, {
    owner: { team: "core" },
  });
  assert.equal(Object.isFrozen(executions[0].configuration.routing), true);
  assert.equal(Object.isFrozen(executions[1].input.message), true);
  assert.equal(Object.isFrozen(completion.snapshot.metadata.owner), true);
});

test("a Step output publisher rejects use after its execute call returns", async () => {
  const services = deterministicServices();
  let output;
  const runtime = new Runtime({
    ...services,
    stepPipeline: {
      async execute(input) {
        output = input.output;
        return { status: "completed", result: "done" };
      },
    },
  });
  const handle = runtime.startRun(
    { id: "output-agent" },
    { scope: "output", payload: "task" },
  );
  assert.equal((await handle.completion).status, "completed");

  assert.throws(
    () => output.publishModel({ type: "text_delta", text: "late" }),
    /Step output publisher is no longer active/u,
  );
});

test("a stalled diagnostic observer cannot delay Run completion", async () => {
  const services = deterministicServices();
  const blocked = deferred();
  const runtime = new Runtime({
    ...services,
    observers: [{
      onTransition() {
        return blocked.promise;
      },
    }],
    stepPipeline: {
      async execute() {
        return { status: "completed", result: "done" };
      },
    },
  });
  const handle = runtime.startRun(
    { id: "observer-agent" },
    { scope: "observer-stall", payload: "task" },
  );
  const settled = await Promise.race([
    handle.completion,
    new Promise((resolve) => setImmediate(() => resolve("not-settled"))),
  ]);
  blocked.resolve();

  assert.notEqual(settled, "not-settled");
  assert.equal(settled.status, "completed");
});

test("invalid Step Pipeline results fail through an explicit Runtime contract", async () => {
  const services = deterministicServices();
  const runtime = new Runtime({
    ...services,
    stepPipeline: {
      async execute() {
        return { status: "continue", reason: "missing memory" };
      },
    },
  });
  const completion = await runtime.startRun(
    { id: "invalid-pipeline-agent" },
    { scope: "invalid-pipeline", payload: "task" },
  ).completion;

  assert.equal(completion.status, "failed");
  assert.equal(completion.error.code, "invalid_step_pipeline_result");
  assert.match(completion.error.message, /requires next-Step memory/u);
  assert.equal(completion.snapshot.userTurns[0].steps[0].status, "failed");
});

test("accepted steering at the Step limit fails instead of being dropped", async () => {
  const services = deterministicServices();
  const entered = deferred();
  const release = deferred();
  const runtime = new Runtime({
    ...services,
    maxSteps: 1,
    stepPipeline: {
      async execute() {
        entered.resolve();
        await release.promise;
        return { status: "completed", result: "stale answer" };
      },
    },
  });
  const handle = runtime.startRun(
    { id: "budget-agent" },
    { scope: "steer-at-limit", payload: "task" },
  );
  await entered.promise;
  assert.equal(runtime.control("budget-agent", handle.runId, {
    type: "steer",
    id: "last-step-steer",
    text: "must be considered",
  }).accepted, true);
  release.resolve();

  const completion = await handle.completion;
  assert.equal(completion.status, "failed");
  assert.equal(completion.error.code, "max_steps_exceeded");
  assert.equal(completion.snapshot.userTurns[0].steps[0].status, "completed");
});

test("abort reaches Step snapshot capture before pipeline execution", async () => {
  const services = deterministicServices();
  const entered = deferred();
  let executions = 0;
  const runtime = new Runtime({
    ...services,
    snapshotProvider: {
      async capture(input) {
        entered.resolve();
        if (!input.signal.aborted) {
          await new Promise((resolve) => {
            input.signal.addEventListener("abort", resolve, { once: true });
          });
        }
        return {};
      },
    },
    stepPipeline: {
      async execute() {
        executions += 1;
        return { status: "completed", result: "must not execute" };
      },
    },
  });
  const handle = runtime.startRun(
    { id: "snapshot-agent" },
    { scope: "snapshot-abort", payload: "task" },
  );
  await entered.promise;
  runtime.control("snapshot-agent", handle.runId, {
    type: "abort",
    reason: "stop capture",
  });

  const completion = await handle.completion;
  assert.equal(completion.status, "aborted");
  assert.equal(executions, 0);
  assert.equal(completion.snapshot.userTurns[0].steps[0].status, "aborted");
  assert.equal(completion.snapshot.userTurns[0].status, "aborted");
});

test("initial transition failure releases the Run id and scope", async () => {
  const services = deterministicServices();
  let eventIds = 0;
  const runtime = new Runtime({
    ...services,
    ids: {
      ...services.ids,
      eventId: () => ++eventIds === 1 ? " " : `event-${eventIds}`,
    },
    stepPipeline: {
      async execute() {
        return { status: "completed", result: "done" };
      },
    },
  });

  assert.throws(
    () => runtime.startRun(
      { id: "startup-agent" },
      { scope: "reusable", payload: "first" },
    ),
    /Event id must not be empty/u,
  );
  assert.equal(runtime.activeRuns().length, 0);
  assert.equal(runtime.runForScope("reusable"), undefined);

  const completion = await runtime.startRun(
    { id: "startup-agent" },
    { scope: "reusable", payload: "second" },
  ).completion;
  assert.equal(completion.status, "completed");
});

test("pure transitions reject paths outside the Run-UserTurn-Step hierarchy", () => {
  assert.throws(
    () => createRunState({
      runId: "self-parent",
      agentId: "state-agent",
      scope: "state",
      parentRunId: "self-parent",
      createdAt: "t0",
    }),
    /cannot be its own parent/u,
  );

  let state = createRunState({
    runId: "run-state",
    agentId: "state-agent",
    scope: "state",
    createdAt: "t0",
  });
  state = applyRuntimeTransition(state, { type: "run.started", at: "t1" });
  state = applyRuntimeTransition(state, {
    type: "user_turn.started",
    userTurnId: "turn-state",
    ordinal: 1,
    input: "task",
    at: "t2",
  });
  state = applyRuntimeTransition(state, {
    type: "step.started",
    userTurnId: "turn-state",
    stepId: "step-1",
    ordinal: 1,
    at: "t3",
  });
  state = applyRuntimeTransition(state, {
    type: "step.failed",
    userTurnId: "turn-state",
    stepId: "step-1",
    error: { code: "failed", message: "failed", retryable: false },
    at: "t4",
  });

  assert.throws(
    () => applyRuntimeTransition(state, {
      type: "step.started",
      userTurnId: "turn-state",
      stepId: "step-2",
      ordinal: 2,
      at: "t5",
    }),
    /only after the previous Step completed/u,
  );
  assert.throws(
    () => applyRuntimeTransition(state, {
      type: "user_turn.completed",
      userTurnId: "turn-state",
      result: "invalid",
      at: "t5",
    }),
    /requires a completed Step/u,
  );
  assert.throws(
    () => applyRuntimeTransition(state, {
      type: "run.failed",
      error: { code: "failed", message: "failed", retryable: false },
      at: "t5",
    }),
    /active UserTurn/u,
  );
});
