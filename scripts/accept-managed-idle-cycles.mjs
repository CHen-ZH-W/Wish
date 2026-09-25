import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right));
}

function flattenEffects(effects, parent = "") {
  return effects.flatMap(effect => {
    const label = /^Run generation wish:[0-9a-f-]+$/u.test(effect.label) ? "Run generation <id>" : effect.label;
    const path = parent ? `${parent} > ${label}` : label;
    return [path, ...flattenEffects(effect.children, path)];
  });
}

function installTimerTracker() {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const active = new Map();
  globalThis.setTimeout = (callback, delay, ...args) => {
    let handle;
    handle = original.setTimeout(function (...values) {
      active.delete(handle);
      return Reflect.apply(callback, this, values);
    }, delay, ...args);
    active.set(handle, `timeout:${delay ?? 0}`);
    return handle;
  };
  globalThis.setInterval = (callback, delay, ...args) => {
    const handle = original.setInterval(callback, delay, ...args);
    active.set(handle, `interval:${delay ?? 0}`);
    return handle;
  };
  globalThis.clearTimeout = handle => { active.delete(handle); return original.clearTimeout(handle); };
  globalThis.clearInterval = handle => { active.delete(handle); return original.clearInterval(handle); };
  return {
    snapshot: () => tally(active.values()),
    restore() {
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
      globalThis.setInterval = original.setInterval;
      globalThis.clearInterval = original.clearInterval;
    },
  };
}

function fingerprint(booted) {
  const snapshot = booted.pluginManagement.snapshot();
  const fibers = new Map(snapshot.inspection.fibers.map(fiber => [fiber.id, fiber]));
  const liveFibers = [booted.context.fiber, ...[...booted.context.registry.values()].flatMap(runtime => [...runtime.fibers])]
    .filter(fiber => fiber.uid !== null);
  const toolsFiber = booted.context.loader.resolve("include:tools").fiber;
  const toolNames = toolsFiber?.ctx.get("tools")?.registry.list().map(tool => tool.name).sort() ?? [];
  assert.equal(new Set(toolNames).size, toolNames.length, "the Tool registry contains duplicate names");
  return {
    activeEntries: snapshot.inspection.entries.filter(entry => entry.phase === "active").map(entry => entry.id).sort(),
    activeFibers: tally(snapshot.inspection.fibers.filter(fiber => fiber.phase === "active")
      .map(fiber => `${fiber.entryId ?? "<programmatic>"}:${fiber.entryRoot ? "root" : "nested"}`)),
    owners: tally(snapshot.owners.map(owner => {
      const fiber = fibers.get(owner.fiberId);
      return `${fiber?.entryId ?? "<programmatic>"}:${owner.lifecycle}:${owner.codeReload}:${owner.replacement}:${owner.declaration}`;
    })),
    effects: tally(liveFibers.flatMap(fiber => {
      const view = fibers.get(fiber.uid);
      const identity = `${view?.entryId ?? "<programmatic>"}:${view?.entryRoot ? "root" : "nested"}`;
      return flattenEffects(fiber.getEffects()).map(effect => `${identity}:${effect}`);
    })),
    toolNames,
  };
}

async function processResources(timers) {
  await nextTurn();
  await nextTurn();
  const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
  const material = new Set(["ChildProcess", "FSWatcher", "Server", "Socket"]);
  const childText = await readFile(`/proc/self/task/${process.pid}/children`, "utf8");
  let fileDescriptors = 0, inotifyWatches = 0;
  for (const fd of await readdir("/proc/self/fd")) {
    let target;
    try { target = await readlink(`/proc/self/fd/${fd}`); }
    catch { continue; }
    if (target !== "anon_inode:inotify") { fileDescriptors++; continue; }
    const info = await readFile(`/proc/self/fdinfo/${fd}`, "utf8");
    const watches = info.match(/^inotify wd:/gmu)?.length ?? 0;
    inotifyWatches += watches;
    // Node/libuv retains one unarmed process-wide inotify backend after the
    // last FSWatcher closes. It is inert and must not look like a plugin FD.
    if (watches > 0) fileDescriptors++;
  }
  return {
    fileDescriptors,
    inotifyWatches,
    childProcesses: childText.trim() ? childText.trim().split(/\s+/u).sort() : [],
    handles: tally(handles.map(handle => handle?.constructor?.name ?? "Unknown").filter(name => material.has(name))),
    listeners: process.eventNames().map(name => [typeof name === "symbol" ? `symbol:${name.description ?? ""}` : name,
      process.listenerCount(name)]).sort(([left], [right]) => left.localeCompare(right)),
    timers: timers.snapshot(),
  };
}

async function storageLeases(booted) {
  const inspection = booted.plugins.inspect();
  const collection = await booted.context.pluginLifecycle.collect({
    instanceId: inspection.instanceId,
    entryIds: ["include:storage-file"],
  });
  const owner = collection.owners.find(item => item.entryId === "include:storage-file" && item.entryRoot);
  assert.ok(owner, "the File Storage lifecycle Owner is missing");
  assert.equal(owner.status.code, owner.status.counts?.leases ? "storage_leases_outstanding" : "storage_idle");
  return owner.status.counts?.leases ?? 0;
}

async function assertReady(booted, baseline, baselineStorageLeases, baselineProcessResources, timers, label) {
  const snapshot = booted.pluginManagement.snapshot();
  assert.equal(snapshot.status, "ready", `${label}: management is not ready`);
  assert.equal(snapshot.pending, null, `${label}: durable intent was not cleared`);
  assert.deepEqual(snapshot.requests, [], `${label}: operation request was retained`);
  assert.deepEqual(snapshot.protocols.filter(protocol => protocol.conformance !== "inactive")
    .filter(protocol => protocol.conformance !== "online"), [], `${label}: managed protocol coverage regressed`);
  assert.deepEqual(fingerprint(booted), baseline, `${label}: active Fiber, Owner, Tool, or Cordis effect registrations did not return to baseline`);
  assert.equal(await storageLeases(booted), baselineStorageLeases, `${label}: Storage leases did not return to baseline`);
  assert.deepEqual(await processResources(timers), baselineProcessResources,
    `${label}: process listeners, timers, handles, children, or file descriptors did not return to baseline`);
}

async function change(booted, entryIds, preference) {
  const before = booted.pluginManagement.snapshot();
  let receipt;
  try {
    receipt = await booted.pluginManagement.change({
      requestId: randomUUID(),
      revision: before.revision,
      preference,
      selection: { instanceId: before.inspection.instanceId, entryIds },
    });
  } catch (cause) {
    const snapshot = booted.pluginManagement.snapshot();
    let lifecycle;
    try {
      const inspection = booted.plugins.inspect();
      const collection = await booted.context.pluginLifecycle.collect({
        instanceId: inspection.instanceId,
        entryIds,
      });
      lifecycle = collection.owners.filter(owner => entryIds.includes(owner.entryId) || owner.status.disposition !== "blocked")
        .map(owner => ({ entryId: owner.entryId, status: owner.status }));
    } catch (diagnosticCause) {
      lifecycle = [{ diagnostic: diagnosticCause instanceof Error ? diagnosticCause.message : String(diagnosticCause) }];
    }
    const diagnostic = {
      change: booted.context.pluginChanges.snapshot().active,
      targets: snapshot.inspection.entries.filter(entry => entryIds.includes(entry.id)),
      lifecycle,
    };
    throw new Error(`${entryIds.join(",")} ${preference}: ${cause instanceof Error ? cause.message : String(cause)}\n${JSON.stringify(diagnostic, null, 2)}`, { cause });
  }
  assert.equal(receipt.status, "succeeded", `${entryIds.join(",")} ${preference}: ${JSON.stringify(receipt)}`);
  return booted.pluginManagement.snapshot();
}

async function runCycle(booted, entryIds, baseline, baselineStorageLeases, baselineProcessResources, timers, label) {
  const entries = entryIds.map(id => booted.context.loader.resolve(id));
  const previous = entries.map(entry => entry.fiber);
  previous.forEach((fiber, index) => assert.ok(fiber, `${label}: ${entryIds[index]} Fiber is missing before disable`));
  const disabled = await change(booted, entryIds, "disabled");
  entries.forEach((entry, index) => {
    assert.equal(entry.fiber, undefined, `${label}: ${entryIds[index]} Fiber remained after disable`);
    assert.equal(previous[index].state, 4, `${label}: ${entryIds[index]} old Fiber was not disposed`);
    assert.deepEqual(previous[index].getEffects(), [], `${label}: ${entryIds[index]} old Fiber retained Cordis effects`);
    assert.equal(disabled.controls[entryIds[index]]?.canEnable, true, `${label}: ${entryIds[index]} cannot be re-enabled`);
  });
  await change(booted, entryIds, "enabled");
  entries.forEach((entry, index) => {
    assert.ok(entry.fiber, `${label}: ${entryIds[index]} successor Fiber is missing`);
    assert.notEqual(entry.fiber, previous[index], `${label}: ${entryIds[index]} old Fiber was reused`);
    assert.equal(entry.fiber.state, 2, `${label}: ${entryIds[index]} successor Fiber is not active`);
  });
  await assertReady(booted, baseline, baselineStorageLeases, baselineProcessResources, timers, label);
}

test("every operable managed WebUI entry survives independent and 100 full-graph cycles without resource growth", { timeout: 900000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-idle-cycles-"));
  const timers = installTimerTracker();
  const beforeBootstrap = await processResources(timers);
  let booted, completed = false;
  try {
    booted = await bootstrap({
      surface: "webui",
      argv: [],
      cwd: directory,
      homeDirectory: directory,
      environment: {
        CORDIS_HMR: "0",
        WISH_DATA_DIR: join(directory, "data"),
        WISH_WEB_FETCH_ENABLED: "1",
        WISH_MEMORY_CURATION_ENABLED: "1",
      },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    // The configuration watcher performs one debounced initial synchronization.
    // Measure the stable Host after that one-shot Cordis timeout has disposed.
    await new Promise(resolve => setTimeout(resolve, 150));
    const baseline = fingerprint(booted);
    const baselineStorageLeases = await storageLeases(booted);
    const baselineProcessResources = await processResources(timers);
    const initial = booted.pluginManagement.snapshot();
    const targets = initial.inspection.entries.filter(entry =>
      entry.managementClass === "managed" && initial.controls[entry.id]?.canDisable === true)
      .map(entry => ({ id: entry.id, impact: booted.plugins.previewDisable(entry.id).affected.length }))
      .sort((left, right) => left.impact - right.impact || left.id.localeCompare(right.id));
    assert.ok(targets.length >= 50, `expected the shipped WebUI graph, received ${targets.length} operable managed entries`);

    const entryIds = targets.map(target => target.id).sort();
    for (let cycleIndex = 1; cycleIndex <= 100; cycleIndex++) {
      await runCycle(booted, entryIds, baseline, baselineStorageLeases, baselineProcessResources, timers,
        `full-graph cycle ${cycleIndex}`);
    }
    for (let independentCycle = 1; independentCycle <= 3; independentCycle++) {
      for (const target of targets) {
        const label = `cycle ${independentCycle} ${target.id}`;
        await runCycle(booted, [target.id], baseline, baselineStorageLeases, baselineProcessResources, timers, label);
      }
    }
    completed = true;
  } finally {
    try {
      await booted?.dispose();
      if (completed) {
        assert.deepEqual(timers.snapshot(), [], "Host disposal retained timers created after bootstrap");
        assert.deepEqual(await processResources(timers), beforeBootstrap, "Host disposal did not restore process resources");
      }
    } finally {
      timers.restore();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
