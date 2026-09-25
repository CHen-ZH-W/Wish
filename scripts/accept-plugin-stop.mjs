import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { installPluginLifecycle, registerPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { installPluginStopControl } from "../dist/boot/plugin-control/stop.js";
import { StorageHub } from "../dist/storage/service.js";
import FileStorage from "../dist/storage/providers/file/plugin.js";
import Runtime from "../dist/composition/runtime-service.js";
import Subagents from "../dist/subagents/runtime.js";
import WorkflowSchedulers from "../dist/workflow/providers/schedulers.js";
import WorkflowGraphScheduler from "../dist/workflow/providers/graph-scheduler.js";
import WorkflowContinuations from "../dist/workflow/providers/continuations.js";
import { WorkflowRuntime } from "../dist/workflow/runtime.js";
import { MemoryWorkflowStore } from "../dist/workflow/store.js";
import { PluginWorkOwner } from "../dist/boot/plugin-control/work-owner.js";

const idle = () => ({ disposition: "direct", code: "owner_idle" });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const select = (inspection, ...entryIds) => ({ instanceId: inspection.inspect().instanceId, entryIds });

// This test-only adapter owns a fresh IN-MEMORY Loader, not Include or production config.
// A real managed configuration/recovery lease is deliberately not implemented here.
function memoryHost(root, hooks = {}) {
  let reserved = false;
  return { reserve(impact) {
    assert.equal(reserved, false); reserved = true;
    const entries = impact.selection.entryIds.map(id => root.loader.resolve(id));
    assert.ok(entries.every(entry => entry.parent.tree instanceof Loader));
    const before = entries.map(entry => JSON.stringify(entry.options));
    return {
      current: () => !hooks.conflict?.() && entries.every((entry, i) => root.loader.resolve(entry.id) === entry && JSON.stringify(entry.options) === before[i]),
      async apply() { await hooks.apply?.(); for (const entry of entries) await entry.update({ disabled: true }); await root.loader.await(); },
      verify: async () => hooks.verify ? hooks.verify() : entries.every(entry => entry.disabled),
      async restore() {
        await hooks.restore?.();
        for (const entry of entries) await entry.update({ disabled: true });
        await root.loader.await();
        for (const entry of entries) await entry.update({ disabled: JSON.parse(before[entries.indexOf(entry)]).disabled ?? false });
        await root.loader.await();
      },
      verifyRestored: async () => hooks.verifyRestored ? hooks.verifyRestored() : entries.every(entry => !entry.disabled && entry.fiber?.state === 2),
      release() { reserved = false; hooks.release?.(); },
    };
  } };
}

async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-stop-"));
  const root = new Context();
  try {
    await root.plugin(Loader);
    const inspection = installPluginInspection(root);
    const lifecycle = installPluginLifecycle(root, inspection);
    const stop = installPluginStopControl(root, inspection, {
      ...(options.noHost ? {} : { host: memoryHost(root, options.hooks) }), timeoutMs: options.timeoutMs ?? 1000,
    });
    root.provide("launch", { cwd: directory, homeDirectory: directory, fail() {} });
    Object.assign(root.loader.builtins, { storage: StorageHub, file: FileStorage, runtime: Runtime, subagents: Subagents, schedulers: WorkflowSchedulers, graphScheduler: WorkflowGraphScheduler });
    await run({ root, inspection, lifecycle, stop, directory });
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
}

function reporter(root, name, options = {}) {
  let accepting = true, cleaned = false, closing;
  const state = { preparations: 0, releases: 0, closes: 0, request() { if (!accepting || cleaned) throw new Error("admission_closed"); } };
  root.loader.builtins[name] = { ...(options.inject ? { inject: options.inject } : {}), apply(ctx) {
    if (options.provide) ctx.provide(options.provide, state);
    if (options.inPlaceUpdate) ctx.on("internal/update", () => {});
    registerPluginLifecycle(ctx, options.query ?? idle, options.unsupported ? undefined : () => {
      options.prepare?.();
      state.preparations++; accepting = false;
      return { release() { state.releases++; if (!closing) accepting = true; },
        close() { return closing ??= (async () => { state.closes++; await options.close?.(); cleaned = true; })(); } };
    });
  } };
  return state;
}

test("a draining Consumer can finish calls to its Provider before the Provider admission closes", async () => {
  const continueWork = deferred(); let consumer, provider, cleaned = [];
  await fixture(async ({ root, inspection, stop }) => {
    root.loader.builtins.provider = { apply(ctx) {
      const owner = new PluginWorkOwner(ctx, { code: "provider", close: () => { cleaned.push("provider"); } });
      provider = { request: () => owner.run(() => "provider result") };
      ctx.provide("sample", provider);
    } };
    root.loader.builtins.consumer = { inject: ["sample"], apply(ctx) {
      const owner = new PluginWorkOwner(ctx, { code: "consumer", close: () => { cleaned.push("consumer"); } });
      consumer = () => owner.run(async () => { await continueWork.promise; return ctx.sample.request(); });
    } };
    await root.loader.create({ id: "provider", name: "cordis:provider" });
    await root.loader.create({ id: "consumer", name: "cordis:consumer" });
    const work = consumer();
    const stopping = stop.disable(select(inspection, "provider"));
    try {
      for (let i = 0; i < 10 && stop.current()?.state.phase !== "stopping"; i++) await nextTick();
      assert.equal(stop.current()?.state.phase, "stopping");
      assert.deepEqual(cleaned, []);
      assert.equal(await provider.request(), "provider result");
    } finally { continueWork.resolve(); }
    assert.equal(await work, "provider result");
    assert.equal((await stopping).state.phase, "succeeded");
    assert.deepEqual(cleaned, ["consumer", "provider"]);
    await assert.rejects(provider.request(), /provider_closed/);
  });
});

test("unconfigured Root rejects execution without changing runtime", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const state = reporter(root, "worker"); await root.loader.create({ id: "worker", name: "cordis:worker" });
    const before = inspection.inspect();
    assert.equal((await stop.disable(select(inspection, "worker"))).state.code, "stop_host_unavailable");
    assert.equal(state.preparations, 0); assert.deepEqual(inspection.inspect(), before);
    assert.equal(stop.current(), null);
  }, { noHost: true });
});

test("supported owner fences stale references, confirms cleanup, then really unloads", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const started = deferred(), finish = deferred();
    const state = reporter(root, "worker", { close: async () => { started.resolve(); await finish.promise; } });
    await root.loader.create({ id: "worker", name: "cordis:worker" });
    const selection = select(inspection, "worker"), operation = stop.disable(selection);
    try {
      await Promise.race([started.promise, operation.then(result => { throw new Error(JSON.stringify(result.state)); })]);
      assert.throws(() => state.request(), /admission_closed/);
      assert.equal(stop.current().state.phase, "stopping");
      assert.equal((await stop.disable(selection)).state.code, "stop_operation_in_progress");
      assert.equal(root.loader.resolve("worker").disabled, false);
    } finally { finish.resolve(); }
    const receipt = await operation;
    assert.deepEqual(receipt.state, { phase: "succeeded", runtime: "confirmed", cleanup: "confirmed", persistence: "not-requested" });
    assert.deepEqual({ kind: root.pluginChanges.snapshot().last.kind, source: root.pluginChanges.snapshot().last.source,
      phase: root.pluginChanges.snapshot().last.phase }, { kind: "disable", source: "standalone-stop", phase: "succeeded" });
    assert.equal(state.closes, 1); assert.equal(state.releases, 0);
    assert.throws(() => state.request(), /admission_closed/);
    assert.equal(root.loader.resolve("worker").fiber, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
    assert.throws(() => { receipt.state.phase = "checking"; }, TypeError);
    assert.equal(root.pluginStopControl, stop);
  });
});

test("unknown affected consumer prevents ALL preparation; cleanup follows actual bindings", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const order = [];
    const source = reporter(root, "source", { provide: "source", close: () => { order.push("source"); } });
    reporter(root, "consumer", { inject: ["source"], unsupported: true });
    await root.loader.create({ id: "source", name: "cordis:source" });
    await root.loader.create({ id: "consumer", name: "cordis:consumer" });
    assert.equal((await stop.disable(select(inspection, "source"))).state.code, "stop_owner_unsupported");
    assert.equal(source.preparations, 0);
    await root.loader.remove("consumer");
    reporter(root, "consumer", { inject: ["source"], close: () => { order.push("consumer"); } });
    await root.loader.create({ id: "consumer", name: "cordis:consumer" });
    assert.equal((await stop.disable(select(inspection, "source"))).state.phase, "succeeded");
    assert.deepEqual(order, ["consumer", "source"]);
  });
});

test("busy observation under the fence rejects, releases admission and never cancels work", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    let calls = 0;
    const state = reporter(root, "busy", { query: () => ++calls === 1 ? idle() : { disposition: "blocked", code: "owner_busy" } });
    await root.loader.create({ id: "busy", name: "cordis:busy" });
    const result = await stop.disable(select(inspection, "busy"));
    assert.equal(result.state.code, "stop_lifecycle_blocked");
    assert.equal(result.state.changed, false);
    assert.equal(state.releases, 1); assert.equal(state.closes, 0); state.request();
  });
});

test("config changes during preparation reject before cleanup and restore fences", async () => {
  let conflict = false;
  await fixture(async ({ root, inspection, stop }) => {
    const state = reporter(root, "worker", { prepare() { conflict = true; } });
    await root.loader.create({ id: "worker", name: "cordis:worker" });
    assert.equal((await stop.disable(select(inspection, "worker"))).state.code, "stop_configuration_changed");
    assert.equal(state.closes, 0); state.request();
  }, { hooks: { conflict: () => conflict } });
});

test("same-Fiber in-place update invalidates a prepared stop without reusing its report", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const entered = deferred(), finish = deferred(); let calls = 0;
    const state = reporter(root, "worker", { inPlaceUpdate: true, query: async () => {
      if (++calls === 2) { entered.resolve(); await finish.promise; }
      return idle();
    } });
    await root.loader.create({ id: "worker", name: "cordis:worker" });
    const entry = root.loader.resolve("worker"), uid = entry.fiber.uid;
    const operation = stop.disable(select(inspection, "worker"));
    await entered.promise;
    await entry.fiber.update({ changed: true }, true);
    assert.equal(entry.fiber.uid, uid);
    finish.resolve();
    assert.equal((await operation).state.code, "stop_observation_changed");
    assert.equal(state.closes, 0); state.request();
  });
});

test("Root shutdown interrupts pending cleanup without claiming it completed", async () => {
  const entered = deferred(), finish = deferred();
  await fixture(async ({ root, inspection, stop }) => {
    reporter(root, "worker", { close: async () => { entered.resolve(); await finish.promise; } });
    await root.loader.create({ id: "worker", name: "cordis:worker" });
    const operation = stop.disable(select(inspection, "worker"));
    await entered.promise;
    await root.fiber.dispose();
    const result = await operation;
    assert.equal(result.state.phase, "failed");
    assert.equal(result.state.code, "stop_control_closed");
    assert.equal(result.state.cleanup, "pending");
    finish.resolve(); await nextTick();
  });
});

test("selection is captured before await; caller cannot retarget a pending operation", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const entered = deferred(), finish = deferred();
    const first = reporter(root, "first", { query: async () => { entered.resolve(); await finish.promise; return idle(); } });
    const second = reporter(root, "second");
    for (const id of ["first", "second"]) await root.loader.create({ id, name: `cordis:${id}` });
    const selection = select(inspection, "first"), operation = stop.disable(selection);
    await entered.promise; selection.entryIds[0] = "second"; finish.resolve();
    const result = await operation;
    assert.deepEqual(result.selection.entryIds, ["first"]);
    assert.equal(result.state.phase, "succeeded");
    assert.equal(first.closes, 1); assert.equal(second.preparations, 0); second.request();
  });
});

test("partial batch cleanup never reopens a successfully closed sibling", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const first = reporter(root, "first");
    const second = reporter(root, "second", { close: () => { throw new Error("private-failure"); } });
    for (const id of ["first", "second"]) await root.loader.create({ id, name: `cordis:${id}` });
    const result = await stop.disable(select(inspection, "first", "second"));
    assert.equal(result.state.phase, "failed"); assert.equal(result.state.cleanup, "failed");
    assert.equal(first.closes, 1); assert.equal(second.closes, 1);
    assert.equal(first.releases, 0); assert.equal(second.releases, 0);
    assert.throws(() => first.request()); assert.throws(() => second.request());
    assert.equal(root.loader.resolve("first").disabled, false);
  });
});

test("broken guard rollback is an unknown partial failure, never an unchanged rejection", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    root.loader.builtins.broken = { apply(ctx) {
      registerPluginLifecycle(ctx, () => ({ disposition: "blocked", code: "owner_busy" }), () => ({
        close: async () => { throw new Error("must not close"); }, release() { throw new Error("private-rollback-error"); },
      }));
    } };
    await root.loader.create({ id: "broken", name: "cordis:broken" });
    const selection = select(inspection, "broken");
    const result = await stop.disable(selection);
    assert.deepEqual(result.state, { phase: "failed", code: "stop_admission_uncertain", runtime: "unknown", persistence: "unchanged", cleanup: "unknown" });
    assert.equal((await stop.disable(selection)).state.code, "stop_recovery_required");
  });
});

test("apply timeout retains the writer lease and never promotes a late unload to success", async () => {
  const entered = deferred(), finish = deferred(); let released = 0;
  await fixture(async ({ root, inspection, stop }) => {
    reporter(root, "worker"); await root.loader.create({ id: "worker", name: "cordis:worker" });
    const operation = stop.disable(select(inspection, "worker"));
    await entered.promise;
    const result = await operation;
    assert.equal(result.state.phase, "failed"); assert.equal(result.state.runtime, "unknown");
    assert.equal(result.state.cleanup, "confirmed"); assert.equal(released, 0);
    finish.resolve();
    for (let i = 0; i < 1000 && root.loader.resolve("worker").fiber; i++) await nextTick();
    assert.equal(root.loader.resolve("worker").fiber, undefined);
    assert.equal(stop.current().state.phase, "failed"); assert.equal(released, 0);
  }, { timeoutMs: 20, hooks: { apply: async () => { entered.resolve(); await finish.promise; }, release() { released++; } } });
});

test("cleanup timeout remains queryable and fenced; late settlement never applies or replays", async () => {
  const finish = deferred(); let applies = 0;
  await fixture(async ({ root, inspection, stop }) => {
    const state = reporter(root, "worker", { close: () => finish.promise });
    await root.loader.create({ id: "worker", name: "cordis:worker" });
    const selection = select(inspection, "worker");
    const result = await stop.disable(selection);
    assert.deepEqual(result.state, { phase: "failed", code: "stop_timeout", runtime: "changed", persistence: "unchanged", cleanup: "pending" });
    assert.throws(() => state.request(), /admission_closed/);
    assert.equal(stop.current().id, result.id);
    assert.equal((await stop.disable(selection)).state.code, "stop_recovery_required");
    finish.resolve(); await nextTick();
    assert.equal(applies, 0); assert.equal(state.closes, 1); assert.equal(state.releases, 0);
    assert.equal(stop.current().state.phase, "failed");
  }, { timeoutMs: 20, hooks: { apply() { applies++; } } });
});

test("cleanup failure hides diagnostics and does not equate an unloaded Fiber with success", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const state = reporter(root, "worker", { close() { throw new Error("private-path-and-payload"); } });
    await root.loader.create({ id: "worker", name: "cordis:worker" });
    const result = await stop.disable(select(inspection, "worker"));
    assert.equal(result.state.code, "stop_cleanup_failed"); assert.equal(result.state.cleanup, "failed");
    assert.doesNotMatch(JSON.stringify(result), /private-path/);
    assert.equal(root.loader.resolve("worker").disabled, false); assert.equal(state.releases, 0);
  });
});

test("failed verification after real unload rebuilds and verifies the committed generation", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    reporter(root, "worker"); await root.loader.create({ id: "worker", name: "cordis:worker" });
    const oldFiber = root.loader.resolve("worker").fiber;
    const result = await stop.disable(select(inspection, "worker"));
    assert.notEqual(root.loader.resolve("worker").fiber, oldFiber);
    assert.equal(root.loader.resolve("worker").fiber.state, 2);
    assert.deepEqual(result.state, { phase: "rejected", code: "stop_change_rolled_back", changed: false });
  }, { hooks: { verify: () => false } });
});

test("real Runtime fences admission, drains an active generation, then retires old references", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const started = deferred(), finish = deferred(); let released = 0;
    root.provide("sessions", { acquire() { return { manager: {}, release() {} }; } });
    root.provide("models", { open() { return { configuredModel: {} }; } });
    root.provide("agentLoop", { open() { return { sessions: {}, models: {}, release() { released++; },
      stepPipeline: { async execute() { started.resolve(); await finish.promise; return { status: "complete", memory: {} }; } },
    }; } });
    root.provide("runtimeLifecycle", { openRun() {}, finishRun() {}, openUserTurn() {}, finishUserTurn() {}, openStep() {}, finishStep() {} });
    await root.loader.create({ id: "runtime", name: "cordis:runtime" });
    const service = root.get("runEngine"), resources = service.open({ agentId: "test-agent" });
    const definition = { id: "test-agent", configuration: { agentInstructions: [] } };
    const input = { scope: "test-session", payload: { text: "hello" } };
    const selection = select(inspection, "runtime");
    const running = resources.runtime.startRun(definition, input);
    await started.promise;
    const stopping = stop.disable(selection);
    for (let i = 0; i < 100 && service.suspended !== true; i++) await nextTick();
    assert.equal(service.suspended, true);
    assert.throws(() => service.open({ agentId: "new" }), /admission is closed/);
    assert.equal(released, 0);
    finish.resolve(); await running.completion;
    assert.equal((await stopping).state.phase, "succeeded");
    assert.equal(released, 1, "the admitted Step releases its resources before retirement");
    assert.throws(() => service.open({ agentId: "new" }), /admission is closed/);
    assert.throws(() => resources.runtime.startRun(definition, input), { code: "run_generation_retired" });
  });
});

test("real Storage drain denies new leases, awaits admitted work, closes old facets and preserves data", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    await root.loader.create({ id: "storage", name: "cordis:storage" });
    await root.loader.create({ id: "file", name: "cordis:file" });
    const hub = root.storage, lease = hub.acquire("file"), kv = lease.resolve("file", "kv");
    const operation = stop.disable(select(inspection, "file"));
    try {
      for (let i = 0; i < 1000 && hub.has("file"); i++) await nextTick();
      assert.equal(hub.has("file"), false);
      assert.equal(stop.current().state.phase, "stopping");
      assert.throws(() => hub.acquire("file"));
      assert.throws(() => lease.acquire("file"));
      await kv.put({ namespace: "stop", key: "retained", value: new TextEncoder().encode("kept"), precondition: { kind: "absent" } });
    } finally { lease.release(); }
    const result = await operation;
    assert.equal(result.state.phase, "succeeded");
    await assert.rejects(async () => kv.get({ namespace: "stop", key: "retained" }));
    await root.loader.resolve("file").update({ disabled: false });
    const retained = await root.storage.resolve("file", "kv").get({ namespace: "stop", key: "retained" });
    assert.equal(new TextDecoder().decode(retained.value), "kept");
    await assert.rejects(async () => kv.get({ namespace: "stop", key: "retained" }), undefined, "old generation never reopens");
  });
});

test("real Subagents drains an in-flight launch without stopping tmux, then closes resources and stale API", async () => {
  await fixture(async ({ root, inspection, stop, directory }) => {
    const started = deferred(), finish = deferred(); let stops = 0;
    root.provide("subagentExecution", {
      async start({ id }) { started.resolve(); await finish.promise; return { active: false, exitCode: 0,
        target: { providerId: "fixture", id, target: id, attachCommand: "observe", captureCommand: "capture", locator: {} } }; },
      async inspect() { throw new Error("no process probe expected"); }, async stop() { stops++; },
    });
    root.provide("subagentLauncher", { resolve() { return { command: { executable: "fixture-only", cwd: directory } }; }, async readResult() {} });
    await root.loader.create({ id: "storage", name: "cordis:storage" });
    await root.loader.create({ id: "file", name: "cordis:file" });
    await root.loader.create({ id: "children", name: "cordis:subagents" });
    const service = root.get("subagents"), request = { parentAgentId: "a", parentSessionId: "s", parentRunId: "r", workspaceRoot: directory, task: "inspect" };
    const spawning = service.spawn(request);
    let settled = false;
    const operation = stop.disable(select(inspection, "children", "file")).finally(() => { settled = true; });
    try {
      await started.promise;
      for (let i = 0; i < 1000 && (service.suspended !== true || stop.current().state.phase !== "stopping"); i++) await nextTick();
      assert.equal(service.suspended, true);
      assert.equal(stop.current().state.phase, "stopping");
      assert.throws(() => service.spawn(request), { code: "subagent_closed" });
      await nextTick();
      assert.equal(settled, false, "disable must wait for the admitted launch");
      assert.equal(stops, 0);
    } finally { finish.resolve(); }
    await spawning;
    // Batch uses observed dependency order: child lease releases before File backend closes.
    const result = await operation;
    assert.equal(result.state.phase, "succeeded", JSON.stringify(result.state));
    assert.equal(stops, 0);
    assert.throws(() => service.spawn(request), { code: "subagent_closed" });
    assert.throws(() => service.subscribe(() => {}), { code: "subagent_closed" });
    assert.equal(root.storage.has("file"), false);
  });
});

test("graph Scheduler drains a Plan-waiting start without closing child admission", async () => {
  await fixture(async ({ root, inspection, stop }) => {
    const reading = deferred(), finish = deferred();
    root.provide("workflow", { state: new WorkflowRuntime(new MemoryWorkflowStore()) });
    await root.plugin(WorkflowContinuations);
    root.provide("subagents", { subscribe() { return () => {}; } });
    root.provide("plan", { async get() { reading.resolve(); await finish.promise; return undefined; } });
    for (const key of ["tasks", "permissions", "workspace", "agents"]) root.provide(key, {});
    await root.loader.create({ id: "scheduler", name: "cordis:schedulers" });
    await root.loader.create({ id: "graph-scheduler", name: "cordis:graphScheduler" });
    const { children } = root.get("workflowScheduler"), { graphs } = root.get("workflowGraphScheduler");
    const starting = graphs.start({ owner: { parentSessionId: "s" } });
    const rejected = assert.rejects(starting, /approved Plan/);
    let settled = false;
    const operation = stop.disable(select(inspection, "graph-scheduler")).finally(() => { settled = true; });
    try {
      await reading.promise;
      for (let i = 0; i < 1000 && (graphs.admissionFences.size === 0 || stop.current().state.phase !== "stopping"); i++) await nextTick();
      assert.equal(graphs.admissionFences.size, 1);
      assert.equal(children.admissionFences.size, 0, "accepted graph starts retain child submission until drained");
      assert.equal(graphs.lifecycleSnapshot().activeStarts, 1);
      await assert.rejects(graphs.start({}), /admission is closed/);
      await nextTick();
      assert.equal(settled, false, "disable must wait for the admitted Plan lookup");
    } finally { finish.resolve(); await rejected; }
    assert.equal((await operation).state.phase, "succeeded");
    await assert.rejects(graphs.start({}), /admission is closed/);
    assert.notEqual(root.get("workflowScheduler"), undefined);
    await children.tick(); assert.equal(children.lifecycleSnapshot instanceof Function, true);
  });
});

test("Host stop layer imports no business implementation, storage or transport", async () => {
  for (const file of ["stop.ts", "stop-contract.ts"]) {
    const source = await readFile(new URL(`../src/boot/plugin-control/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*(?:apps|composition|storage|workflow|subagents|skills)\//u);
    assert.doesNotMatch(source, /node:fs|node:http|\.loader\.update|\.update\(\{\s*disabled/u);
  }
});
