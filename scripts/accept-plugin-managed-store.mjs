import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedPluginStore, managementFingerprint } from "../dist/boot/plugin-control/managed-store.js";

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "wish-management-store-"));
  try { await run(join(dir, "preferences.json")); } finally { await rm(dir, { recursive: true, force: true }); }
}
const operation = (overrides = {}) => ({ id: "operation-one", kind: "disable", source: "management", requestId: "request-one",
  entryIds: ["include:feature"], fingerprint: "a".repeat(64), submittedRevision: "initial", phase: "queued", code: null,
  cancellable: true, ...overrides });
test("managed preferences are separate, durable, immutable and single-writer", async () => fixture(async filename => {
  const store = await ManagedPluginStore.open(filename);
  try {
    await assert.rejects(ManagedPluginStore.open(filename), { code: "management_store_locked" });
    const initial = store.snapshot();
    const next = await store.commit(initial.revision, { preferences: { "include:feature": { name: "cordis:feature", preference: "disabled" } }, pending: null, receipts: [] });
    assert.throws(() => { next.preferences["include:feature"].preference = "enabled"; });
    await assert.rejects(store.commit(initial.revision, next), { code: "management_revision_conflict" });
    assert.equal(JSON.parse(await readFile(filename, "utf8")).revision, next.revision);
  } finally { await store.close(); }
  const restored = await ManagedPluginStore.open(filename);
  try { assert.equal(restored.snapshot().preferences["include:feature"].preference, "disabled"); } finally { await restored.close(); }
}));

test("type conversion intents validate both roles and round-trip even when module names are unchanged", async () => fixture(async filename => {
  const store = await ManagedPluginStore.open(filename);
  const intent = { requestId: "configuration:retype", revision: "initial", preference: "inherit",
    selection: { instanceId: "old-root", entryIds: ["include:feature"] },
    configuration: { beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64), changes: [
      { kind: "retype", entryId: "include:feature", beforeName: "cordis:feature", afterName: "cordis:feature", beforeGroup: false, afterGroup: true },
    ] },
  };
  try {
    for (const corrupt of [
      change => { delete change.beforeGroup; },
      change => { delete change.afterGroup; },
      change => { change.beforeGroup = true; },
      change => { change.afterGroup = "true"; },
      change => { change.beforeName = null; },
      change => { change.afterName = null; },
      change => { change.kind = "update"; },
    ]) {
      const pending = structuredClone(intent); corrupt(pending.configuration.changes[0]);
      await assert.rejects(store.commit("initial", { preferences: {}, receipts: [], pending }), { code: "management_store_corrupt" });
    }
    await store.commit("initial", { preferences: {}, receipts: [], pending: intent });
  } finally { await store.close(); }
  const restored = await ManagedPluginStore.open(filename);
  try { assert.deepEqual(restored.snapshot().pending, intent); } finally { await restored.close(); }
}));
test("pending intent survives a new process owner and is not silently committed", async () => fixture(async filename => {
  const store = await ManagedPluginStore.open(filename);
  const request = { requestId: "one", revision: "initial", preference: "disabled", selection: { instanceId: "old-root", entryIds: ["include:feature"] } };
  await store.commit("initial", { preferences: {}, pending: request, receipts: [] });
  await store.close();
  const restored = await ManagedPluginStore.open(filename);
  try { assert.deepEqual(restored.snapshot().pending, request); assert.deepEqual(restored.snapshot().preferences, {}); } finally { await restored.close(); }
}));
test("external edits conflict and malformed management content fails closed", async () => fixture(async filename => {
  const store = await ManagedPluginStore.open(filename);
  try {
    await writeFile(filename, JSON.stringify({ ...store.snapshot(), revision: "external" }));
    await assert.rejects(store.commit("initial", { preferences: {}, pending: null, receipts: [] }), { code: "management_revision_conflict" });
  } finally { await store.close(); }
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, revision: "x", preferences: {}, receipts: [], pending: { code: "execute anything" } }));
  await assert.rejects(ManagedPluginStore.open(filename), { code: "management_store_corrupt" });
  assert.equal(managementFingerprint({ key: "same" }), managementFingerprint({ key: "same" }));
}));
test("a replaced lock is neither written through nor removed by the old owner", async () => fixture(async filename => {
  const store = await ManagedPluginStore.open(filename), lock = `${filename}.lock`;
  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: "replacement-owner" }));
  await assert.rejects(store.commit("initial", { preferences: {}, pending: null, receipts: [] }), { code: "management_store_locked" });
  await assert.rejects(store.close(), { code: "management_store_locked" });
  assert.equal(JSON.parse(await readFile(lock, "utf8")).nonce, "replacement-owner");
}));

test("structural intents validate identities and retain added/removed targets across restart", async () => fixture(async filename => {
  const store = await ManagedPluginStore.open(filename);
  const intent = { requestId: "configuration:one", revision: "initial", preference: "inherit",
    selection: { instanceId: "old-root", entryIds: ["include:old", "include:new", "include:ordered"] },
    configuration: { beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64), changes: [
      { kind: "remove", entryId: "include:old", beforeName: "cordis:old", afterName: null },
      { kind: "add", entryId: "include:new", beforeName: null, afterName: "cordis:new" },
      { kind: "reorder", entryId: "include:ordered", beforeName: "cordis:feature", afterName: "cordis:feature" },
    ] },
  };
  try {
    for (const corrupt of [
      value => { value.configuration.changes[1].entryId = "include:old"; },
      value => { value.configuration.changes[1].entryId = "include:unselected"; },
      value => { value.configuration.changes[0].afterName = "cordis:still-present"; },
      value => { value.configuration.changes[1].kind = "execute"; },
      value => { value.configuration.changes[2].afterName = "cordis:replacement"; },
      value => { value.configuration.beforeDigest = "unknown"; },
      value => { value.preference = "enabled"; },
      value => { value.requestId = "ordinary-ui-request"; },
    ]) {
      const pending = structuredClone(intent); corrupt(pending);
      await assert.rejects(store.commit("initial", { preferences: {}, receipts: [], pending }), { code: "management_store_corrupt" });
      assert.equal(store.snapshot().pending, null);
    }
    await store.commit("initial", { preferences: {}, receipts: [], pending: intent });
  } finally { await store.close(); }
  const restored = await ManagedPluginStore.open(filename);
  try {
    assert.deepEqual(restored.snapshot().pending, intent);
    assert.ok(Object.isFrozen(restored.snapshot().pending.configuration.changes[0]));
  } finally { await restored.close(); }
}));

test("SIGKILL preserves durable intent and only its dead process lock is reclaimed", async () => fixture(async filename => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const source = `import { ManagedPluginStore } from ${JSON.stringify(new URL("../dist/boot/plugin-control/managed-store.js", import.meta.url).href)};
    const store = await ManagedPluginStore.open(process.argv[1]);
    await store.commit('initial', { preferences: {}, receipts: [], pending: { requestId: 'interrupted', revision: 'initial', preference: 'disabled', selection: { instanceId: 'dead-process', entryIds: ['include:feature'] } } });
    process.send('durable'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, filename], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    assert.deepEqual(await once(child, "message"), ["durable", undefined]);
    await assert.rejects(ManagedPluginStore.open(filename), { code: "management_store_locked" });
    const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
    const restored = await ManagedPluginStore.open(filename);
    try {
      assert.equal(restored.snapshot().pending.requestId, "interrupted");
      assert.equal(restored.snapshot().receipts.length, 0);
      await assert.rejects(ManagedPluginStore.open(filename), { code: "management_store_locked" });
    } finally { await restored.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}));

test("unknown, legacy and foreign lock identities are never guessed from a PID", async () => fixture(async filename => {
  for (const identity of [undefined, "foreign-namespace"]) {
    const bytes = JSON.stringify({ pid: 2147483647, nonce: "foreign", identity });
    await writeFile(`${filename}.lock`, bytes);
    await assert.rejects(ManagedPluginStore.open(filename), { code: "management_store_locked" });
    assert.equal(await readFile(`${filename}.lock`, "utf8"), bytes);
  }
}));

test("schema v1 is upgraded in place without changing the configuration revision", async () => fixture(async filename => {
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, revision: "legacy-revision", preferences: {}, pending: null, receipts: [] }));
  const store = await ManagedPluginStore.open(filename);
  try {
    assert.equal(store.snapshot().schemaVersion, 2);
    assert.equal(store.snapshot().revision, "legacy-revision");
    assert.deepEqual(store.snapshot().operations, []);
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), store.snapshot());
  } finally { await store.close(); }
}));

test("operation journal writes serialize with business commits without advancing their revision", async () => fixture(async filename => {
  const store = await ManagedPluginStore.open(filename);
  try {
    await store.recordOperation(operation());
    assert.equal(store.snapshot().revision, "initial");
    await Promise.all([
      store.recordOperation(operation({ phase: "preflight" })),
      store.commit("initial", { preferences: { "include:feature": { name: "cordis:feature", preference: "disabled" } }, pending: null, receipts: [] }),
    ]);
    assert.notEqual(store.snapshot().revision, "initial");
    assert.equal(store.operation("operation-one").phase, "preflight");
    assert.equal(JSON.parse(await readFile(filename, "utf8")).operations[0].phase, "preflight");
  } finally { await store.close(); }
}));

test("restart never replays interrupted operations and classifies them from durable intent", async () => fixture(async filename => {
  const pending = { requestId: "request-with-intent", revision: "initial", preference: "disabled",
    selection: { instanceId: "old-root", entryIds: ["include:feature"] } };
  await writeFile(filename, JSON.stringify({ schemaVersion: 2, revision: "initial", preferences: {}, pending, receipts: [], operations: [
    operation({ id: "safe-interruption", requestId: "request-without-intent", phase: "waiting-safe-point" }),
    operation({ id: "uncertain-interruption", requestId: "request-with-intent", phase: "switching", cancellable: false }),
  ] }));
  const store = await ManagedPluginStore.open(filename);
  try {
    assert.deepEqual(store.operation("safe-interruption"), operation({ id: "safe-interruption", requestId: "request-without-intent",
      phase: "rejected", code: "plugin_change_interrupted", cancellable: false }));
    assert.deepEqual(store.operation("uncertain-interruption"), operation({ id: "uncertain-interruption", requestId: "request-with-intent",
      phase: "recovery-required", code: "management_recovery_required", cancellable: false }));
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).operations, store.snapshot().operations);
  } finally { await store.close(); }
}));

test("SIGKILL after durable acceptance preserves operation identity without replay", async () => fixture(async filename => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const storeUrl = JSON.stringify(new URL("../dist/boot/plugin-control/managed-store.js", import.meta.url).href);
  const coordinatorUrl = JSON.stringify(new URL("../dist/boot/plugin-control/change-coordinator.js", import.meta.url).href);
  const source = `import { Context } from '@deepseek-ai/cordis';
    import { ManagedPluginStore } from ${storeUrl};
    import { installPluginChangeCoordinator } from ${coordinatorUrl};
    const root = new Context(), store = await ManagedPluginStore.open(process.argv[1]);
    const changes = installPluginChangeCoordinator(root);
    changes.attachJournal({ latest: () => store.snapshot().operations.at(-1) ?? null, record: value => store.recordOperation(value) });
    const handle = changes.submit({ kind: 'disable', source: 'management', requestId: 'accepted-before-kill',
      entryIds: ['include:feature'], fingerprint: '${"b".repeat(64)}', submittedRevision: 'initial' }, async () => new Promise(() => {}));
    const accepted = await handle.accepted; process.send(accepted.id); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, filename], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  try {
    const [operationId] = await once(child, "message");
    const durable = JSON.parse(await readFile(filename, "utf8")).operations.find(item => item.id === operationId);
    assert.equal(durable.requestId, "accepted-before-kill");
    assert.ok(["queued", "preflight"].includes(durable.phase));
    const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
    const restored = await ManagedPluginStore.open(filename);
    try {
      assert.deepEqual(restored.operation(operationId), { ...durable, phase: "rejected", code: "plugin_change_interrupted", cancellable: false });
    } finally { await restored.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}));
