import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Context } from "@deepseek-ai/cordis";
import { PluginStateRegistry, FilePluginStatePersistence } from "../dist/plugin-state/index.js";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { headlessManagement } from "../dist/boot/plugin-control/headless-management.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error("condition timeout"); await delay(20); } };
const identity = version => ({ pluginId: "counter", pluginVersion: String(version), artifactDigest: String(version).repeat(64), schemaVersion: version });
function counter(version = 1, options = {}) {
  let value = version === 1 ? 0 : { total: 0 };
  const definition = { identity: identity(version), readableVersions: [version],
    validate(v) { assert.ok(version === 1 ? Number.isInteger(v) : v && Number.isInteger(v.total)); },
    snapshot: () => value, restore(saved) { value = saved.value; }, ...options };
  return { definition, get: () => value, set: next => { value = next; } };
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-state-")), root = new Context();
  let registry = new PluginStateRegistry(() => FilePluginStatePersistence.open(directory));
  try { await run({ directory, root, get registry() { return registry; }, async restart(committed = () => false) {
    await registry.close(); registry = new PluginStateRegistry(() => FilePluginStatePersistence.open(directory), committed); return registry;
  } }); }
  finally { await root.fiber.dispose(); await registry.close(); await rm(directory, { recursive: true, force: true }); }
}

test("private state owns a single writer, serializes mutations and restores durable data after unload/restart", () => fixture(async f => {
  const state = counter(), owner = await f.root.plugin({ name: "counter-owner", apply() {} }), handle = await f.registry.open(owner.ctx, state.definition, "slot");
  await assert.rejects(f.registry.open(owner.ctx, state.definition, "slot"), /already_owned/);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const running = handle.run(async () => { entered.resolve(); await release.promise; state.set(7); });
  await entered.promise; const closing = handle.close(); let closed = false; void closing.then(() => { closed = true; });
  await delay(10); assert.equal(closed, false); await assert.rejects(handle.run(() => state.set(99)), /closed/);
  release.resolve(); await running; await closing;
  const saved = await f.registry.inspect("slot/counter"); assert.equal(saved.value, 7); assert.equal(saved.writer.pluginVersion, "1");
  const closingRegistry = f.registry.close(); assert.equal(f.registry.close(), closingRegistry); await closingRegistry;
  await assert.rejects(handle.run(() => state.set(100)), /closed/);
  await f.restart();
  const next = counter(), second = await f.root.plugin({ name: "second-owner", apply() {} });
  await f.registry.open(second.ctx, next.definition, "slot"); assert.equal(next.get(), 7);
  saved.value = 88; assert.equal((await f.registry.inspect("slot/counter")).value, 7, "readers receive detached state");
}));

test("a second process/store cannot write the same private-state directory", () => fixture(async f => {
  await f.registry.inspect("absent");
  await assert.rejects(FilePluginStatePersistence.open(f.directory), /store_locked/);
}));

test("stateless startup and changes require no private-state provider or callbacks", async () => {
  let opened = 0; const registry = new PluginStateRegistry(async () => { opened++; throw Error("must stay lazy"); });
  await registry.begin("startup", ["*"]); await registry.finish(true);
  await registry.begin("replace-stateless", ["slot"]); await registry.finish(true);
  await registry.close(); await assert.rejects(registry.inspect("slot"), /closed/);
  await assert.rejects(registry.begin("after-close", ["slot"]), /closed/); assert.equal(opened, 0);
});

test("incompatible state is rejected; migration stages new data and failure restores the retained checkpoint", () => fixture(async f => {
  const first = counter(), a = await f.root.plugin({ name: "v1", apply() {} }), old = await f.registry.open(a.ctx, first.definition, "slot");
  await old.run(() => first.set(11)); const before = await f.registry.inspect("slot/counter");
  await f.registry.begin("upgrade", ["slot"]); await old.close();
  const b = await f.root.plugin({ name: "v2", apply() {} });
  await assert.rejects(f.registry.open(b.ctx, counter(2).definition, "slot"), /incompatible/);
  const next = counter(2, { migratableVersions: [1], migrate: saved => ({ total: saved.value }) });
  const upgraded = await f.registry.open(b.ctx, next.definition, "slot"); assert.deepEqual(next.get(), { total: 11 });
  await upgraded.run(() => next.set({ total: 900 }));
  assert.equal((await f.registry.inspect("slot/counter")).digest, before.digest, "uncommitted migration never replaces the current head");
  await f.registry.rollback(); await upgraded.close();
  const c = await f.root.plugin({ name: "restored-v1", apply() {} }), restored = counter();
  await f.registry.open(c.ctx, restored.definition, "slot"); await f.registry.finish(false);
  assert.equal(restored.get(), 11); assert.equal((await f.registry.inspect("slot/counter")).digest, before.digest);
}));

test("successful migrations publish only at the durable receipt boundary and retain immutable ancestry", () => fixture(async f => {
  const a = await f.root.plugin({ name: "version1", apply() {} }), first = counter(), old = await f.registry.open(a.ctx, first.definition, "slot");
  await old.run(() => first.set(21)); const before = await f.registry.inspect("slot/counter");
  await f.registry.begin("accepted-upgrade", ["slot"]); await old.close();
  const b = await f.root.plugin({ name: "version2", apply() {} }), next = counter(2, { migratableVersions: [1], migrate: s => ({ total: s.value }) });
  await f.registry.open(b.ctx, next.definition, "slot"); await f.registry.finish(true);
  const current = await f.registry.inspect("slot/counter");
  assert.equal(current.previous, before.digest); assert.equal(current.writer.schemaVersion, 2); assert.deepEqual(current.value, { total: 21 });
  await f.restart(); const c = await f.root.plugin({ name: "restart-v2", apply() {} }), restored = counter(2);
  await f.registry.open(c.ctx, restored.definition, "slot"); assert.deepEqual(restored.get(), { total: 21 });
}));

test("mutation and flush share a durability barrier; invalid snapshots never replace the prior state", () => fixture(async f => {
  const a = await f.root.plugin({ name: "bounded-state", apply() {} }), state = counter(), handle = await f.registry.open(a.ctx, state.definition, "slot");
  await handle.run(() => state.set(5)); const previous = await f.registry.inspect("slot/counter");
  await assert.rejects(handle.run(() => state.set(Infinity)), /invalid_value/);
  assert.equal((await f.registry.inspect("slot/counter")).digest, previous.digest);
  state.set(6); await handle.flush(); assert.equal((await f.registry.inspect("slot/counter")).value, 6);
}));

const workOwner = new URL("../dist/boot/plugin-control/work-owner.js", import.meta.url).href;
function plugin(version, fails = false) {
  return `import { PluginWorkOwner } from ${JSON.stringify(workOwner)};
export default { name: 'private-counter', async apply(ctx) {
  let value = ${version === 1 ? "0" : "{total:0}"};
  const state = await ctx.root.get('pluginState').open(ctx, {
    identity: { pluginId:'counter',pluginVersion:'${version}',schemaVersion:${version} }, readableVersions:[${version}],
    ${version > 1 ? "migratableVersions:[1],migrate:s=>({total:s.value})," : ""}
    validate(v) { if (!(${version === 1 ? "Number.isInteger(v)" : "v && Number.isInteger(v.total)"})) throw Error('invalid private counter'); },
    snapshot:()=>value,restore:s=>{value=s.value;}
  });
  new PluginWorkOwner(ctx,{code:'private_counter',codeReload:true});
  ctx.provide('privateCounter',{version:${version},read:()=>value,increment:()=>state.run(()=>{${version === 1 ? "value++" : "value.total++"};return value;})});
  ${fails ? "await state.run(()=>{value={total:999};});throw Error('candidate initialization failed');" : ""}
} };`;
}
function manifest(version) { return { apiVersion: "wish.plugin/v1", id: "counter", entry: `./v${version}.mjs`, managementClass: "managed", replacement: "drain",
  configSchema: { type: "object", additionalProperties: false }, permissions: { capabilities: [] }, sandbox: { isolation: "trusted-in-process", filesystem: "none", process: "none", network: "none" },
  state: { mode: "versioned", schemaVersion: version, readableVersions: [version], ...(version > 1 ? { migratableVersions: [1] } : {}) } }; }
async function realFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-private-state-host-")); let host;
  try {
    for (const version of [1, 2, 3]) { await writeFile(join(directory, `v${version}.mjs`), plugin(version, version === 3)); await writeFile(join(directory, `v${version}.json`), JSON.stringify(manifest(version))); }
    const entry = version => ({ id: "counter", name: pathToFileURL(join(directory, `v${version}.mjs`)).href, config: {}, management: { manifest: pathToFileURL(join(directory, `v${version}.json`)).href } });
    const config = join(directory, "cordis.json"); await writeFile(config, JSON.stringify([{ id: "app", name: "cordis:group", group: true, config: [entry(1)] }]));
    const start = () => bootstrap({ surface: "cli", cwd: directory, homeDirectory: directory, configurationFile: config,
      environment: { WISH_DATA_DIR: join(directory, "data") }, management: headlessManagement(join(directory, "management")) });
    host = await start();
    await run({ directory, entry, get host() { return host; }, async restart() { await host.dispose(); host = await start(); }, async change(version, restorePreviousState = false) {
      const current = await host.pluginManagement.deploymentSnapshot("counter");
      return host.pluginManagement.applyDeploymentOverlay({ requestId: `counter-${version}-${restorePreviousState}`, revision: current.revision, deploymentDigest: current.deploymentDigest,
        overlayDigest: current.overlayDigest, entries: [{ parentId: "app", entry: entry(version) }], ...(restorePreviousState ? { restorePreviousState: true } : {}) });
    } });
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test("actual Loader/Root configuration upgrades migrate private data, compensate failed activation and recover after restart", { timeout: 20000 }, () => realFixture(async f => {
  const first = f.host.context.get("privateCounter"); assert.ok(first, JSON.stringify(f.host.plugins.inspect()));
  await first.increment(); await first.increment();
  const before = await f.host.context.get("pluginState").inspect("include:counter/counter");
  await assert.rejects(f.change(3), /rolled_back/);
  await until(() => f.host.pluginManagement.snapshot().status === "ready"); assert.equal(f.host.context.get("privateCounter").read(), 2);
  assert.equal((await f.host.context.get("pluginState").inspect("include:counter/counter")).digest, before.digest);
  await f.change(2); assert.deepEqual(f.host.context.get("privateCounter").read(), { total: 2 });
  await f.host.context.get("privateCounter").increment(); await f.restart();
  assert.deepEqual(f.host.context.get("privateCounter").read(), { total: 3 });
  assert.equal(f.host.pluginManagement.snapshot().protocols.find(p => p.entryId === "include:counter").conformance, "online");
  await assert.rejects(f.change(1), /state_incompatible/);
  await f.change(1, true); assert.equal(f.host.context.get("privateCounter").read(), 2);
}));

test("managed disable flushes and releases private state; re-enable restores it without replaying mutations", { timeout: 20000 }, () => realFixture(async f => {
  const old = f.host.context.get("privateCounter"); await old.increment();
  const change = async preference => {
    await until(() => f.host.pluginManagement.snapshot().status === "ready");
    const snapshot = f.host.pluginManagement.snapshot();
    const receipt = await f.host.pluginManagement.change({ requestId: `state-${preference}`, revision: snapshot.revision, preference,
      selection: { instanceId: snapshot.inspection.instanceId, entryIds: ["include:counter"] } });
    assert.equal(receipt.status, "succeeded", receipt.code);
  };
  await change("disabled"); assert.equal(f.host.context.get("privateCounter"), undefined);
  await assert.rejects(old.increment(), /closed/);
  await change("enabled"); assert.equal(f.host.context.get("privateCounter").read(), 1);
}));

test("failed initialization after restart cannot publish a migrated snapshot or retain the writer lock", { timeout: 20000 }, () => realFixture(async f => {
  await f.host.context.get("privateCounter").increment(); await f.host.dispose();
  const configuration = version => JSON.stringify([{ id: "app", name: "cordis:group", group: true, config: [f.entry(version)] }]);
  await writeFile(join(f.directory, "cordis.json"), configuration(3));
  await assert.rejects(f.restart(), /candidate initialization failed/);
  await writeFile(join(f.directory, "cordis.json"), configuration(1)); await f.restart();
  assert.equal(f.host.context.get("privateCounter").read(), 1);
}));

test("state admission fences synchronously and replacement waits for the final durable checkpoint", () => fixture(async f => {
  const owner = await f.root.plugin({ name: "fenced-writer", apply() {} }), state = counter(), handle = await f.registry.open(owner.ctx, state.definition, "slot");
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const mutation = handle.run(async () => { entered.resolve(); await release.promise; state.set(42); }); await entered.promise;
  const prepared = f.registry.prepare(owner, Promise.resolve()); let ready = false; void prepared.drained.then(() => { ready = true; });
  await assert.rejects(handle.run(() => state.set(99)), /closed/); await delay(10); assert.equal(ready, false);
  release.resolve(); await mutation; await prepared.drained; assert.equal((await f.registry.inspect("slot/counter")).value, 42);
  prepared.release(); await handle.run(() => state.set(43));
}));

test("killed writers release on proven process death; uncommitted migrations are discarded and committed receipts retain new state", { timeout: 15000 }, async () => {
  for (const committed of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "wish-private-state-crash-")); let child, registry;
    try {
      child = spawn(process.execPath, [new URL("./fixtures/plugin-state-crash.mjs", import.meta.url).pathname, directory], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
      const message = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw Error(stderr); })]); assert.equal(message[0], "staged");
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      registry = new PluginStateRegistry(() => FilePluginStatePersistence.open(directory), id => committed && id === "crashed-upgrade");
      const saved = await registry.inspect("slot/counter"); assert.deepEqual(saved.value, committed ? { total: 13 } : 13);
    } finally { if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await registry?.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("native HMR hands off flushed state and restores the old module's original checkpoint after candidate failure", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-private-state-hmr-")); let host;
  try {
    const filename = join(directory, "v1.mjs"), config = join(directory, "cordis.json"); await writeFile(filename, plugin(1));
    await writeFile(config, JSON.stringify([
      { id: "timer", name: "cordis:timer" },
      { id: "hmr", name: "cordis:hmr", config: { root: ["."], debounce: 20 } },
      { id: "app", name: "cordis:group", group: true, config: [{ id: "counter", name: pathToFileURL(filename).href, config: {} }] },
    ]));
    host = await bootstrap({ surface: "cli", cwd: directory, homeDirectory: directory, configurationFile: config,
      environment: { WISH_DATA_DIR: join(directory, "data") }, management: headlessManagement(join(directory, "management")) });
    await host.context.get("privateCounter").increment(); const old = host.context.get("privateCounter");
    await delay(150); await writeFile(filename, plugin(2, true));
    await until(() => host.codeReload.snapshot().code === "code_reload_candidate_rolled_back");
    assert.equal(host.context.get("privateCounter").read(), 1); assert.notEqual(host.context.get("privateCounter"), old);
    await until(() => host.pluginManagement.snapshot().status === "ready");
    await delay(150); await writeFile(filename, plugin(2));
    await until(() => host.codeReload.snapshot().phase === "succeeded");
    assert.deepEqual(host.context.get("privateCounter").read(), { total: 1 });
    await host.context.get("privateCounter").increment();
    assert.deepEqual((await host.context.get("pluginState").inspect("include:counter/counter")).value, { total: 2 });
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("snapshot write failure rejects flush without publishing a new head; a later explicit flush can persist it", () => fixture(async f => {
  const persistence = await FilePluginStatePersistence.open(join(f.directory, "fault-provider")); let broken = false;
  const registry = new PluginStateRegistry(async () => ({
    readIndex: () => persistence.readIndex(), writeIndex: (...args) => persistence.writeIndex(...args), readSnapshot: hash => persistence.readSnapshot(hash),
    writeSnapshot: value => { if (broken) return Promise.reject(Error("disk write failed")); return persistence.writeSnapshot(value); }, close: () => persistence.close(),
  }));
  try {
    const owner = await f.root.plugin({ name: "fault-owner", apply() {} }), state = counter();
    const handle = await registry.open(owner.ctx, state.definition, "fault-slot"); await handle.run(() => state.set(4));
    const before = await registry.inspect("fault-slot/counter"); broken = true;
    await assert.rejects(handle.run(() => state.set(5)), /disk write failed/);
    assert.equal((await registry.inspect("fault-slot/counter")).digest, before.digest);
    broken = false; await handle.flush(); assert.equal((await registry.inspect("fault-slot/counter")).value, 5);
  } finally { broken = false; await registry.close(); }
}));

test("a failed registry close remains a failed shared result and never releases its writer exclusion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-state-close-failure-")), root = new Context();
  root.logger.exporter({ export() {} });
  const persistence = await FilePluginStatePersistence.open(directory), registry = new PluginStateRegistry(async () => persistence);
  let broken = false;
  try {
    const owner = await root.plugin({ name: "unflushed-owner", apply() {} });
    const state = counter(1, { snapshot: () => { if (broken) throw Error("snapshot unavailable"); return 1; } });
    await registry.open(owner.ctx, state.definition, "slot"); broken = true;
    const closing = registry.close(); assert.equal(registry.close(), closing);
    await assert.rejects(closing, /plugin_state_close_failed/);
    broken = false; assert.equal(registry.close(), closing); await assert.rejects(registry.close(), /plugin_state_close_failed/);
    await assert.rejects(FilePluginStatePersistence.open(directory), /store_locked/);
  } finally {
    // The failed writer stays fenced. Only this test's process-failure teardown
    // releases the physical provider; production close never forces it open.
    await root.fiber.dispose().catch(() => {}); await persistence.close(); await rm(directory, { recursive: true, force: true });
  }
});
