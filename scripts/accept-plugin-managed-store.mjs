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
