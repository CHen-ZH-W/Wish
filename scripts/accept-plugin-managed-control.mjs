import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Group from "@deepseek-ai/cordis-plugin-group";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { PluginManagementClassifier } from "../dist/boot/plugin-control/classification.js";
import { installPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { registerPluginOwner } from "../dist/boot/plugin-control/owner-registry.js";
import { ManagedPluginStore } from "../dist/boot/plugin-control/managed-store.js";
import { ManagedProfileSource, managedProfilePlugin } from "../dist/boot/plugin-control/managed-profile.js";
import { ManagedPluginControl } from "../dist/boot/plugin-control/managed-control.js";

const profileText = "# preserve deployment bytes\n- id: app\n  name: cordis:group\n  group: true\n  config:\n    - id: feature\n      name: cordis:feature\n      management:\n        class: managed\n      disabled: !!js launch.blocked\n";
async function start(directory, options = {}) {
  const root = new Context();
  await root.plugin(Loader); root.provide("launch", { blocked: options.blocked ?? false });
  const classifications = new PluginManagementClassifier({ "cordis:group": "structural", "cordis:profile": "kernel", "cordis:feature": "managed" });
  const inspection = installPluginInspection(root, classifications); installPluginLifecycle(root, inspection);
  const store = await ManagedPluginStore.open(join(directory, "managed.json"));
  const control = new ManagedPluginControl(root, inspection, store);
  const source = new ManagedProfileSource(join(directory, "cordis.yml"), "include", store.snapshot(), undefined, classifications);
  const refs = [];
  const feature = {
    apply(ctx) {
      let accepting = true, closed = false;
      const ref = { request() { if (!accepting || closed) throw Error("admission_closed"); }, closes: 0 }; refs.push(ref);
      const close = async () => { ref.closes++; await options.close?.(); closed = true; };
      if (!options.unsupported) {
        const status = () => ({ disposition: options.busy ? "blocked" : "direct", code: options.busy ? "owner_busy" : "owner_idle" });
        const fence = () => { accepting = false; return () => { if (!closed) accepting = true; }; };
        if (options.compatibility) {
          ctx.root.pluginOwners.registerLifecycle(ctx, status, () => ({ close, release: fence() }));
          ctx.root.pluginOwners.registerReplacement(ctx, { prepare: () => ({ drained: Promise.resolve(), release: fence() }) });
        } else registerPluginOwner(ctx, {
          status,
          replacement: "drain",
          prepare: () => ({ drained: Promise.resolve(), deactivate: close, release: fence() }),
        });
      }
      ctx.effect(() => () => { closed = true; });
    },
  };
  Object.assign(root.loader.builtins, { group: Group, profile: managedProfilePlugin(source, profile => control.attach(profile), classifications), feature, external: feature });
  await root.loader.create({ id: "include", name: "cordis:profile" }); await root.loader.await();
  control.setRecoveryAvailable(true);
  return { root, inspection, store, control, refs, async close() { await control.close(); await root.fiber.dispose(); } };
}
const request = (fixture, preference, requestId = randomUUID()) => ({ requestId, revision: fixture.control.snapshot().revision,
  selection: { instanceId: fixture.inspection.inspect().instanceId, entryIds: ["include:feature"] }, preference });
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-control-"));
  try { await writeFile(join(directory, "cordis.yml"), profileText); await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test("real Loader disable/enable cleans and fences old references without rewriting deployment expressions", () => fixture(async directory => {
  const f = await start(directory), events = []; f.control.subscribe(() => events.push(f.control.snapshot().status));
  try {
    const off = request(f, "disabled");
    const receipt = await f.control.change(off);
    assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
    assert.deepEqual({ kind: f.root.pluginChanges.snapshot().last.kind, source: f.root.pluginChanges.snapshot().last.source },
      { kind: "disable", source: "management" });
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    assert.equal(f.refs[0].closes, 1); assert.throws(() => f.refs[0].request(), /admission_closed/);
    assert.deepEqual(await f.control.change(off), receipt);
    await assert.rejects(f.control.change({ ...off, preference: "enabled" }), { code: "management_request_conflict" });
    await assert.rejects(f.control.change({ ...off, requestId: "stale" }), { code: "management_revision_conflict" });
    assert.equal((await f.control.change(request(f, "enabled"))).status, "succeeded");
    assert.deepEqual({ kind: f.root.pluginChanges.snapshot().last.kind, source: f.root.pluginChanges.snapshot().last.source,
      phase: f.root.pluginChanges.snapshot().last.phase }, { kind: "enable", source: "management", phase: "succeeded" });
    assert.equal(f.root.loader.resolve("include:feature").disabled, false);
    assert.equal(f.refs.length, 2); f.refs[1].request();
    assert.deepEqual(f.root.loader.resolve("include:feature").options.disabled, { __jsExpr: "launch.blocked" });
    assert.equal(await readFile(join(directory, "cordis.yml"), "utf8"), profileText);
    assert.ok(events.includes("working")); assert.equal(events.at(-1), "ready");
  } finally { await f.close(); }
}));
test("a deterministic receipt failure restores the previous enabled generation", () => fixture(async directory => {
  const f = await start(directory), original = f.store.commit.bind(f.store);
  try {
    const oldFiber = f.root.loader.resolve("include:feature").fiber;
    let commits = 0;
    f.store.commit = async (...args) => {
      commits++;
      if (commits === 2) throw Object.assign(Error("receipt rejected"), { code: "management_save_failed" });
      return original(...args);
    };
    await assert.rejects(f.control.change(request(f, "disabled")), { code: "management_change_rolled_back" });
    const entry = f.root.loader.resolve("include:feature"), snapshot = f.control.snapshot();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.pending, null);
    assert.deepEqual(snapshot.preferences, {});
    assert.equal(snapshot.lastReceipt.code, "management_change_rolled_back");
    assert.equal(entry.disabled, false);
    assert.notEqual(entry.fiber, oldFiber);
    assert.equal(entry.fiber.state, 2);
    assert.equal(f.refs[0].closes, 1);
    assert.equal(f.refs.length, 2);
    f.refs[1].request();
  } finally { f.store.commit = original; await f.close(); }
}));
test("Host refuses enable when deployment did not delegate activation", () => fixture(async directory => {
  const f = await start(directory, { blocked: true });
  try {
    await assert.rejects(f.control.change(request(f, "enabled")), { code: "management_enable_constrained" });
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    assert.equal(f.refs.length, 0);
    assert.deepEqual(f.control.snapshot().preferences, {});
  } finally { await f.close(); }
}));
test("rejected busy stop persists receipt but not disabled intent, missing recovery prevents writes", () => fixture(async directory => {
  const f = await start(directory, { busy: true });
  try {
    f.control.setRecoveryAvailable(false);
    await assert.rejects(f.control.change(request(f, "disabled")), { code: "management_unavailable" });
    assert.equal(f.store.snapshot().revision, "initial");
    f.control.setRecoveryAvailable(true);
    assert.equal((await f.control.change(request(f, "disabled"))).status, "rejected");
    assert.deepEqual(f.store.snapshot().preferences, {}); assert.equal(f.store.snapshot().pending, null);
    assert.equal(f.refs[0].closes, 0); f.refs[0].request();
  } finally { await f.close(); }
}));
test("active managed entries expose protocol gaps and reject disable before durable intent", () => fixture(async directory => {
  const f = await start(directory, { unsupported: true });
  try {
    const snapshot = f.control.snapshot();
    assert.deepEqual(snapshot.protocols.find(item => item.entryId === "include:feature"), {
      entryId: "include:feature", conformance: "incomplete", stop: "missing", codeUpdate: "missing",
    });
    await assert.rejects(f.control.change(request(f, "disabled")), { code: "management_plugin_nonconformant" });
    assert.equal(f.store.snapshot().revision, "initial");
    assert.equal(f.store.snapshot().pending, null);
    assert.equal(f.root.loader.resolve("include:feature").fiber.state, 2);
  } finally { await f.close(); }
}));
test("managed entries reject split lifecycle/code-reload compatibility declarations", () => fixture(async directory => {
  const f = await start(directory, { compatibility: true });
  try {
    const snapshot = f.control.snapshot();
    const fiberId = snapshot.inspection.entries.find(entry => entry.id === "include:feature").fiberId;
    assert.equal(snapshot.owners.find(owner => owner.fiberId === fiberId).declaration, "compatibility");
    assert.deepEqual(snapshot.protocols.find(item => item.entryId === "include:feature"), {
      entryId: "include:feature", conformance: "incomplete", stop: "missing", codeUpdate: "missing",
    });
    assert.deepEqual(snapshot.controls["include:feature"], {
      managementClass: "managed", canEnable: false, canDisable: false, canReplace: false,
      reason: "management_stop_protocol_missing",
    });
    await assert.rejects(f.control.change(request(f, "disabled")), { code: "management_plugin_nonconformant" });
    assert.equal(f.store.snapshot().pending, null);
    f.refs[0].request();
  } finally { await f.close(); }
}));
test("an undeclared external entry stays noncompliant even when it registers a complete runtime lifecycle", () => fixture(async directory => {
  await writeFile(join(directory, "cordis.yml"), profileText.replace("cordis:feature", "cordis:external").replace("      management:\n        class: managed\n", ""));
  const f = await start(directory);
  try {
    const entry = f.control.snapshot().inspection.entries.find(item => item.id === "include:feature");
    assert.equal(entry.managementClass, "noncompliant");
    assert.equal(f.control.snapshot().protocols.some(item => item.entryId === entry.id), false);
    await assert.rejects(f.control.change(request(f, "disabled")), { code: "management_target_read_only" });
    assert.equal(f.store.snapshot().revision, "initial");
    assert.equal(f.refs[0].closes, 0);
    f.refs[0].request();
  } finally { await f.close(); }
}));
test("incomplete cleanup is quarantined after restart; recovery keeps disabled without replay", () => fixture(async directory => {
  const f = await start(directory, { close: async () => { throw Error("cleanup failed"); } });
  try {
    await assert.rejects(f.control.change(request(f, "disabled")), { code: "management_recovery_required" });
    assert.equal(f.control.snapshot().status, "recovery-required");
    await assert.rejects(f.control.recoverDisabled(f.store.snapshot().revision), { code: "management_restart_required" });
  } finally { await f.close(); }
  const restored = await start(directory);
  try {
    assert.equal(restored.control.snapshot().status, "recovery-required");
    assert.equal(restored.refs.length, 0);
    await restored.control.recoverDisabled(restored.store.snapshot().revision);
    assert.equal(restored.control.snapshot().status, "ready");
    assert.equal(restored.control.snapshot().preferences["include:feature"].preference, "disabled");
    assert.equal(restored.control.snapshot().lastReceipt.code, "management_recovered_disabled");
    assert.equal(restored.refs.length, 0);
  } finally { await restored.close(); }
}));
test("failed intent save does not invoke cleanup; external edits are accepted only by the config coordinator", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const original = f.store.commit.bind(f.store);
    f.store.commit = async () => { throw Object.assign(Error("disk full"), { code: "management_save_failed" }); };
    await assert.rejects(f.control.change(request(f, "disabled")), { code: "management_save_failed" });
    assert.equal(f.refs[0].closes, 0); assert.equal(f.control.snapshot().status, "ready");
    f.store.commit = original;
    const previous = f.control.snapshot().configuration.digest;
    await writeFile(join(directory, "cordis.yml"), `${profileText}\n# external edit\n`);
    assert.equal(f.control.snapshot().configuration.digest, previous);
    await f.control.reloadConfiguration();
    assert.notEqual(f.control.snapshot().configuration.digest, previous);
    assert.equal(f.refs[0].closes, 0);
  } finally { await f.close(); }
}));

test("queued requests deduplicate, can be cancelled, and recheck revision before cleanup", () => fixture(async directory => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await start(directory, { close: () => { entered.resolve(); return release.promise; } });
  try {
    const firstRequest = request(f, "disabled", "first");
    const firstAccepted = await f.control.submit(firstRequest);
    assert.equal((await f.control.submit(firstRequest)).id, firstAccepted.id);
    const first = f.control.change(firstRequest);
    await entered.promise;
    assert.equal(f.control.cancel(firstAccepted.id), false, "cleanup already started");
    const secondRequest = request(f, "enabled", "second");
    const secondAccepted = await f.control.submit(secondRequest);
    const second = f.control.change(secondRequest);
    assert.equal(f.control.snapshot().requests.find(item => item.requestId === "second").phase, "queued");
    assert.equal(f.control.cancel(secondAccepted.id), true);
    await assert.rejects(second, { code: "management_cancelled" });
    const expiredRequest = request(f, "enabled", "expired");
    const expiredAccepted = await f.control.submit(expiredRequest);
    const expired = f.control.change(expiredRequest, { timeoutMs: 10 });
    await assert.rejects(expired, { code: "management_timeout" });
    assert.equal(f.control.operation(expiredAccepted.id).phase, "queued", "caller timeout must not cancel Host work");
    const staleRequest = request(f, "enabled", "stale-queued");
    const stale = f.control.change(staleRequest);
    const staleRejected = assert.rejects(stale, { code: "management_revision_conflict" });
    release.resolve();
    assert.equal((await first).status, "succeeded");
    await staleRejected;
    await f.root.pluginChanges.wait();
    assert.equal(f.control.operation(expiredAccepted.id).code, "management_revision_conflict");
    assert.equal(f.refs[0].closes, 1);
    assert.equal(f.refs.length, 1);
    assert.equal(f.store.snapshot().pending, null);
  } finally { release.resolve(); await f.close(); }
}));
