import assert from "node:assert/strict";
import test from "node:test";
import { SubagentRuntime } from "../dist/subagents/runtime.js";
import { MemorySubagentRecordStore } from "../dist/subagents/store.js";
import { WorkflowRuntime } from "../dist/workflow/runtime.js";
import { MemoryWorkflowStore } from "../dist/workflow/store.js";
import { ChildWorkflowScheduler } from "../dist/workflow/child-scheduler.js";
import { TaskGraphScheduler } from "../dist/workflow/task-graph-scheduler.js";
import { Context } from "@deepseek-ai/cordis";
import { LocalTmux } from "../dist/tmux/providers/local.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const owner = { parentAgentId: "a", parentSessionId: "s", parentRunId: "r", workspaceRoot: "/workspace" };
function childFixture() {
  const store = new MemorySubagentRecordStore();
  const target = { providerId: "fixture", id: "child", target: "child:worker.0", attachCommand: "attach child", captureCommand: "capture child", locator: {} };
  const execution = { id: "fixture", start: async () => ({ target, active: true }), inspect: async () => ({ target, active: true }),
    capture: async () => "output", send: async () => {}, stop: async () => {} };
  const runtime = new SubagentRuntime({ store, execution, id: () => "child", monitorIntervalMs: 60000,
    launcher: { resolve: async () => ({ command: { executable: "fixture", cwd: "/workspace" } }) } });
  return { runtime, execution, store, target, spawn: () => runtime.spawn({ ...owner, task: "Inspect", role: "worker" }) };
}

test("Subagent refresh cannot overwrite a newer explicit stop", async () => {
  const f = childFixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let inspecting, stopping;
  try {
    await f.spawn(); let calls = 0;
    f.execution.inspect = async () => {
      if (++calls === 1) { entered.resolve(); await release.promise; return { target: f.target, active: false }; }
      return { target: f.target, active: true };
    };
    inspecting = f.runtime.inspect({ ...owner, id: "child" }); await entered.promise;
    stopping = f.runtime.stop({ ...owner, id: "child" });
    await delay(10); release.resolve(); await Promise.all([inspecting, stopping]);
    assert.equal((await f.store.get("child")).status, "stopped");
  } finally { release.resolve(); await Promise.allSettled([inspecting, stopping]); await f.runtime.close(); }
});

test("Subagent close joins admitted capture, seals old references and clears listeners without stopping the terminal", async () => {
  const f = childFixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let capture, closing, closed = false, stops = 0;
  f.execution.stop = async () => { stops++; };
  try {
    await f.spawn(); f.execution.capture = async () => { entered.resolve(); await release.promise; return "retained terminal"; };
    capture = f.runtime.capture({ ...owner, id: "child" }); await entered.promise;
    closing = f.runtime.close(); void closing.then(() => { closed = true; });
    await delay(10); assert.equal(closed, false, "store must remain owned until accepted requests finish");
    assert.equal(f.runtime.close(), closing, "all disposers must join the same close Promise");
    await assert.rejects(f.runtime.list(owner), /closed/i);
    assert.throws(() => f.runtime.subscribe(() => {}), /closed/i);
    release.resolve(); assert.equal(await capture, "retained terminal"); await closing;
    assert.equal(stops, 0);
  } finally { release.resolve(); await Promise.allSettled([capture, closing]); await f.runtime.close(); }
});

test("Subagent close waits for read-only observation but observation does not count itself as execution work", async () => {
  const f = childFixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let observation, closing, closed = false;
  try {
    const list = f.store.list.bind(f.store);
    f.store.list = async () => { entered.resolve(); await release.promise; return list(); };
    observation = f.runtime.lifecycleSnapshot(); await entered.promise;
    closing = f.runtime.close(); void closing.then(() => { closed = true; });
    await delay(10); assert.equal(closed, false);
    release.resolve(); assert.equal((await observation).pendingOperations, 0); await closing;
  } finally { release.resolve(); await Promise.allSettled([observation, closing]); await f.runtime.close(); }
});

test("Subagent close drains a previously queued stop without publishing through old listeners", async () => {
  const f = childFixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const events = []; let capturing, stopping, closing, stops = 0;
  try {
    await f.spawn(); f.runtime.subscribe(event => events.push(event));
    f.execution.capture = async () => { entered.resolve(); await release.promise; return "output"; };
    f.execution.stop = async () => { stops++; };
    capturing = f.runtime.capture({ ...owner, id: "child" }); await entered.promise;
    stopping = f.runtime.stop({ ...owner, id: "child" }); closing = f.runtime.close();
    release.resolve(); await capturing; assert.equal((await stopping).status, "stopped"); await closing;
    assert.equal(stops, 1, "the explicit stop was already accepted; administrative close adds no stop");
    assert.deepEqual(events, []);
  } finally { release.resolve(); await Promise.allSettled([capturing, stopping, closing]); await f.runtime.close(); }
});

const submission = { key: "handoff", kind: "subagent", owner, permissionProfile: "read-only", availableTools: ["read"],
  tasks: [{ id: "task", title: "Inspect", dependencies: [], execution: { role: "worker", readOnly: true, timeoutMs: 60000 } }] };
test("Workflow scheduler close joins accepted submissions and never dispatches from a late callback", async () => {
  const workflow = new WorkflowRuntime(new MemoryWorkflowStore()), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let submitting, closing, closed = false, launches = 0;
  const port = new Proxy(workflow, { get(target, key) {
    if (key === "create") return async request => { entered.resolve(); await release.promise; return target.create(request); };
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  const scheduler = new ChildWorkflowScheduler({ workflow: port, subagents: { spawn: async () => { launches++; }, inspect: async () => undefined } });
  try {
    submitting = scheduler.submit(submission); await entered.promise;
    closing = scheduler.close(); void closing.then(() => { closed = true; });
    await delay(10); assert.equal(closed, false); assert.equal(scheduler.close(), closing);
    await assert.rejects(scheduler.submit({ ...submission, key: "late" }), /closed/i);
    release.resolve(); const prepared = await submitting; await closing;
    assert.equal(launches, 0); assert.equal(prepared.steps[0].attempts.length, 0);
    assert.equal((await workflow.list()).length, 1);
  } finally { release.resolve(); await Promise.allSettled([submitting, closing]); await scheduler.close(); await workflow.close(); }
});

test("Task graph close drains a Plan lookup and prevents a late freeze or submission", async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let freezes = 0, submissions = 0, started, closing, closed = false;
  const graphs = new TaskGraphScheduler({ get: async () => { entered.resolve(); await release.promise; return undefined; } },
    { freeze: async () => { freezes++; } }, { submit: async () => { submissions++; } });
  try {
    started = graphs.start({ owner }); void started.catch(() => {}); await entered.promise;
    closing = Promise.resolve(graphs.close()); void closing.then(() => { closed = true; });
    await delay(10); assert.equal(closed, false);
    release.resolve(); await assert.rejects(started, /closed/i); await closing;
    assert.equal(graphs.lifecycleSnapshot().activeStarts, 0); assert.equal(freezes, 0); assert.equal(submissions, 0);
  } finally { release.resolve(); await Promise.allSettled([started, closing]); await graphs.close(); }
});

test("Workflow state closes all old read and write entrypoints, not only mutations", async () => {
  const runtime = new WorkflowRuntime(new MemoryWorkflowStore()); await runtime.create(submission);
  await runtime.close(); await assert.rejects(runtime.list(), /closed/i); await assert.rejects(runtime.get("missing"), /closed/i);
  await assert.rejects(runtime.create({ ...submission, key: "late" }), /closed/i);
});

test("Workflow close joins pending result lookup and suppresses late parent delivery", async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let closing, closed = false, delivered = 0, releases = 0;
  const scheduler = new ChildWorkflowScheduler({ workflow: { get: async () => {
    entered.resolve(); await release.promise; return { id: "run", status: "completed", steps: [] };
  } }, subagents: {} });
  try {
    scheduler.watch("run", { deferCompletion: () => ({ release: () => { releases++; } }), followUp: () => { delivered++; } });
    await entered.promise; closing = scheduler.close(); void closing.then(() => { closed = true; });
    await delay(10); assert.equal(closed, false); assert.equal(releases, 1);
    release.resolve(); await closing; assert.equal(delivered, 0); assert.equal(releases, 1);
  } finally { release.resolve(); await closing; await scheduler.close(); }
});

test("tmux Provider disposal drains an admitted command and revokes stale API without stopping sessions", async () => {
  const root = new Context(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let capturing, disposing, disposed = false, stops = 0;
  try {
    const fiber = await root.plugin(LocalTmux), previous = root.tmux;
    previous.backend.capture = async () => { entered.resolve(); await release.promise; return "visible output"; };
    previous.backend.stop = async () => { stops++; };
    capturing = previous.capture({}); await entered.promise;
    disposing = fiber.dispose(); void disposing.then(() => { disposed = true; });
    await delay(10); assert.equal(disposed, false);
    await assert.rejects(previous.list(), /closed/i);
    release.resolve(); assert.equal(await capturing, "visible output"); await disposing;
    await root.plugin(LocalTmux); assert.notEqual(root.tmux, previous); assert.equal(stops, 0);
    await assert.rejects(previous.stop({}), /closed/i);
  } finally { release.resolve(); await Promise.allSettled([capturing, disposing]); await root.fiber.dispose(); }
});
