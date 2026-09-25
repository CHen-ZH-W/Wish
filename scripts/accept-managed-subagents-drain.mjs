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

test("managed Subagents disable drains admitted API work and reconstructs the live child without relaunch", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-subagents-drain-"));
  const captureEntered = Promise.withResolvers(), captureRelease = Promise.withResolvers();
  const owner = { parentAgentId: "wish", parentSessionId: "session", parentRunId: "run", workspaceRoot: directory };
  const executions = new Map();
  let booted, capturing, disabling;
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
    const ctx = booted.surfaceContext, execution = ctx.get("subagentExecution"), launcher = ctx.get("subagentLauncher");
    let launches = 0, stops = 0;
    launcher.resolve = async (_request, identity) => {
      launches += 1;
      return { command: { executable: "fixture-child", cwd: directory }, windowName: "worker",
        resourceManifestDigest: "a".repeat(64), cleanupOnFailure: async () => {} };
    };
    launcher.readResult = async () => undefined;
    execution.start = async request => {
      const target = Object.freeze({ providerId: execution.id, id: request.id, target: `${request.id}:worker.0`,
        attachCommand: `attach ${request.id}`, captureCommand: `capture ${request.id}`, locator: Object.freeze({ id: request.id }) });
      const snapshot = Object.freeze({ target, active: true }); executions.set(request.id, snapshot); return snapshot;
    };
    execution.inspect = async target => executions.get(target.id);
    execution.capture = async request => {
      captureEntered.resolve(); await captureRelease.promise; return `output:${request.target.id}`;
    };
    execution.send = async () => {};
    execution.stop = async target => { stops += 1; executions.delete(target.id); };

    const entryId = "include:subagents-runtime", entry = booted.context.loader.resolve(entryId);
    const previousFiber = entry.fiber, previous = ctx.get("subagents");
    const child = await previous.spawn({ ...owner, task: "Keep the durable child alive", role: "worker" });
    capturing = previous.capture({ ...owner, id: child.id });
    await captureEntered.promise;

    const selection = { instanceId: booted.pluginManagement.snapshot().inspection.instanceId, entryIds: [entryId] };
    const observation = await booted.context.pluginLifecycle.collect(selection);
    const runtimeOwner = observation.owners.find(item => item.fiberId === previousFiber.uid);
    assert.equal(runtimeOwner?.status.disposition, "drain");
    assert.equal(runtimeOwner?.status.code, "subagents_unsettled_records");
    assert.equal(runtimeOwner?.status.counts.active_requests, 1);
    assert.equal(runtimeOwner?.status.counts.live_records, 1);

    const before = booted.pluginManagement.snapshot();
    let settled = false;
    disabling = booted.pluginManagement.change({ requestId: randomUUID(), revision: before.revision,
      preference: "disabled", selection }).finally(() => { settled = true; });
    await until(() => previous.suspended === true &&
      booted.context.pluginChanges.snapshot().active?.phase === "draining", "Subagents admission fence");
    assert.throws(() => previous.list(owner), /closed/i);
    await delay(20);
    assert.equal(settled, false, "disable must wait for the admitted Subagents request");
    assert.equal(executions.get(child.id)?.active, true);

    captureRelease.resolve();
    assert.equal(await capturing, `output:${child.id}`);
    const disabled = await disabling;
    assert.equal(disabled.status, "succeeded", JSON.stringify(disabled));
    assert.equal(entry.fiber, undefined);
    assert.equal(previousFiber.state, 4);
    assert.equal(ctx.get("subagents"), undefined);
    assert.equal(executions.get(child.id)?.active, true, "administrative disable must not kill the child");
    assert.equal(stops, 0);

    const afterDisable = booted.pluginManagement.snapshot();
    const enabled = await booted.pluginManagement.change({ requestId: randomUUID(), revision: afterDisable.revision,
      preference: "enabled", selection: { instanceId: afterDisable.inspection.instanceId, entryIds: [entryId] } });
    assert.equal(enabled.status, "succeeded", JSON.stringify(enabled));
    const successor = ctx.get("subagents");
    assert.notEqual(entry.fiber, previousFiber);
    assert.notEqual(successor, previous);
    assert.equal((await successor.inspect({ ...owner, id: child.id })).target.target, child.target.target);
    assert.equal(launches, 1, "reactivation must reconstruct the durable child instead of spawning it again");
    assert.throws(() => previous.inspect({ ...owner, id: child.id }), /closed/i);

    const stopped = await successor.stop({ ...owner, id: child.id });
    assert.equal(stopped.status, "stopped");
    assert.equal(stops, 1);
    assert.equal(executions.has(child.id), false);
  } finally {
    captureRelease.resolve();
    await Promise.allSettled([capturing, disabling]);
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
