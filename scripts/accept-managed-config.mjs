import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Group from "@deepseek-ai/cordis-plugin-group";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { installPluginLifecycle, registerPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { ManagedPluginStore, ManagedPluginStoreError } from "../dist/boot/plugin-control/managed-store.js";
import { ManagedProfileSource, managedProfilePlugin } from "../dist/boot/plugin-control/managed-profile.js";
import { ManagedPluginControl } from "../dist/boot/plugin-control/managed-control.js";
import { startManagedConfigurationWatch } from "../dist/boot/plugin-control/config-watch.js";

function deployment(value = 1, disabled = false, inject = [], management) {
  const feature = { id: "feature", name: "cordis:feature", disabled, inject, config: { value }, ...(management === undefined ? {} : { management }) };
  return JSON.stringify([{ id: "app", name: "cordis:group", group: true, config: [
    feature,
  ] }]);
}
async function start(directory, options = {}) {
  const root = new Context();
  await root.plugin(Loader);
  const inspection = installPluginInspection(root); installPluginLifecycle(root, inspection);
  const store = await ManagedPluginStore.open(join(directory, "managed.json"));
  const control = new ManagedPluginControl(root, inspection, store);
  const refs = [];
  root.loader.builtins.group = Group;
  root.loader.builtins.feature = {
    apply(ctx, config) {
      if (config.value === "invalid") throw Error("invalid feature config");
      if (config.value === "async-invalid") return Promise.resolve().then(() => { throw Error("async feature activation failed"); });
      let accepting = true, closed = false;
      const ref = { value: config.value, closes: 0, request() { if (!accepting || closed) throw Error("closed"); return config.value; } };
      refs.push(ref);
      const close = async () => { ref.closes++; await options.close?.(); closed = true; };
      registerPluginLifecycle(ctx, () => ({ disposition: options.busy ? "blocked" : "direct", code: options.busy ? "owner_busy" : "owner_idle" }),
        () => { accepting = false; return { close, release() { if (!closed) accepting = true; } }; });
      ctx.effect(() => () => { closed = true; });
    },
  };
  const filename = join(directory, "cordis.yml");
  root.loader.builtins.profile = managedProfilePlugin(new ManagedProfileSource(filename, "include", store.snapshot()), profile => control.attach(profile));
  await root.loader.create({ id: "include", name: "cordis:profile" }); await root.loader.await();
  control.setRecoveryAvailable(true);
  return { root, control, store, refs, filename,
    change(preference, requestId = randomUUID(), revision = control.snapshot().revision) {
      return control.change({ requestId, revision, preference, selection: { instanceId: inspection.inspect().instanceId, entryIds: ["include:feature"] } });
    },
    async close() { await control.close(); await root.fiber.dispose(); },
  };
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-config-"));
  try { await writeFile(join(directory, "cordis.yml"), deployment()); await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const deferred = () => Promise.withResolvers();

test("declared user activation overrides only the default-off gate and remains constrained by deployment", async () => {
  await fixture(async directory => {
    await writeFile(join(directory, "cordis.yml"), deployment(1, true, [], { activation: "user", constraint: false }));
    let f = await start(directory);
    try {
      assert.deepEqual(f.control.snapshot().controls["include:feature"], { canEnable: true });
      assert.equal(f.root.loader.resolve("include:feature").fiber, undefined);
      assert.equal("management" in f.root.loader.resolve("include:feature").options, false);
      assert.equal((await f.change("enabled")).status, "succeeded");
      assert.equal(f.refs.at(-1).request(), 1);
      await f.close(); f = undefined;
      f = await start(directory);
      assert.equal(f.control.snapshot().preferences["include:feature"].preference, "enabled");
      assert.equal(f.root.loader.resolve("include:feature").disabled, false);
      assert.equal(f.refs.at(-1).request(), 1);
      assert.equal((await f.change("disabled")).status, "succeeded");
      assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    } finally { await f?.close(); }
  });
  await fixture(async directory => {
    await writeFile(join(directory, "cordis.yml"), deployment(1, true, [], { activation: "user", constraint: true }));
    const f = await start(directory);
    try {
      assert.deepEqual(f.control.snapshot().controls["include:feature"], { canEnable: false });
      await assert.rejects(f.change("enabled"), { code: "management_enable_constrained" });
      assert.deepEqual(f.control.snapshot().preferences, {});
    } finally { await f.close(); }
  });
});

test("deployment reload preserves disabled preferences and latest configuration; enabled cannot bypass a new deployment gate", () => fixture(async directory => {
  const f = await start(directory);
  try {
    await f.change("disabled");
    await writeFile(f.filename, deployment(2));
    await f.control.reloadConfiguration();
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    assert.equal(f.refs.length, 1);
    assert.equal(f.control.snapshot().preferences["include:feature"].preference, "disabled");
    await f.change("enabled");
    assert.equal(f.refs.at(-1).request(), 2);
    await writeFile(f.filename, deployment(3, true));
    await f.control.reloadConfiguration();
    assert.equal(f.control.snapshot().preferences["include:feature"].preference, "enabled");
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    await f.change("enabled");
    assert.equal(f.refs.length, 2);
    await writeFile(f.filename, deployment(3));
    await f.control.reloadConfiguration();
    assert.equal(f.refs.at(-1).request(), 3);
    assert.equal(f.control.snapshot().configuration.phase, "idle");
    assert.equal(await readFile(f.filename, "utf8"), deployment(3));
  } finally { await f.close(); }
}));

test("invalid YAML or identity changes keep the last accepted revision and live owners", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const digest = f.control.snapshot().configuration.digest;
    await writeFile(f.filename, "[bad: [");
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_invalid" });
    assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.equal(f.control.snapshot().configuration.phase, "rejected");
    assert.equal(f.control.snapshot().pending, null);
    assert.equal(f.refs[0].closes, 0); assert.equal(f.refs[0].request(), 1);
    await writeFile(f.filename, deployment().replace('"id":"feature"', '"id":"renamed"'));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_profile_structure_changed" });
    assert.equal(f.refs[0].closes, 0);
    await writeFile(f.filename, deployment()); await f.control.reloadConfiguration();
    assert.equal(f.control.snapshot().configuration.phase, "idle");
    assert.equal(f.refs.length, 1);
  } finally { await f.close(); }
}));

test("file reload waits for a UI transaction and recomposes its saved preference; concurrent UI writes and stale revisions reject", () => fixture(async directory => {
  const entered = deferred(), release = deferred();
  const f = await start(directory, { close: async () => { entered.resolve(); await release.promise; } });
  try {
    const revision = f.control.snapshot().revision;
    const off = f.change("disabled"); await entered.promise;
    await writeFile(f.filename, deployment(2));
    const reload = f.control.reloadConfiguration();
    await assert.rejects(f.change("enabled"), { code: "management_busy" });
    release.resolve(); await off; await reload;
    assert.equal(f.refs.length, 1);
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    assert.equal(f.control.snapshot().preferences["include:feature"].preference, "disabled");
    await assert.rejects(f.change("enabled", "stale-request", revision), { code: "management_revision_conflict" });
    await f.change("enabled"); assert.equal(f.refs.at(-1).request(), 2);
  } finally { release.resolve(); await f.close(); }
}));

test("a busy owner rejects config replacement without abort or cleanup; retry is explicit", () => fixture(async directory => {
  const options = { busy: true }, f = await start(directory, options);
  try {
    const digest = f.control.snapshot().configuration.digest;
    await writeFile(f.filename, deployment(2));
    await assert.rejects(f.control.reloadConfiguration(), { code: "stop_lifecycle_blocked" });
    assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.equal(f.control.snapshot().status, "ready");
    assert.equal(f.store.snapshot().pending, null);
    assert.equal(f.refs[0].closes, 0); assert.equal(f.refs[0].request(), 1);
    options.busy = false; await f.control.reloadConfiguration();
    assert.equal(f.refs.at(-1).request(), 2); assert.equal(f.refs[0].closes, 1);
    assert.throws(() => f.refs[0].request(), /closed/);
  } finally { await f.close(); }
}));

test("post-cleanup activation failure preserves a durable quarantine instead of replaying or claiming rollback", () => fixture(async directory => {
  let f = await start(directory);
  try {
    const digest = f.control.snapshot().configuration.digest;
    await writeFile(f.filename, deployment("invalid"));
    await assert.rejects(f.control.reloadConfiguration());
    assert.equal(f.control.snapshot().status, "recovery-required");
    assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.deepEqual(f.control.snapshot().pending.selection.entryIds, ["include:feature"]);
    assert.equal(f.refs[0].closes, 1); assert.throws(() => f.refs[0].request(), /closed/);
    await f.close(); f = await start(directory);
    assert.equal(f.refs.length, 0);
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    await f.control.recoverDisabled(f.control.snapshot().revision);
    await writeFile(f.filename, deployment(2)); await f.control.reloadConfiguration();
    assert.equal(f.refs.length, 0);
    await f.change("enabled"); assert.equal(f.refs[0].request(), 2);
  } finally { await f.close(); }
}));

test("an enabled entry with a missing dependency remains honestly pending, never reported active", () => fixture(async directory => {
  const f = await start(directory);
  try {
    await f.change("disabled");
    await writeFile(f.filename, deployment(2, false, ["missingService"])); await f.control.reloadConfiguration();
    await f.change("enabled");
    const view = f.control.snapshot().inspection.entries.find(entry => entry.id === "include:feature");
    assert.equal(view.enabled, true); assert.equal(view.phase, "pending");
    assert.equal(f.refs.length, 1);
  } finally { await f.close(); }
}));

test("an asynchronous activation failure cannot be reported as an applied configuration", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const digest = f.control.snapshot().configuration.digest;
    await writeFile(f.filename, deployment("async-invalid"));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_apply_failed" });
    assert.equal(f.control.snapshot().configuration.phase, "recovery-required");
    assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.equal(f.refs[0].closes, 1);
    assert.ok(f.store.snapshot().pending.requestId.startsWith("configuration:"));
    assert.equal(f.control.snapshot().lastReceipt, null);
  } finally { await f.close(); }
}));

test("a config intent save failure never starts cleanup, while a final save failure retains recovery intent", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const commit = f.store.commit.bind(f.store), before = f.control.snapshot().configuration.digest;
    f.store.commit = async () => { throw new ManagedPluginStoreError("management_save_failed"); };
    await writeFile(f.filename, deployment(2));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_save_failed" });
    assert.equal(f.refs[0].closes, 0); assert.equal(f.refs[0].request(), 1);
    assert.equal(f.control.snapshot().configuration.digest, before);
    assert.equal(f.control.snapshot().pending, null);
    let writes = 0;
    f.store.commit = async (...args) => {
      if (++writes === 2) throw new ManagedPluginStoreError("management_save_failed");
      return commit(...args);
    };
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_save_failed" });
    assert.equal(f.refs[0].closes, 1);
    assert.equal(f.control.snapshot().configuration.phase, "recovery-required");
    assert.ok(f.store.snapshot().pending);
    assert.equal(f.control.snapshot().lastReceipt, null);
    await assert.rejects(f.change("enabled"), { code: "management_recovery_required" });
    f.store.commit = commit;
  } finally { await f.close(); }
}));

test("native config-only watch applies file edits and disposes its watcher without changing business HMR bindings", () => fixture(async directory => {
  const f = await start(directory);
  try {
    await startManagedConfigurationWatch(f.root, f.control, f.filename);
    assert.equal(f.control.snapshot().configuration.watching, true);
    assert.equal(f.root.get("hmr"), undefined);
    assert.ok(f.root.get("timer"), "a bare embedding gets a Root-lifetime Timer");
    await writeFile(f.filename, deployment(2));
    await writeFile(f.filename, deployment(3));
    await waitFor(() => f.refs.at(-1)?.value === 3 && f.control.snapshot().status === "ready");
    assert.equal(f.control.snapshot().lastReceipt.code, "management_configuration_applied");
    assert.equal(f.refs[0].closes, 1);
  } finally { await f.close(); }
  assert.deepEqual(f.root.fiber.getEffects(), []);
  await assert.rejects(f.control.reloadConfiguration(), { code: "management_unavailable" });
}));

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("configuration watch did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("code batches serialize imports and receipts with UI/config operations without changing preferences", () => fixture(async directory => {
  const f = await start(directory), entered = deferred(), release = deferred(); let leaked;
  try {
    const batch = f.control.runCodeReload(new AbortController().signal, async permit => {
      leaked = permit; entered.resolve(); await release.promise;
      await permit.apply(["include:feature"], async () => {
        assert.ok(f.store.snapshot().pending.requestId.startsWith("code-reload:"));
      });
    });
    await entered.promise;
    assert.equal(f.control.snapshot().status, "working"); assert.equal(f.store.snapshot().pending, null);
    await assert.rejects(f.change("disabled"), { code: "management_busy" });
    await writeFile(f.filename, deployment(2)); const config = f.control.reloadConfiguration();
    assert.equal(f.refs.length, 1); release.resolve(); await batch; await config;
    assert.deepEqual(f.store.snapshot().preferences, {});
    assert.equal(f.store.snapshot().receipts.at(-2).code, "management_code_reload_applied");
    assert.equal(f.refs.at(-1).value, 2);
    await assert.rejects(leaked.apply(["include:feature"], async () => {}), { code: "management_code_reload_permit_invalid" });
  } finally { release.resolve(); await f.close(); }
}));

test("cancelling a queued code batch never cancels an accepted UI configuration operation", () => fixture(async directory => {
  const entered = deferred(), release = deferred(), cancel = new AbortController();
  const f = await start(directory, { close: async () => { entered.resolve(); await release.promise; } });
  try {
    const change = f.change("disabled"); await entered.promise;
    let imported = false;
    const batch = f.control.runCodeReload(cancel.signal, async () => { imported = true; });
    cancel.abort(Error("watcher closed")); await assert.rejects(batch, /watcher closed/);
    assert.equal(imported, false); release.resolve(); assert.equal((await change).status, "succeeded");
  } finally { release.resolve(); await f.close(); }
}));

test("code intent save failure prevents mutation; final receipt failure retains quarantine", () => fixture(async directory => {
  const f = await start(directory); let applied = 0;
  const run = () => f.control.runCodeReload(new AbortController().signal, permit => permit.apply(["include:feature"], async () => { applied++; }));
  try {
    const commit = f.store.commit.bind(f.store);
    f.store.commit = async () => { throw new ManagedPluginStoreError("management_save_failed"); };
    await assert.rejects(run(), { code: "management_save_failed" });
    assert.equal(applied, 0); assert.equal(f.store.snapshot().pending, null);
    let writes = 0;
    f.store.commit = async (...args) => { if (++writes === 2) throw new ManagedPluginStoreError("management_save_failed"); return commit(...args); };
    await assert.rejects(run(), { code: "management_save_failed" });
    assert.equal(applied, 1); assert.ok(f.store.snapshot().pending.requestId.startsWith("code-reload:"));
    assert.equal(f.control.snapshot().status, "recovery-required");
    await assert.rejects(f.change("enabled"), { code: "management_recovery_required" });
    f.store.commit = commit;
  } finally { await f.close(); }
}));

test("failed code application reuses explicit restart quarantine without replay or new enabled preferences", () => fixture(async directory => {
  let f = await start(directory), applied = 0;
  try {
    await assert.rejects(f.control.runCodeReload(new AbortController().signal, permit => permit.apply(["include:feature"], async () => {
      applied++; throw Error("unknown new implementation state");
    })), /unknown new implementation/);
    const pending = f.store.snapshot().pending;
    await assert.rejects(f.control.recoverDisabled(f.control.snapshot().revision), { code: "management_restart_required" });
    await f.close(); f = await start(directory);
    assert.equal(f.refs.length, 0); assert.equal(applied, 1);
    assert.deepEqual(f.store.snapshot().preferences, {});
    await f.control.recoverDisabled(f.control.snapshot().revision);
    assert.equal(f.store.snapshot().pending, null); assert.equal(f.store.snapshot().preferences["include:feature"].preference, "disabled");
    assert.equal(f.store.snapshot().receipts.at(-1).requestId, pending.requestId);
  } finally { await f.close(); }
}));
