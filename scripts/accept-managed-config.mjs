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
import { PluginManagementClassifier } from "../dist/boot/plugin-control/classification.js";
import { installPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { registerPluginOwner } from "../dist/boot/plugin-control/owner-registry.js";
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
  const classifications = new PluginManagementClassifier({
    "cordis:profile": "kernel", "cordis:group": "structural", "cordis:feature": "managed",
    "cordis:leaf": "managed", "cordis:replacement": "managed",
  });
  const inspection = installPluginInspection(root, classifications); installPluginLifecycle(root, inspection);
  const store = await ManagedPluginStore.open(join(directory, "managed.json"));
  const control = new ManagedPluginControl(root, inspection, store);
  const refs = [];
  root.loader.builtins.group = Group;
  root.loader.builtins.feature = {
    apply(ctx, config) {
      if (config.value === "invalid") throw Error("invalid feature config");
      if (config.value === "async-invalid") return Promise.resolve().then(() => { throw Error("async feature activation failed"); });
      let accepting = true, closed = false;
      const ref = { value: config.value, dependency: config.uses ? ctx.get(config.uses) : undefined,
        closes: 0, request() { if (!accepting || closed) throw Error("closed"); return config.value; } };
      refs.push(ref);
      const close = async () => { ref.closes++; await options.close?.(); closed = true; };
      registerPluginOwner(ctx, {
        status: () => ({ disposition: options.busy ? "blocked" : "direct", code: options.busy ? "owner_busy" : "owner_idle" }),
        replacement: "drain",
        prepare: () => {
          accepting = false;
          return { drained: Promise.resolve(), deactivate: close, release() { if (!closed) accepting = true; } };
        },
      });
      ctx.effect(() => () => { closed = true; });
      if (config.provides) ctx.provide(config.provides, ref);
    },
  };
  const filename = join(directory, "cordis.yml");
  root.loader.builtins.profile = managedProfilePlugin(new ManagedProfileSource(filename, "include", store.snapshot()), profile => control.attach(profile), classifications);
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
      assert.deepEqual(f.control.snapshot().controls["include:feature"], {
        managementClass: "managed", canEnable: true, canDisable: false, canReplace: false,
      });
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
      assert.deepEqual(f.control.snapshot().controls["include:feature"], {
        managementClass: "managed", canEnable: false, canDisable: false, canReplace: false, reason: "management_enable_constrained",
      });
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
    assert.deepEqual({ kind: f.root.pluginChanges.snapshot().last.kind, source: f.root.pluginChanges.snapshot().last.source,
      phase: f.root.pluginChanges.snapshot().last.phase }, { kind: "reconfigure", source: "configuration", phase: "succeeded" });
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

test("invalid YAML or a carrier declared as an ordinary plugin keeps the last accepted revision and live owners", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const digest = f.control.snapshot().configuration.digest;
    await writeFile(f.filename, "[bad: [");
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_invalid" });
    assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.equal(f.control.snapshot().configuration.phase, "rejected");
    assert.equal(f.control.snapshot().pending, null);
    assert.equal(f.refs[0].closes, 0); assert.equal(f.refs[0].request(), 1);
    await writeFile(f.filename, JSON.stringify([{ id: "app", name: "cordis:group", config: [] }]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_entry_unmanaged" });
    assert.equal(f.refs[0].closes, 0);
    f.root.loader.builtins.wrappedGroup = { apply: Group };
    await writeFile(f.filename, JSON.stringify([{ id: "app", name: "cordis:wrappedGroup", config: [] }]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_entry_unmanaged" });
    assert.equal(f.refs[0].closes, 0);
    await writeFile(f.filename, JSON.stringify([{ id: "app", name: "cordis:group", group: "false", config: [] }]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_profile_invalid" });
    assert.equal(f.refs[0].closes, 0);
    await writeFile(f.filename, deployment()); await f.control.reloadConfiguration();
    assert.equal(f.control.snapshot().configuration.phase, "idle");
    assert.equal(f.refs.length, 1);
  } finally { await f.close(); }
}));

test("file reload waits for a UI transaction and recomposes its saved preference; queued UI writes recheck stale revisions", () => fixture(async directory => {
  const entered = deferred(), release = deferred();
  const f = await start(directory, { close: async () => { entered.resolve(); await release.promise; } });
  try {
    const revision = f.control.snapshot().revision;
    const off = f.change("disabled"); await entered.promise;
    await writeFile(f.filename, deployment(2));
    const reload = f.control.reloadConfiguration();
    const stale = assert.rejects(f.change("enabled"), { code: "management_revision_conflict" });
    release.resolve(); await off; await reload; await stale;
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

test("post-cleanup activation failure rebuilds the committed generation in the same process", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const digest = f.control.snapshot().configuration.digest;
    await writeFile(f.filename, deployment("invalid"));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(f.control.snapshot().status, "ready");
    assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.equal(f.control.snapshot().pending, null);
    assert.equal(f.control.snapshot().lastReceipt.code, "management_configuration_rolled_back");
    assert.equal(f.refs[0].closes, 1); assert.throws(() => f.refs[0].request(), /closed/);
    assert.equal(f.refs.at(-1).request(), 1);
    await writeFile(f.filename, deployment(2)); await f.control.reloadConfiguration();
    assert.equal(f.refs.at(-1).request(), 2);
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
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(f.control.snapshot().configuration.phase, "rejected");
    assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.equal(f.refs[0].closes, 1);
    assert.equal(f.store.snapshot().pending, null);
    assert.equal(f.refs.at(-1).request(), 1);
    assert.equal(f.control.snapshot().lastReceipt.code, "management_configuration_rolled_back");
  } finally { await f.close(); }
}));

test("a config intent save failure never starts cleanup, while a deterministic final save failure rolls back", () => fixture(async directory => {
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
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(f.refs[0].closes, 1);
    assert.equal(f.control.snapshot().configuration.phase, "rejected");
    assert.equal(f.store.snapshot().pending, null);
    assert.equal(f.control.snapshot().lastReceipt.code, "management_configuration_rolled_back");
    assert.equal(f.refs.at(-1).request(), 1);
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

const entries = items => JSON.stringify([{ id: "app", name: "cordis:group", group: true, config: items }]);
const feature = (id, config = {}, extra = {}) => ({ id, name: "cordis:feature", config: { value: 1, ...config }, ...extra });
const entryView = (f, id) => f.control.snapshot().inspection.entries.find(entry => entry.id === `include:${id}`);
const group = (id, config, extra = {}) => ({ id, name: "cordis:group", group: true, config, ...extra });

test("a provider can become a group and back while external dependents bind each new generation", () => fixture(async directory => {
  const consumer = feature("consumer", { uses: "sample" }, { inject: ["sample"] });
  const plain = entries([feature("feature", { value: 10, provides: "sample" }), consumer]);
  const grouped = entries([group("feature", [feature("provider", { value: 20, provides: "sample" }),
    group("nested", [feature("leaf", { uses: "sample" }, { inject: ["sample"] })])]), consumer]);
  await writeFile(join(directory, "cordis.yml"), plain);
  const f = await start(directory);
  try {
    const app = f.root.loader.resolve("include:app").fiber, dependent = f.root.loader.resolve("include:consumer").fiber;
    const oldProvider = f.refs.find(ref => !ref.dependency), oldConsumer = f.refs.find(ref => ref.dependency);
    await writeFile(f.filename, grouped); await f.control.reloadConfiguration();
    assert.equal(oldProvider.closes, 1); assert.equal(oldConsumer.closes, 1);
    assert.equal(entryView(f, "feature").kind, "group"); assert.equal(entryView(f, "leaf").phase, "active");
    assert.equal(f.refs.findLast(ref => ref.dependency).dependency.value, 20);
    assert.equal(f.root.loader.resolve("include:consumer").fiber, dependent);
    const groupGeneration = f.refs.slice(2);
    await writeFile(f.filename, plain); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature").kind, "plugin");
    assert.equal(f.root.loader.resolve("include:feature").subgroup, undefined);
    for (const id of ["provider", "nested", "leaf"]) assert.equal(entryView(f, id), undefined);
    for (const ref of groupGeneration) { assert.equal(ref.closes, 1); assert.throws(() => ref.request(), /closed/); }
    assert.equal(f.refs.findLast(ref => ref.dependency).dependency.value, 10);
    assert.equal(f.root.loader.resolve("include:consumer").fiber, dependent);
    assert.equal(f.root.loader.resolve("include:app").fiber, app);
  } finally { await f.close(); }
}));

test("converting a group to a plugin can relocate retained descendants in the same revision", () => fixture(async directory => {
  const provider = feature("provider", { value: 10, provides: "sample" });
  const leaf = feature("leaf", { uses: "sample" }, { inject: ["sample"] });
  const nested = group("nested", [leaf]);
  await writeFile(join(directory, "cordis.yml"), entries([group("feature", [provider, nested])]));
  const f = await start(directory);
  try {
    const old = [...f.refs];
    await writeFile(f.filename, entries([feature("feature", { uses: "sample" }, { inject: ["sample"] }), provider, group("destination", [nested])]));
    await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature").phase, "active");
    assert.equal(f.root.loader.resolve("include:feature").subgroup, undefined);
    assert.equal(entryView(f, "provider").parentId, "include:app");
    assert.equal(entryView(f, "nested").parentId, "include:destination");
    assert.equal(entryView(f, "leaf").phase, "active");
    assert.equal(old.length, 2); assert.ok(old.every(ref => ref.closes === 1));
    assert.equal(f.refs.findLast(ref => ref.dependency).dependency.value, 10);
  } finally { await f.close(); }
}));

for (const preference of ["enabled", "disabled"]) test(`same-name type conversion discards the old ${preference} preference and creates fresh ownership`, () => fixture(async directory => {
  const f = await start(directory);
  try {
    await f.change(preference);
    const originalPlugin = f.root.loader.builtins.feature;
    f.root.loader.builtins.leaf = originalPlugin;
    f.root.loader.builtins.feature = Group;
    await writeFile(f.filename, entries([group("feature", [feature("child", {}, { name: "cordis:leaf" })], { name: "cordis:feature" })]));
    await f.control.reloadConfiguration();
    assert.deepEqual(f.store.snapshot().preferences, {});
    assert.equal(entryView(f, "child").phase, "active");
    assert.equal(f.root.loader.resolve("include:feature").options.disabled, undefined);
    f.root.loader.builtins.feature = originalPlugin;
    await writeFile(f.filename, entries([feature("feature", { value: 30 })])); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature").kind, "plugin"); assert.equal(entryView(f, "child"), undefined);
    assert.equal(f.root.loader.resolve("include:feature").subgroup, undefined);
    assert.equal(f.refs.at(-1).request(), 30);
  } finally { await f.close(); }
}));

for (const beforeGroup of [false, true]) test(`${beforeGroup ? "group-to-plugin" : "plugin-to-group"} conversion refuses busy owners before cleanup`, () => fixture(async directory => {
  const plain = entries([feature("feature")]), grouped = entries([group("feature", [feature("child")])]);
  await writeFile(join(directory, "cordis.yml"), beforeGroup ? grouped : plain);
  const f = await start(directory, { busy: true });
  try {
    const digest = f.control.snapshot().configuration.digest;
    await writeFile(f.filename, beforeGroup ? plain : grouped);
    await assert.rejects(f.control.reloadConfiguration(), { code: "stop_lifecycle_blocked" });
    assert.equal(f.refs[0].closes, 0); assert.equal(f.refs[0].request(), 1);
    assert.equal(f.store.snapshot().pending, null); assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.equal(entryView(f, "feature").kind, beforeGroup ? "group" : "plugin");
  } finally { await f.close(); }
}));

test("an empty pending plugin can become a group, while pending pre-activation resources cannot bypass admission", () => fixture(async directory => {
  const pending = entries([feature("feature", {}, { inject: ["missing"] })]);
  await writeFile(join(directory, "cordis.yml"), pending);
  const f = await start(directory);
  try {
    const fiber = f.root.loader.resolve("include:feature").fiber;
    const dispose = fiber.effect(() => () => {}, "pending-resource");
    await writeFile(f.filename, entries([group("feature", [feature("child")])]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_target_unsettled" });
    assert.equal(f.store.snapshot().pending, null); assert.equal(f.refs.length, 0);
    await dispose(); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "child").phase, "active"); assert.equal(fiber.uid, null);
  } finally { await f.close(); }
}));

for (const beforeGroup of [false, true]) test(`${beforeGroup ? "group-to-plugin" : "plugin-to-group"} activation failure restores the old shape`, () => fixture(async directory => {
  await writeFile(join(directory, "cordis.yml"), entries([beforeGroup ? group("feature", [feature("child")]) : feature("feature")]));
  let f = await start(directory);
  try {
    const next = beforeGroup ? feature("feature", { value: "async-invalid" }) : group("feature", [feature("broken", { value: "async-invalid" })]);
    await writeFile(f.filename, entries([next]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(f.control.snapshot().status, "ready");
    assert.equal(f.refs[0].closes, 1); assert.equal(f.refs.length, 2);
    assert.throws(() => f.refs[0].request(), /closed/);
    assert.equal(entryView(f, "feature").kind, beforeGroup ? "group" : "plugin");
    assert.equal(entryView(f, beforeGroup ? "child" : "feature").phase, "active");
    assert.equal(f.refs.at(-1).request(), 1);
    assert.equal(f.store.snapshot().pending, null);
  } finally { await f.close(); }
}));

for (const beforeGroup of [false, true]) {
  test(`${beforeGroup ? "group-to-plugin" : "plugin-to-group"} receipt failure restores the committed type`, () => fixture(async directory => {
    const plain = entries([feature("feature")]), grouped = entries([group("feature", [feature("child")])]);
    const before = beforeGroup ? grouped : plain, after = beforeGroup ? plain : grouped;
    await writeFile(join(directory, "cordis.yml"), before);
    const f = await start(directory);
    try {
      const commit = f.store.commit.bind(f.store); let writes = 0;
      f.store.commit = async (...args) => { if (++writes === 2) throw new ManagedPluginStoreError("management_save_failed"); return commit(...args); };
      await writeFile(f.filename, after);
      await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
      assert.equal(f.store.snapshot().pending, null);
      assert.equal(f.control.snapshot().status, "ready");
      assert.equal(entryView(f, "feature").kind, beforeGroup ? "group" : "plugin");
      assert.equal(entryView(f, beforeGroup ? "child" : "feature").phase, "active");
      assert.equal(f.refs.at(-1).request(), 1);
      f.store.commit = commit;
    } finally { await f.close(); }
  }));
}

test("duplicate IDs between a group and its descendant are rejected before Loader sees the tree", () => fixture(async directory => {
  const f = await start(directory);
  try {
    await writeFile(f.filename, JSON.stringify([group("duplicate", [feature("duplicate")])]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_profile_invalid" });
    assert.equal(f.refs[0].closes, 0); assert.equal(f.store.snapshot().pending, null);
  } finally { await f.close(); }
}));

test("nested groups can be added, removed and restored while external dependents wait for their services", () => fixture(async directory => {
  const consumer = feature("consumer", { uses: "sample" }, { inject: ["sample"] });
  const base = [feature("feature"), consumer];
  const module = group("module", [feature("provider", { value: 10, provides: "sample" }),
    group("nested", [feature("leaf", { uses: "sample" }, { inject: ["sample"] })])]);
  await writeFile(join(directory, "cordis.yml"), entries(base));
  const f = await start(directory);
  try {
    const unaffected = f.root.loader.resolve("include:feature").fiber;
    const dependent = f.root.loader.resolve("include:consumer").fiber;
    await writeFile(f.filename, entries([...base, module])); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "leaf").phase, "active");
    assert.equal(f.refs.find(ref => ref.dependency)?.dependency.value, 10);
    const previous = f.refs.slice(1);
    await writeFile(f.filename, entries(base)); await f.control.reloadConfiguration();
    for (const id of ["module", "nested", "provider", "leaf"]) assert.equal(entryView(f, id), undefined);
    assert.equal(entryView(f, "consumer").phase, "pending");
    for (const ref of previous) { assert.equal(ref.closes, 1); assert.throws(() => ref.request(), /closed/); }
    await writeFile(f.filename, entries([...base, module])); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "consumer").phase, "active");
    assert.equal(f.root.loader.resolve("include:consumer").fiber, dependent);
    assert.equal(f.root.loader.resolve("include:feature").fiber, unaffected);
    assert.equal(f.refs[0].closes, 0);
  } finally { await f.close(); }
}));

test("cross-group swaps restart moved consumers against the destination isolation scope", () => fixture(async directory => {
  const providerA = feature("providerA", { value: 10, provides: "sample" });
  const providerB = feature("providerB", { value: 20, provides: "sample" });
  const left = feature("feature", { value: 1, uses: "sample" }, { inject: ["sample"] });
  const right = feature("other", { value: 2, uses: "sample" }, { inject: ["sample"] });
  const layout = swapped => JSON.stringify([
    group("left", [providerA, swapped ? right : left], { isolate: { sample: true } }),
    group("right", [providerB, swapped ? left : right], { isolate: { sample: true } }),
  ]);
  await writeFile(join(directory, "cordis.yml"), layout(false));
  const f = await start(directory);
  try {
    const providers = ["providerA", "providerB"].map(id => f.root.loader.resolve(`include:${id}`).fiber);
    const oldLeft = f.refs.find(ref => ref.value === 1), oldRight = f.refs.find(ref => ref.value === 2);
    assert.equal(oldLeft.dependency.value, 10); assert.equal(oldRight.dependency.value, 20);
    await writeFile(f.filename, layout(true)); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature").parentId, "include:right");
    assert.equal(entryView(f, "other").parentId, "include:left");
    assert.equal(f.refs.findLast(ref => ref.value === 1).dependency.value, 20);
    assert.equal(f.refs.findLast(ref => ref.value === 2).dependency.value, 10);
    assert.equal(oldLeft.closes, 1); assert.equal(oldRight.closes, 1);
    assert.deepEqual(["providerA", "providerB"].map(id => f.root.loader.resolve(`include:${id}`).fiber), providers);
    await writeFile(f.filename, layout(false)); await f.control.reloadConfiguration();
    assert.equal(f.refs.findLast(ref => ref.value === 1).dependency.value, 10);
  } finally { await f.close(); }
}));

test("renaming and moving nested groups preserves IDs and saved child preferences", () => fixture(async directory => {
  const old = JSON.stringify([group("app", [feature("feature"), group("nested", [feature("leaf")])])]);
  await writeFile(join(directory, "cordis.yml"), old);
  const f = await start(directory);
  try {
    const oldLeaf = f.refs[1];
    await f.change("disabled");
    await writeFile(f.filename, JSON.stringify([group("renamed", [group("nested", [feature("leaf"), feature("feature")])])]));
    await f.control.reloadConfiguration();
    assert.equal(entryView(f, "app"), undefined);
    assert.equal(entryView(f, "nested").parentId, "include:renamed");
    assert.equal(entryView(f, "feature").parentId, "include:nested");
    assert.equal(entryView(f, "feature").enabled, false);
    assert.equal(entryView(f, "leaf").phase, "active");
    assert.equal(oldLeaf.closes, 1); assert.throws(() => oldLeaf.request(), /closed/);
    assert.equal(f.control.snapshot().preferences["include:feature"].preference, "disabled");
    await f.change("enabled"); assert.equal(entryView(f, "feature").phase, "active");
  } finally { await f.close(); }
}));

test("moving a group restarts descendants whose immediate parent ID did not change", () => fixture(async directory => {
  const nested = group("nested", [feature("feature", { uses: "sample" }, { inject: ["sample"] })]);
  const layout = moved => JSON.stringify([
    group("left", [feature("providerA", { value: 10, provides: "sample" }), ...(!moved ? [nested] : [])], { isolate: { sample: true } }),
    group("right", [feature("providerB", { value: 20, provides: "sample" }), ...(moved ? [nested] : [])], { isolate: { sample: true } }),
  ]);
  await writeFile(join(directory, "cordis.yml"), layout(false));
  const f = await start(directory);
  try {
    const old = f.refs.find(ref => ref.dependency);
    assert.equal(old.dependency.value, 10);
    await writeFile(f.filename, layout(true)); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature").parentId, "include:nested");
    assert.equal(entryView(f, "nested").parentId, "include:right");
    assert.equal(old.closes, 1); assert.throws(() => old.request(), /closed/);
    assert.equal(f.refs.findLast(ref => ref.dependency).dependency.value, 20);
  } finally { await f.close(); }
}));

test("failed activation in a newly added group removes the candidate and keeps the committed tree", () => fixture(async directory => {
  await writeFile(join(directory, "cordis.yml"), entries([feature("feature")]));
  const f = await start(directory);
  try {
    await writeFile(f.filename, entries([feature("feature"), group("added", [feature("broken", { value: "async-invalid" })])]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(f.control.snapshot().status, "ready");
    assert.equal(f.refs[0].closes, 0);
    assert.equal(entryView(f, "added"), undefined);
    assert.equal(entryView(f, "broken"), undefined);
    assert.equal(entryView(f, "feature").phase, "active");
    assert.equal(f.store.snapshot().pending, null);
  } finally { await f.close(); }
}));

test("sibling and group reorder preserves live Fibers even when their owners are busy", () => fixture(async directory => {
  const a = feature("feature"), b = feature("other");
  await writeFile(join(directory, "cordis.yml"), JSON.stringify([group("app", [a, b]), group("empty", [])]));
  const f = await start(directory, { busy: true });
  try {
    const ids = ["app", "empty", "feature", "other"];
    const fibers = ids.map(id => f.root.loader.resolve(`include:${id}`).fiber);
    await writeFile(f.filename, JSON.stringify([group("empty", []), group("app", [b, a])]));
    await f.control.reloadConfiguration();
    assert.deepEqual(ids.map(id => f.root.loader.resolve(`include:${id}`).fiber), fibers);
    assert.deepEqual(f.root.loader.resolve("include:app").subgroup.data.map(item => item.id), ["other", "feature"]);
    assert.deepEqual(f.root.loader.resolve("include").subtree.root.data.map(item => item.id), ["empty", "app"]);
    assert.equal(f.refs.length, 2); assert.ok(f.refs.every(ref => ref.closes === 0));
  } finally { await f.close(); }
}));

test("group gate changes stop inherited children and respect saved preferences when opened again", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const old = f.refs[0];
    await writeFile(f.filename, JSON.stringify([group("app", [feature("feature")], { disabled: true })]));
    await f.control.reloadConfiguration();
    assert.equal(old.closes, 1); assert.equal(entryView(f, "feature").enabled, false);
    await writeFile(f.filename, deployment()); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature").phase, "active"); assert.equal(f.refs.length, 2);
    await f.change("disabled");
    await writeFile(f.filename, JSON.stringify([group("app", [feature("feature")], { isolate: { sample: true } })]));
    await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature").enabled, false); assert.equal(f.refs.length, 2);
  } finally { await f.close(); }
}));

test("group removal refuses busy children and unmanaged programmatic mounts before any cleanup", () => fixture(async directory => {
  const options = { busy: true }, f = await start(directory, options);
  try {
    await writeFile(f.filename, "[]");
    await assert.rejects(f.control.reloadConfiguration(), { code: "stop_lifecycle_blocked" });
    assert.equal(f.refs[0].closes, 0); assert.equal(f.store.snapshot().pending, null);
    options.busy = false;
    const child = await f.root.loader.resolve("include:app").fiber.ctx.plugin(() => {});
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_group_unmanaged" });
    assert.equal(f.refs[0].closes, 0); assert.equal(f.store.snapshot().pending, null);
    await child.dispose(); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "app"), undefined); assert.equal(entryView(f, "feature"), undefined);
  } finally { await f.close(); }
}));

test("a group flag does not grant arbitrary plugins native carrier cleanup authority", () => fixture(async directory => {
  const f = await start(directory);
  try {
    f.root.loader.builtins.customGroup = class extends Group {};
    await writeFile(f.filename, JSON.stringify([group("app", [feature("feature")], { name: "cordis:customGroup" })]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_group_unmanaged" });
    await writeFile(f.filename, JSON.stringify([group("app", [feature("feature")], { inject: ["missing"] })]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_group_unmanaged" });
    assert.equal(f.refs[0].closes, 0); assert.equal(f.store.snapshot().pending, null);
  } finally { await f.close(); }
}));

test("group rename receipt failure restores the committed group and children", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const commit = f.store.commit.bind(f.store); let writes = 0;
    f.store.commit = async (...args) => { if (++writes === 2) throw new ManagedPluginStoreError("management_save_failed"); return commit(...args); };
    await writeFile(f.filename, JSON.stringify([group("renamed", [feature("feature")])]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(f.store.snapshot().pending, null);
    assert.equal(entryView(f, "app").kind, "group"); assert.equal(entryView(f, "renamed"), undefined);
    assert.equal(entryView(f, "feature").phase, "active"); assert.equal(f.refs.at(-1).request(), 1);
    f.store.commit = commit;
  } finally { await f.close(); }
}));

test("removing a Provider unloads its dependent chain; adding it back reactivates consumers without changing their gates", () => fixture(async directory => {
  const provider = feature("provider", { value: 10, provides: "first" });
  const consumer = feature("consumer", { value: 20, uses: "first", provides: "second" }, { inject: ["first"] });
  const leaf = feature("leaf", { value: 30, uses: "second" }, { inject: ["second"] });
  await writeFile(join(directory, "cordis.yml"), entries([provider, consumer, leaf]));
  const f = await start(directory);
  try {
    const old = [...f.refs];
    assert.equal(old.length, 3);
    const fibers = ["consumer", "leaf"].map(id => f.root.loader.resolve(`include:${id}`).fiber);
    await writeFile(f.filename, entries([consumer, leaf]));
    await f.control.reloadConfiguration();
    assert.equal(entryView(f, "provider"), undefined);
    for (const id of ["consumer", "leaf"]) {
      assert.equal(entryView(f, id).phase, "pending");
      assert.equal(entryView(f, id).enabled, true);
    }
    for (const ref of old) { assert.equal(ref.closes, 1); assert.throws(() => ref.request(), /closed/); }
    assert.deepEqual(f.control.snapshot().preferences, {});
    await writeFile(f.filename, entries([feature("provider", { value: 11, provides: "first" }), consumer, leaf]));
    await f.control.reloadConfiguration();
    assert.equal(f.refs.length, 6);
    for (const id of ["provider", "consumer", "leaf"]) assert.equal(entryView(f, id).phase, "active");
    assert.equal(f.refs.findLast(ref => ref.value === 20).dependency.request(), 11);
    assert.deepEqual(["consumer", "leaf"].map(id => f.root.loader.resolve(`include:${id}`).fiber), fibers);
    assert.equal(f.control.snapshot().lastReceipt.code, "management_configuration_applied");
  } finally { await f.close(); }
}));

test("missing-dependency entries can be added, reconfigured and removed while remaining honestly pending", () => fixture(async directory => {
  await writeFile(join(directory, "cordis.yml"), entries([]));
  const f = await start(directory);
  try {
    await writeFile(f.filename, entries([feature("pending", {}, { inject: ["missing"] })]));
    await f.control.reloadConfiguration();
    assert.equal(entryView(f, "pending").phase, "pending"); assert.equal(f.refs.length, 0);
    await writeFile(f.filename, entries([feature("pending", { value: 2 }, { inject: ["anotherMissing"] })]));
    await f.control.reloadConfiguration();
    assert.equal(entryView(f, "pending").phase, "pending"); assert.equal(f.refs.length, 0);
    await writeFile(f.filename, entries([])); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "pending"), undefined);
    assert.equal(f.control.snapshot().pending, null);
    assert.equal(f.control.snapshot().status, "ready");
  } finally { await f.close(); }
}));

test("an enabled managed plugin waiting for dependencies can be disabled and re-enabled while remaining pending", () => fixture(async directory => {
  await writeFile(join(directory, "cordis.yml"), deployment(1, false, ["missing"]));
  const f = await start(directory);
  try {
    assert.equal(entryView(f, "feature").phase, "pending");
    assert.equal(entryView(f, "feature").enabled, true);
    assert.deepEqual(f.control.snapshot().controls["include:feature"], {
      managementClass: "managed", canEnable: false, canDisable: true, canReplace: false,
    });

    assert.equal((await f.change("disabled")).status, "succeeded");
    assert.equal(entryView(f, "feature").enabled, false);
    assert.equal(entryView(f, "feature").phase, "absent");
    assert.equal(f.root.loader.resolve("include:feature").fiber, undefined);
    assert.equal(f.control.snapshot().preferences["include:feature"].preference, "disabled");
    assert.deepEqual(f.control.snapshot().controls["include:feature"], {
      managementClass: "managed", canEnable: true, canDisable: false, canReplace: false,
    });

    assert.equal((await f.change("enabled")).status, "succeeded");
    assert.equal(entryView(f, "feature").enabled, true);
    assert.equal(entryView(f, "feature").phase, "pending");
    assert.equal(f.control.snapshot().preferences["include:feature"].preference, "enabled");
    assert.deepEqual(f.control.snapshot().controls["include:feature"], {
      managementClass: "managed", canEnable: false, canDisable: true, canReplace: false,
    });
  } finally { await f.close(); }
}));

test("an enable transaction restores the complete dependency graph after a downstream activation failure", () => fixture(async directory => {
  await writeFile(join(directory, "cordis.yml"), entries([
    feature("feature", { provides: "sessions" }, { disabled: true,
      management: { activation: "user", constraint: false } }),
    feature("agent-loop", { provides: "agentLoop" }, { inject: ["sessions"] }),
    feature("application", { provides: "application" }, { inject: ["sessions"] }),
    feature("webui", { value: "async-invalid" }, { inject: ["application", "agentLoop"] }),
  ]));
  const f = await start(directory);
  try {
    assert.deepEqual(["feature", "agent-loop", "application", "webui"].map(id => entryView(f, id).phase),
      ["absent", "pending", "pending", "pending"]);
    await assert.rejects(f.change("enabled"), { code: "management_change_rolled_back" });
    assert.equal(f.control.snapshot().status, "ready");
    assert.equal(f.control.snapshot().pending, null);
    assert.deepEqual(f.control.snapshot().preferences, {});
    assert.deepEqual(["feature", "agent-loop", "application", "webui"].map(id => entryView(f, id).phase),
      ["absent", "pending", "pending", "pending"]);
  } finally { await f.close(); }
}));

test("a pending plugin returns to waiting-for-dependency when its disable receipt cannot be saved", () => fixture(async directory => {
  await writeFile(join(directory, "cordis.yml"), deployment(1, false, ["missing"]));
  const f = await start(directory);
  try {
    const oldFiber = f.root.loader.resolve("include:feature").fiber;
    const commit = f.store.commit.bind(f.store); let writes = 0;
    f.store.commit = async (...args) => {
      if (++writes === 2) throw new ManagedPluginStoreError("management_save_failed");
      return commit(...args);
    };
    await assert.rejects(f.change("disabled"), { code: "management_change_rolled_back" });
    const restored = f.root.loader.resolve("include:feature");
    assert.equal(restored.disabled, false);
    assert.notEqual(restored.fiber, oldFiber);
    assert.equal(entryView(f, "feature").phase, "pending");
    assert.equal(f.control.snapshot().status, "ready");
    assert.equal(f.control.snapshot().pending, null);
    assert.equal(f.control.snapshot().preferences["include:feature"], undefined);
    assert.equal(f.control.snapshot().lastReceipt.code, "management_change_rolled_back");
    f.store.commit = commit;
  } finally { await f.close(); }
}));

test("pending instances with pre-activation effects cannot bypass resource coordination", () => fixture(async directory => {
  const f = await start(directory); let cleaned = 0;
  try {
    f.root.on("internal/plugin", fiber => {
      if (fiber.uid !== null && fiber.entry?.options.id === "pending") fiber.effect(() => () => { cleaned++; }, "pending resource");
    });
    await writeFile(f.filename, entries([feature("feature"), feature("pending", {}, { inject: ["missing"] })]));
    await f.control.reloadConfiguration();
    const digest = f.control.snapshot().configuration.digest;
    await writeFile(f.filename, deployment());
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_target_unsettled" });
    assert.equal(cleaned, 0); assert.equal(entryView(f, "pending").phase, "pending");
    assert.equal(f.control.snapshot().configuration.digest, digest);
    assert.equal(f.control.snapshot().pending, null);
  } finally { await f.close(); }
  assert.equal(cleaned, 1);
}));

test("a pending managed plugin with pre-activation effects cannot bypass its missing Owner protocol", () => fixture(async directory => {
  await writeFile(join(directory, "cordis.yml"), deployment(1, false, ["missing"]));
  const f = await start(directory); let cleaned = 0;
  try {
    f.root.loader.resolve("include:feature").fiber.effect(() => () => { cleaned++; }, "pending resource");
    const receipt = await f.change("disabled");
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.code, "stop_owner_unsupported");
    assert.equal(entryView(f, "feature").enabled, true);
    assert.equal(entryView(f, "feature").phase, "pending");
    assert.equal(f.control.snapshot().pending, null);
    assert.equal(f.control.snapshot().preferences["include:feature"], undefined);
    assert.equal(cleaned, 0);
  } finally { await f.close(); }
  assert.equal(cleaned, 1);
}));

test("removing a disabled entry clears only its saved preference and allows a clean later addition", () => fixture(async directory => {
  let f = await start(directory);
  try {
    await f.change("disabled");
    await writeFile(f.filename, entries([])); await f.control.reloadConfiguration();
    assert.deepEqual(f.control.snapshot().preferences, {});
    await f.close(); f = await start(directory);
    assert.equal(entryView(f, "feature"), undefined);
    await writeFile(f.filename, deployment(2)); await f.control.reloadConfiguration();
    assert.equal(f.refs.at(-1).request(), 2);
    assert.equal(entryView(f, "feature").phase, "active");
  } finally { await f.close(); }
}));

for (const preference of ["enabled", "disabled"]) test(`ordinary entry replacement clears the old ${preference} preference and binds the new implementation`, () => fixture(async directory => {
  const f = await start(directory);
  try {
    await f.change(preference);
    f.root.loader.builtins.replacement = { apply(ctx, config) { f.root.loader.builtins.feature.apply(ctx, { ...config, value: config.value + 100 }); } };
    await writeFile(f.filename, deployment(2).replace("cordis:feature", "cordis:replacement"));
    await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature").name, "cordis:replacement");
    assert.equal(f.refs.at(-1).request(), 102);
    assert.equal(f.refs[0].closes, 1); assert.throws(() => f.refs[0].request(), /closed/);
    assert.deepEqual(f.control.snapshot().preferences, {});
  } finally { await f.close(); }
}));

test("entry removal still rejects busy owners and unknown affected consumers before changing anything", () => fixture(async directory => {
  const options = { busy: true }, f = await start(directory, options);
  try {
    await writeFile(f.filename, entries([]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "stop_lifecycle_blocked" });
    assert.equal(f.refs[0].closes, 0); assert.equal(entryView(f, "feature").phase, "active");
    assert.equal(f.control.snapshot().pending, null);
    options.busy = false;
    await writeFile(f.filename, entries([feature("feature", { provides: "sample" })])); await f.control.reloadConfiguration();
    const consumer = await f.root.plugin({ inject: ["sample"], apply() {} });
    await writeFile(f.filename, entries([]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "stop_owner_unsupported" });
    assert.equal(f.refs.at(-1).closes, 0); assert.equal(entryView(f, "feature").phase, "active");
    await consumer.dispose(); await f.control.reloadConfiguration();
    assert.equal(entryView(f, "feature"), undefined);
  } finally { await f.close(); }
}));

test("an added Provider that causes dependent initialization failure restores the committed graph", () => fixture(async directory => {
  const consumer = feature("consumer", { value: "async-invalid" }, { inject: ["sample"] });
  await writeFile(join(directory, "cordis.yml"), entries([consumer]));
  let f = await start(directory);
  try {
    await writeFile(f.filename, entries([feature("provider", { provides: "sample" }), consumer]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(f.control.snapshot().status, "ready");
    assert.equal(f.control.snapshot().pending, null);
    assert.equal(entryView(f, "provider"), undefined);
    assert.equal(entryView(f, "consumer").phase, "pending");
  } finally { await f.close(); }
}));

test("recovery accepts a later deployment only when uncertain entry identities remain quarantinable", () => fixture(async directory => {
  const filename = join(directory, "cordis.yml");
  const base = { schemaVersion: 2, revision: "recovery", preferences: {}, pending: null, receipts: [], operations: [] };
  await writeFile(filename, deployment(1));
  const before = new ManagedProfileSource(filename, "include", base);
  await writeFile(filename, deployment(2));
  const after = new ManagedProfileSource(filename, "include", base);
  const pending = { requestId: "configuration:recovery", revision: "recovery", preference: "inherit",
    selection: { instanceId: "previous-instance", entryIds: ["include:feature"] },
    configuration: { beforeDigest: before.digest, afterDigest: after.digest, changes: [{
      entryId: "include:feature", beforeName: "cordis:feature", afterName: "cordis:feature", kind: "update",
    }] },
  };
  await writeFile(filename, deployment(3));
  const recovered = new ManagedProfileSource(filename, "include", { ...base, pending });
  assert.notEqual(recovered.digest, before.digest);
  assert.notEqual(recovered.digest, after.digest);
  assert.equal(recovered.entries[0].config[0].disabled, true);

  await writeFile(filename, JSON.stringify([{ id: "app", name: "cordis:group", group: true, config: [
    { id: "feature", name: "cordis:replacement", config: { value: 3 } },
  ] }]));
  assert.throws(() => new ManagedProfileSource(filename, "include", { ...base, pending }),
    { code: "management_profile_entry_changed" });
}));

test("removal receipt failure restores the committed disabled entry", () => fixture(async directory => {
  const f = await start(directory);
  try {
    await f.change("disabled");
    const commit = f.store.commit.bind(f.store); let writes = 0;
    f.store.commit = async (...args) => { if (++writes === 2) throw new ManagedPluginStoreError("management_save_failed"); return commit(...args); };
    await writeFile(f.filename, entries([]));
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(entryView(f, "feature").enabled, false);
    assert.equal(f.store.snapshot().pending, null);
    assert.equal(f.control.snapshot().status, "ready");
    f.store.commit = commit;
    assert.deepEqual(f.control.snapshot().preferences, { "include:feature": { name: "cordis:feature", preference: "disabled" } });
    assert.equal(f.refs.length, 1); assert.equal(f.refs[0].closes, 1);
    assert.equal(f.root.loader.resolve("include:feature").fiber, undefined);
  } finally { await f.close(); }
}));

test("structural intent and receipt failures leave no pending intent or candidate plugin", () => fixture(async directory => {
  const f = await start(directory);
  try {
    const commit = f.store.commit.bind(f.store);
    f.store.commit = async () => { throw new ManagedPluginStoreError("management_save_failed"); };
    const next = entries([feature("feature"), feature("added", { value: 2 })]);
    await writeFile(f.filename, next);
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_save_failed" });
    assert.equal(entryView(f, "added"), undefined); assert.equal(f.refs.length, 1);
    assert.equal(f.store.snapshot().pending, null);
    let writes = 0;
    f.store.commit = async (...args) => { if (++writes === 2) throw new ManagedPluginStoreError("management_save_failed"); return commit(...args); };
    await assert.rejects(f.control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(entryView(f, "added"), undefined); assert.equal(f.store.snapshot().pending, null);
    await writeFile(f.filename, entries([feature("different")]));
    assert.doesNotThrow(() => new ManagedProfileSource(f.filename, "include", f.store.snapshot()));
    f.store.commit = commit;
  } finally { await f.close(); }
}));

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
    const queued = assert.rejects(f.change("disabled"), { code: "management_revision_conflict" });
    await writeFile(f.filename, deployment(2)); const config = f.control.reloadConfiguration();
    assert.equal(f.refs.length, 1); release.resolve(); await batch; await queued; await config;
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
    cancel.abort(Error("watcher closed")); await assert.rejects(batch, { code: "plugin_change_cancelled" });
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

test("managed Include changes are part of one revision, preserve nested file bytes and survive restart", () => fixture(async directory => {
  const nested = join(directory, "nested.json");
  const initial = JSON.stringify([feature("feature", { value: 1 })]);
  await writeFile(nested, initial);
  await writeFile(join(directory, "cordis.yml"), JSON.stringify([{ id: "bundle", name: "@deepseek-ai/cordis-plugin-include", config: { path: "./nested.json" } }]));
  let f = await start(directory);
  try {
    const digest = f.control.snapshot().configuration.digest;
    assert.deepEqual(new Set(f.control.configurationFiles()), new Set([f.filename, nested]));
    assert.equal(f.refs.at(-1).request(), 1);
    await f.change("disabled");
    const updated = JSON.stringify([feature("feature", { value: 2 }), feature("added", { value: 3 })]);
    await writeFile(nested, updated);
    await f.control.reloadConfiguration();
    assert.notEqual(f.control.snapshot().configuration.digest, digest);
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    assert.equal(f.root.loader.resolve("include:added").fiber.state, 2);
    assert.equal(await readFile(nested, "utf8"), updated);
    await f.change("inherit");
    assert.equal(f.refs.at(-1).request(), 2);
    await f.close(); f = undefined;
    f = await start(directory);
    assert.deepEqual(f.refs.map(ref => ref.value).sort(), [2, 3]);
  } finally { await f?.close(); }
}));

test("nested Include cycles, duplicate IDs and unknown patches fail before stopping old owners", () => fixture(async directory => {
  const nested = join(directory, "nested.json");
  const f = await start(directory);
  try {
    await writeFile(nested, JSON.stringify([{ id: "back", name: "cordis:include", config: { path: "./cordis.yml" } }]));
    await writeFile(f.filename, JSON.stringify([{ id: "bundle", name: "cordis:include", config: { path: "./nested.json" } }]));
    await assert.rejects(f.control.reloadConfiguration());
    assert.equal(f.refs[0].closes, 0);
    await writeFile(nested, JSON.stringify([feature("feature"), feature("feature")]));
    await assert.rejects(f.control.reloadConfiguration());
    assert.equal(f.refs[0].closes, 0);
    await writeFile(nested, JSON.stringify([feature("feature")]));
    await writeFile(f.filename, JSON.stringify([{ id: "bundle", name: "cordis:include", config: { path: "./nested.json", patches: [{ id: "missing", config: {} }] } }]));
    await assert.rejects(f.control.reloadConfiguration());
    assert.equal(f.refs[0].closes, 0);
    assert.equal(f.store.snapshot().pending, null);
  } finally { await f.close(); }
}));

test("Root watcher observes an included file and drops a removed Include subscription", () => fixture(async directory => {
  const nested = join(directory, "nested.json");
  await writeFile(nested, JSON.stringify([feature("feature", { value: 1 })]));
  await writeFile(join(directory, "cordis.yml"), JSON.stringify([{ id: "bundle", name: "cordis:include", config: { path: "./nested.json" } }]));
  const f = await start(directory);
  try {
    await startManagedConfigurationWatch(f.root, f.control, f.filename);
    await writeFile(nested, JSON.stringify([feature("feature", { value: 2 })]));
    await eventually(() => f.refs.at(-1)?.value === 2);
    await writeFile(f.filename, deployment(3));
    await eventually(() => f.refs.at(-1)?.value === 3);
    assert.deepEqual(f.control.configurationFiles(), [f.filename]);
  } finally { await f.close(); }
}));

async function eventually(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("managed Include watch timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("Include resolves relative modules at their source while existing root preference identities stay stable", () => fixture(async directory => {
  const { mkdir } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "plugins.json"), JSON.stringify([{ id: "child", name: "./child.mjs" }]));
  await writeFile(join(directory, "cordis.yml"), JSON.stringify([
    { id: "local", name: "./local.mjs" }, { id: "bundle", name: "cordis:include", config: { path: "./nested/plugins.json" } },
  ]));
  const state = { schemaVersion: 1, revision: "previous", pending: null, receipts: [],
    preferences: { "include:local": { name: "./local.mjs", preference: "disabled" } } };
  const source = new ManagedProfileSource(join(directory, "cordis.yml"), "include", state);
  assert.equal(source.original("include:local").name, "./local.mjs");
  assert.equal(source.entries[0].disabled, true);
  assert.equal(source.original("include:child").name, pathToFileURL(join(directory, "nested", "child.mjs")).href);
}));
