import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Group from "@deepseek-ai/cordis-plugin-group";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { installPluginLifecycle, registerPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { assessPluginDisable } from "../dist/boot/plugin-control/assessment.js";
import { StorageHub } from "../dist/storage/service.js";
import FileStorage from "../dist/storage/providers/file/plugin.js";
import Runtime from "../dist/composition/runtime-service.js";
import Subagents, { SubagentRuntime } from "../dist/subagents/runtime.js";
import { MemorySubagentRecordStore } from "../dist/subagents/store.js";
import WorkflowSchedulers from "../dist/workflow/providers/schedulers.js";
import WorkflowContinuations from "../dist/workflow/providers/continuations.js";
import { WorkflowRuntime } from "../dist/workflow/runtime.js";
import { MemoryWorkflowStore } from "../dist/workflow/store.js";

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const idle = () => ({ disposition: "direct", code: "owner_idle" });
const select = (inspection, ...entryIds) => ({ instanceId: inspection.inspect().instanceId, entryIds });
const owner = (collection, entryId) => collection.owners.find(item => item.entryId === entryId);

async function fixture(run, options) {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-lifecycle-"));
  const root = new Context();
  let lifecycle;
  try {
    await root.plugin(Loader);
    const inspection = installPluginInspection(root);
    lifecycle = installPluginLifecycle(root, inspection, options);
    root.provide("launch", { cwd: directory, homeDirectory: directory, fail() {} });
    Object.assign(root.loader.builtins, { group: Group, storage: StorageHub, file: FileStorage, runtime: Runtime, subagents: Subagents, schedulers: WorkflowSchedulers });
    await run({ root, inspection, lifecycle, directory });
  } finally {
    await root.fiber.dispose();
    if (lifecycle) await assert.rejects(lifecycle.collect({ instanceId: "old", entryIds: ["old"] }), /closed/);
    await rm(directory, { recursive: true, force: true });
  }
}

test("Root query port binds exact owners, stays read-only, and does not assert Host safety", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    root.loader.builtins.reporter = { apply(ctx) { registerPluginLifecycle(ctx, idle); } };
    await root.loader.create({ id: "reporter", name: "cordis:reporter" });
    const selection = select(inspection, "reporter");
    const before = inspection.inspect();
    const result = await lifecycle.collect(selection);
    assert.equal(owner(result, "reporter").status.code, "owner_idle");
    assert.deepEqual(result.impact.gatedEntryIds, ["reporter"]);
    assert.deepEqual(result.impact.affected.map(item => item.fiberId), [owner(result, "reporter").fiberId]);
    assert.equal(result.reports.length, 2, "Entry and exact root Fiber are separately reported");
    assert.equal(owner(result, "reporter").entryRoot, true);
    assert.ok(result.reports.every(report => report.disposition === "direct"));
    assert.equal(result.coverage, "registered-owners");
    assert.equal(assessPluginDisable(result.observation, selection, result).disposition, "blocked");
    assert.deepEqual(inspection.inspect(), before);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.throws(() => result.impact.gatedEntryIds.push("changed"), TypeError);
    assert.throws(() => { result.owners[0].status.code = "changed"; }, TypeError);
    assert.equal("register" in lifecycle, false);
    assert.equal("disable" in lifecycle, false);
    assert.throws(() => installPluginLifecycle(root, inspection), /already installed/);
    assert.throws(() => root.pluginLifecycle.register(root.loader.resolve("reporter").fiber.ctx, idle), /already registered/);
    const other = new Context();
    try { assert.throws(() => root.pluginLifecycle.register(other, idle), /another Root/); }
    finally { await other.fiber.dispose(); }
  });
});

test("missing, pending and absent owners never inherit a previous report", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    root.loader.builtins.reporter = { inject: ["source"], apply(ctx) { registerPluginLifecycle(ctx, idle); } };
    root.loader.builtins.source = { apply(ctx) { ctx.provide("source", true); } };
    await root.loader.create({ id: "source", name: "cordis:source" });
    await root.loader.create({ id: "reporter", name: "cordis:reporter" });
    const source = root.loader.resolve("source"), entry = root.loader.resolve("reporter");
    const selection = select(inspection, "reporter");
    const first = await lifecycle.collect(selection);
    await source.update({ disabled: true });
    await root.loader.await();
    const pending = await lifecycle.collect(selection);
    assert.equal(pending.owners.length, 0);
    assert.ok(pending.reports.every(report => report.disposition === "blocked"));
    await source.update({ disabled: false });
    await root.loader.await();
    const next = await lifecycle.collect(selection);
    assert.equal(owner(first, "reporter").fiberId, owner(next, "reporter").fiberId);
    assert.notEqual(owner(first, "reporter").registrationId, owner(next, "reporter").registrationId);
    await entry.update({ disabled: true });
    const absent = await lifecycle.collect(selection);
    assert.equal(absent.owners.length, 0);
    assert.equal(absent.reports[0].code, "lifecycle_unassessed");
  });
});

test("a late async report is discarded on same-Fiber reactivation", async () => {
  const started = deferred(), finish = deferred();
  await fixture(async ({ root, inspection, lifecycle }) => {
    root.loader.builtins.reporter = { apply(ctx, config) {
      registerPluginLifecycle(ctx, config.slow ? async () => { started.resolve(); await finish.promise; return { disposition: "direct", code: "obsolete_report" }; } : idle);
    } };
    await root.loader.create({ id: "reporter", name: "cordis:reporter", config: { slow: true } });
    const entry = root.loader.resolve("reporter");
    const selection = select(inspection, "reporter");
    const pending = lifecycle.collect(selection);
    await started.promise;
    try {
      await entry.update({ config: { slow: false } });
      const result = await pending;
      assert.equal(owner(result, "reporter").status.disposition, "blocked");
      assert.doesNotMatch(JSON.stringify(result), /obsolete_report/);
      assert.equal(owner(await lifecycle.collect(selection), "reporter").status.code, "owner_idle");
    } finally { finish.resolve(); }
  });
});

test("accepted in-place config updates also invalidate a concurrent observation", async () => {
  const started = deferred(), finish = deferred();
  await fixture(async ({ root, inspection, lifecycle }) => {
    root.loader.builtins.reporter = { apply(ctx) {
      ctx.on("internal/update", () => {});
      registerPluginLifecycle(ctx, async () => { started.resolve(); await finish.promise; return idle(); });
    } };
    await root.loader.create({ id: "reporter", name: "cordis:reporter", config: { version: 1 } });
    const entry = root.loader.resolve("reporter");
    const pending = lifecycle.collect(select(inspection, "reporter"));
    await started.promise;
    try { await entry.update({ config: { version: 2 } }); }
    finally { finish.resolve(); }
    assert.equal(owner(await pending, "reporter").status.code, "lifecycle_observation_changed");
  });
});

test("nested injection reports do not claim ownership of the entire parent Entry", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    root.provide("source", true);
    root.loader.builtins.nested = { apply(ctx) { ctx.inject(["source"], child => registerPluginLifecycle(child, idle)); } };
    await root.loader.create({ id: "nested", name: "cordis:nested" });
    const result = await lifecycle.collect(select(inspection, "nested"));
    assert.equal(result.owners.length, 1);
    assert.equal(result.owners[0].entryRoot, false);
    assert.equal(result.reports.find(report => report.subject.kind === "entry").disposition, "blocked");
  });
});

test("same-named services in separate realms do not share lifecycle reports", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    root.loader.builtins.source = { apply(ctx, config) {
      ctx.provide("source", true);
      registerPluginLifecycle(ctx, () => ({ ...idle(), counts: { value: config.value } }));
    } };
    for (const [id, value] of [["alpha", 1], ["beta", 2]]) {
      await root.loader.create({ id, name: "cordis:group", group: true, isolate: { source: true }, config: [
        { id: `${id}-source`, name: "cordis:source", config: { value } },
      ] });
    }
    const result = await lifecycle.collect(select(inspection, "alpha-source"));
    assert.equal(result.owners.length, 1);
    assert.equal(result.owners[0].entryId, "alpha-source");
    assert.equal(result.owners[0].status.counts.value, 1);
  });
});

test("query timeout, exception and malformed data fail closed without disclosing payloads", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    const queries = {
      timeout: () => new Promise(() => {}),
      failure: () => { throw new Error("private-token-and-path"); },
      invalid: () => ({ ...idle(), counts: { secret: "private-token-and-path" } }),
      safe: () => ({ ...idle(), privatePayload: "private-token-and-path", counts: { leases: 2 } }),
    };
    for (const [id, query] of Object.entries(queries)) {
      root.loader.builtins[id] = { apply(ctx) { registerPluginLifecycle(ctx, query); } };
      await root.loader.create({ id, name: `cordis:${id}` });
    }
    const result = await lifecycle.collect(select(inspection, ...Object.keys(queries)));
    assert.equal(owner(result, "timeout").status.code, "lifecycle_query_timeout");
    assert.equal(owner(result, "failure").status.code, "lifecycle_query_failed");
    assert.equal(owner(result, "invalid").status.code, "lifecycle_query_invalid");
    assert.deepEqual(owner(result, "safe").status.counts, { leases: 2 });
    assert.doesNotMatch(JSON.stringify(result), /private-token-and-path|privatePayload/);
  }, { queryTimeoutMs: 25 });
});

test("Root disposal cancels collection without waiting for an uncooperative query", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    const started = deferred();
    root.loader.builtins.wait = { apply(ctx) { registerPluginLifecycle(ctx, () => { started.resolve(); return new Promise(() => {}); }); } };
    await root.loader.create({ id: "wait", name: "cordis:wait" });
    const pending = lifecycle.collect(select(inspection, "wait"));
    const rejected = assert.rejects(pending, /closed/);
    await started.promise;
    await root.fiber.dispose();
    await rejected;
  });
});

test("repeated polling cannot multiply a timed-out query that ignores cancellation", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    let calls = 0;
    const finish = deferred();
    root.loader.builtins.slow = { apply(ctx) { registerPluginLifecycle(ctx, async () => { calls += 1; await finish.promise; return idle(); }); } };
    await root.loader.create({ id: "slow", name: "cordis:slow" });
    const selection = select(inspection, "slow");
    try {
      assert.equal(owner(await lifecycle.collect(selection), "slow").status.code, "lifecycle_query_timeout");
      for (let index = 0; index < 3; index += 1) {
        assert.equal(owner(await lifecycle.collect(selection), "slow").status.code, "lifecycle_query_pending");
      }
      assert.equal(calls, 1);
    } finally { finish.resolve(); await nextTick(); }
    assert.equal(owner(await lifecycle.collect(selection), "slow").status.code, "owner_idle");
    assert.equal(calls, 2);
  }, { queryTimeoutMs: 10 });
});

test("real File Provider reports generation-local leases and survives replacement without data loss", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    await root.loader.create({ id: "storage", name: "cordis:storage" });
    await root.loader.create({ id: "file", name: "cordis:file" });
    const entry = root.loader.resolve("file");
    const selection = select(inspection, "file");
    const before = await lifecycle.collect(selection);
    assert.equal(owner(before, "file").status.code, "storage_idle");
    const lease = root.storage.acquire("file");
    try {
      await lease.resolve("file", "kv").put({ namespace: "lifecycle", key: "retained", value: new TextEncoder().encode("kept"), precondition: { kind: "absent" } });
      const busy = await lifecycle.collect(selection);
      assert.equal(owner(busy, "file").status.disposition, "drain");
      assert.equal(owner(busy, "file").status.counts.leases, 1);
      assert.equal(lease.released, false);
      assert.equal(root.storage.has("file"), true);
    } finally { lease.release(); }
    await entry.update({ disabled: true });
    assert.equal((await lifecycle.collect(selection)).owners.length, 0);
    await entry.update({ disabled: false });
    const restored = await lifecycle.collect(selection);
    assert.notEqual(owner(restored, "file").registrationId, owner(before, "file").registrationId);
    assert.equal(owner(restored, "file").status.code, "storage_idle");
    const stored = await root.storage.resolve("file", "kv").get({ namespace: "lifecycle", key: "retained" });
    assert.equal(new TextDecoder().decode(stored.value), "kept");
  });
});

test("real Runtime Provider counts active Runs without aborting them", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    const started = deferred(), finish = deferred();
    root.provide("sessions", { acquire() { return { manager: {}, release() {} }; } });
    root.provide("models", { open() { return { configuredModel: {} }; } });
    root.provide("agentLoop", { open() { return {
      sessions: {}, models: {}, release() {},
      stepPipeline: { async execute() { started.resolve(); await finish.promise; return { status: "complete", memory: {} }; } },
    }; } });
    root.provide("runtimeLifecycle", { openRun() {}, finishRun() {}, openUserTurn() {}, finishUserTurn() {}, openStep() {}, finishStep() {} });
    await root.loader.create({ id: "runtime", name: "cordis:runtime" });
    const service = root.get("runEngine");
    const resources = service.open({ agentId: "private-agent" });
    const handle = resources.runtime.startRun({ id: "private-agent", configuration: { agentInstructions: [] } },
      { scope: "private-session", payload: { text: "private-input" } });
    try {
      await started.promise;
      const result = await lifecycle.collect(select(inspection, "runtime"));
      assert.equal(owner(result, "runtime").status.code, "runtime_active_runs");
      assert.equal(owner(result, "runtime").status.counts.active_runs, 1);
      assert.equal(resources.generation.snapshot().activeRuns[0].abortRequested, false);
      assert.doesNotMatch(JSON.stringify(result), /private-agent|private-session|private-input/);
    } finally { finish.resolve(); await handle.completion; }
    assert.equal(owner(await lifecycle.collect(select(inspection, "runtime")), "runtime").status.code, "runtime_idle");
    await resources.generation.retire();
    assert.equal(service.lifecycleSnapshot().generations, 0);
  });
});

test("real Subagents Provider observes starting records without probing processes or changing them", async () => {
  await fixture(async ({ root, inspection, lifecycle, directory }) => {
    const started = deferred(), finish = deferred();
    let processQueries = 0, stops = 0;
    root.provide("subagentExecution", {
      async start({ id }) { started.resolve(); await finish.promise; return { active: false, exitCode: 0,
        target: { providerId: "fixture", id, target: id, attachCommand: "observe", captureCommand: "capture", locator: {} } }; },
      async inspect() { processQueries += 1; },
      async stop() { stops += 1; },
    });
    root.provide("subagentLauncher", { resolve() { return { command: { executable: "fixture-only", cwd: directory } }; }, async readResult() {} });
    await root.loader.create({ id: "storage", name: "cordis:storage" });
    await root.loader.create({ id: "file", name: "cordis:file" });
    await root.loader.create({ id: "children", name: "cordis:subagents" });
    const service = root.get("subagents");
    const spawning = service.spawn({ parentAgentId: "private-parent", parentSessionId: "private-session", parentRunId: "private-run", workspaceRoot: directory, task: "private-task" });
    try {
      await started.promise;
      const result = await lifecycle.collect(select(inspection, "children"));
      const status = owner(result, "children").status;
      assert.equal(status.code, "subagents_unsettled_records");
      assert.equal(status.counts.pending_operations, 1);
      assert.equal(status.counts.live_records, 1);
      assert.equal(processQueries, 0);
      assert.equal(stops, 0);
      assert.doesNotMatch(JSON.stringify(result), /private-parent|private-session|private-run|private-task/);
    } finally { finish.resolve(); await spawning; }
    assert.equal(owner(await lifecycle.collect(select(inspection, "children")), "children").status.code, "subagents_idle");
  });
});

test("real Workflow Scheduler query reads durable facts without dispatching or reconciling", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    await root.plugin(WorkflowContinuations);
    const workflow = new WorkflowRuntime(new MemoryWorkflowStore());
    let launches = 0;
    root.provide("workflow", { state: workflow });
    root.provide("subagents", { subscribe() { return () => {}; }, async spawn() { launches += 1; throw new Error("unexpected dispatch"); } });
    for (const key of ["plan", "tasks", "permissions", "workspace", "agents"]) root.provide(key, {});
    await root.loader.create({ id: "scheduler", name: "cordis:schedulers" });
    await nextTick();
    const run = await workflow.create({ key: "private-key", kind: "subagent",
      owner: { parentAgentId: "private-agent", parentSessionId: "private-session", parentRunId: "private-run", workspaceRoot: "/private-root" },
      permissionProfile: "read-only", availableTools: [], tasks: [{ id: "one", title: "private-title", dependencies: [], execution: { role: "worker", readOnly: true, timeoutMs: 1000 } }] });
    await workflow.block(run.id, "private-block-reason");
    const before = await workflow.get(run.id);
    const result = await lifecycle.collect(select(inspection, "scheduler"));
    assert.equal(owner(result, "scheduler").status.code, "workflow_unsettled_work");
    assert.equal(owner(result, "scheduler").status.counts.unsettled_runs, 1);
    assert.deepEqual(await workflow.get(run.id), before);
    assert.equal(launches, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-agent|private-session|private-title|private-block-reason|private-root/);
  });
});

test("a failed child launch without a recorded target remains unresolved, not idle", async () => {
  let inspections = 0;
  const backend = new SubagentRuntime({ store: new MemorySubagentRecordStore(),
    execution: { async start() { throw new Error("launch uncertainty"); }, async inspect() { inspections += 1; } },
    launcher: { resolve() { return { command: { executable: "fixture-only", cwd: "/workspace" } }; } },
  });
  try {
    await assert.rejects(backend.spawn({ parentAgentId: "a", parentSessionId: "s", parentRunId: "r", workspaceRoot: "/workspace", task: "inspect" }), /launch uncertainty/);
    const snapshot = await backend.lifecycleSnapshot();
    assert.equal(snapshot.liveRecords, 0);
    assert.equal(snapshot.pendingOperations, 0);
    assert.equal(snapshot.unresolvedRecords, 1);
    assert.equal(inspections, 0);
  } finally { await backend.close(); }
});

test("a graph start waiting on Plan is visible before it creates any Workflow", async () => {
  await fixture(async ({ root, inspection, lifecycle }) => {
    await root.plugin(WorkflowContinuations);
    const reading = deferred(), finish = deferred();
    root.provide("workflow", { state: new WorkflowRuntime(new MemoryWorkflowStore()) });
    root.provide("subagents", { subscribe() { return () => {}; } });
    root.provide("plan", { async get() { reading.resolve(); await finish.promise; return undefined; } });
    for (const key of ["tasks", "permissions", "workspace", "agents"]) root.provide(key, {});
    await root.loader.create({ id: "scheduler", name: "cordis:schedulers" });
    const starting = root.get("workflowScheduler").graphs.start({ owner: { parentSessionId: "private" } });
    const rejected = assert.rejects(starting, /approved Plan/);
    try {
      await reading.promise;
      const status = owner(await lifecycle.collect(select(inspection, "scheduler")), "scheduler").status;
      assert.equal(status.disposition, "blocked");
      assert.equal(status.counts.active_graph_starts, 1);
      assert.equal(status.counts.unsettled_runs, 0);
    } finally { finish.resolve(); await rejected; }
    assert.equal(root.get("workflowScheduler").graphs.lifecycleSnapshot().activeStarts, 0);
  });
});

test("bootstrap exposes production lifecycle collection and unregistered modules stay unassessed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-lifecycle-boot-"));
  let app;
  try {
    await writeFile(join(directory, "surface.mjs"), "export function apply() {}\n");
    await writeFile(join(directory, "cordis.yml"), "- id: storage\n  name: cordis:storage\n- id: file\n  name: cordis:storage-file\n- id: cli\n  name: ./surface.mjs\n");
    app = await bootstrap({ surface: "cli", cwd: directory, homeDirectory: directory, environment: {}, configurationFile: "cordis.yml" });
    const selection = select(app.plugins, "include:file");
    assert.equal((await app.pluginStops.disable(selection)).state.code, "stop_host_unavailable");
    assert.equal(owner(await app.pluginLifecycle.collect(selection), "include:file").status.code, "storage_idle");
    const unknown = await app.pluginLifecycle.collect(select(app.plugins, "include:cli"));
    assert.ok(unknown.reports.every(report => report.code === "lifecycle_unassessed"));
    await app.context.loader.resolve("include:file").update({ disabled: true });
    assert.equal((await app.pluginLifecycle.collect(selection)).owners.length, 0);
  } finally { await app?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("the collector imports no business implementations and public protocols import no Host runtime", async () => {
  const collector = await readFile(new URL("../src/boot/plugin-control/lifecycle.ts", import.meta.url), "utf8");
  assert.doesNotMatch(collector, /from ["'][^"']*(?:apps|composition|storage|workflow|subagents|skills)\//u);
  const protocol = await readFile(new URL("../src/boot/plugin-control/management-types.ts", import.meta.url), "utf8");
  assert.doesNotMatch(protocol, /@deepseek|node:|Context|AbortSignal/u);
});
