import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(10);
  }
}

test("managed Workflow Scheduler disable drains a tick and hands the same Attempt to its successor", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-workflow-drain-"));
  const inspectEntered = Promise.withResolvers(), inspectRelease = Promise.withResolvers();
  let booted, ticking, disabling;
  try {
    booted = await bootstrap({
      surface: "webui",
      cwd: directory,
      homeDirectory: directory,
      environment: {
        CORDIS_HMR: "0",
        WISH_DATA_DIR: join(directory, "data"),
        WISH_MEMORY_ENABLED: "0",
        WISH_SKILLS_ENABLED: "0",
        WISH_SUBAGENT_TOOLS_ENABLED: "0",
      },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    const ctx = booted.surfaceContext;
    const entryId = "include:workflow-schedulers", entry = booted.context.loader.resolve(entryId);
    const previousFiber = entry.fiber, previous = ctx.get("workflowScheduler");
    const continuations = ctx.get("workflowContinuations"), continuationFiber = booted.context.loader.resolve("include:workflow-continuations").fiber;
    const state = ctx.get("workflow").state, subagents = ctx.get("subagents");
    const owner = { parentAgentId: "wish", parentSessionId: "session", parentRunId: "parent", workspaceRoot: directory };

    const resumeSeed = previous.children.suspendAdmission();
    let run, attempt;
    try {
      run = await state.create({ key: "managed-workflow-drain", kind: "subagent", owner,
        permissionProfile: "read-only", availableTools: ["read"], tasks: [{ id: "one", title: "Keep the child",
          dependencies: [], execution: { role: "worker", readOnly: true, timeoutMs: 60000 } }] });
      attempt = await state.beginAttempt({ runId: run.id, stepId: "one", strategy: "initial" });
      const target = { runId: run.id, stepId: "one", attemptId: attempt.id };
      await state.markDispatched(target);
      await state.bindChild(target, "durable-child");
    } finally { resumeSeed(); }

    let child = { id: "durable-child", status: "running", target: { providerId: "fixture", id: "durable-child",
      target: "durable-child:worker.0", attachCommand: "attach", captureCommand: "capture", locator: {} } };
    let spawns = 0, stops = 0, inspections = 0;
    subagents.spawn = async () => { spawns += 1; throw new Error("existing Attempt must not dispatch again"); };
    subagents.inspect = async () => { inspections += 1; inspectEntered.resolve(); await inspectRelease.promise; return child; };
    subagents.stop = async () => { stops += 1; };

    const parent = { holds: 0, releases: 0, messages: [], deferCompletion() {
      this.holds += 1; return { release: () => { this.releases += 1; } };
    }, followUp(message) { this.messages.push(message); return { accepted: true }; } };
    previous.children.watch(run.id, parent, undefined, "parent-run");
    assert.equal(continuations.state.size, 1);
    ticking = previous.children.tick();
    await inspectEntered.promise;

    const selection = { instanceId: booted.pluginManagement.snapshot().inspection.instanceId, entryIds: [entryId] };
    const observation = await booted.context.pluginLifecycle.collect(selection);
    const schedulerOwner = observation.owners.find(item => item.fiberId === previousFiber.uid);
    assert.equal(schedulerOwner?.status.disposition, "drain");
    assert.equal(schedulerOwner?.status.code, "workflow_unsettled_work");
    assert.equal(schedulerOwner?.status.counts.unsettled_runs, 1);
    assert.equal(schedulerOwner?.status.counts.active_attempts, 1);
    assert.equal(schedulerOwner?.status.counts.waiting_parents, 1);
    assert.ok(schedulerOwner?.status.counts.pending_ticks >= 1);

    const before = booted.pluginManagement.snapshot();
    let settled = false;
    disabling = booted.pluginManagement.change({ requestId: randomUUID(), revision: before.revision,
      preference: "disabled", selection }).finally(() => { settled = true; });
    await until(() => previous.children.admissionFences.size > 0 &&
      booted.context.pluginChanges.snapshot().active?.phase === "draining", "Workflow Scheduler admission fences");
    await assert.rejects(previous.children.submit({}), /admission is closed/);
    await delay(20);
    assert.equal(settled, false, "disable must wait for the admitted scheduler tick");
    assert.equal(continuations.state.size, 1);
    assert.equal(parent.releases, 0);
    assert.equal(stops, 0);

    inspectRelease.resolve();
    await ticking;
    const disabled = await disabling;
    assert.equal(disabled.status, "succeeded", JSON.stringify(disabled));
    assert.equal(entry.fiber, undefined);
    assert.equal(previousFiber.state, 4);
    assert.equal(ctx.get("workflowScheduler"), undefined);
    assert.equal((await state.get(run.id)).steps[0].attempts[0].childId, "durable-child");
    assert.equal(continuations.state.size, 1, "scheduler disable must retain the parent hold");
    assert.equal(booted.context.loader.resolve("include:workflow-continuations").fiber, continuationFiber);
    assert.equal(spawns, 0);
    assert.equal(stops, 0);
    await assert.rejects(previous.children.submit({}), /closed/i);

    const afterDisable = booted.pluginManagement.snapshot();
    const enabled = await booted.pluginManagement.change({ requestId: randomUUID(), revision: afterDisable.revision,
      preference: "enabled", selection: { instanceId: afterDisable.inspection.instanceId, entryIds: [entryId] } });
    assert.equal(enabled.status, "succeeded", JSON.stringify(enabled));
    const successor = ctx.get("workflowScheduler");
    assert.notEqual(entry.fiber, previousFiber);
    assert.notEqual(successor, previous);
    assert.equal(continuations.state.size, 1);
    assert.equal(spawns, 0, "reactivation must reconcile the bound child instead of dispatching another one");
    assert.ok(inspections >= 2, "the successor must inspect the durable Attempt");

    child = { ...child, status: "stopped", result: { status: "completed", text: "verified successor result" } };
    await successor.children.tick();
    const completed = await state.get(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[0].attempts[0].id, attempt.id);
    assert.equal(completed.steps[0].attempts[0].result, "verified successor result");
    assert.equal(spawns, 0);
    assert.equal(stops, 0);
    assert.equal(continuations.state.size, 0);
    assert.equal(parent.releases, 1);
    assert.equal(parent.messages.length, 1);
  } finally {
    inspectRelease.resolve();
    await Promise.allSettled([ticking, disabling]);
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
