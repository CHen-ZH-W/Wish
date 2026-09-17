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
import { installPluginLifecycle, registerPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { ManagedPluginStore } from "../dist/boot/plugin-control/managed-store.js";
import { ManagedProfileSource, managedProfilePlugin } from "../dist/boot/plugin-control/managed-profile.js";
import { ManagedPluginControl } from "../dist/boot/plugin-control/managed-control.js";

const profileText = "# preserve deployment bytes\n- id: app\n  name: cordis:group\n  group: true\n  config:\n    - id: feature\n      name: cordis:feature\n      disabled: !!js launch.blocked\n";
async function start(directory, options = {}) {
  const root = new Context();
  await root.plugin(Loader); root.provide("launch", { blocked: options.blocked ?? false });
  const inspection = installPluginInspection(root); installPluginLifecycle(root, inspection);
  const store = await ManagedPluginStore.open(join(directory, "managed.json"));
  const control = new ManagedPluginControl(root, inspection, store);
  const source = new ManagedProfileSource(join(directory, "cordis.yml"), "include", store.snapshot());
  const refs = [];
  Object.assign(root.loader.builtins, { group: Group, profile: managedProfilePlugin(source, profile => control.attach(profile)), feature: {
    apply(ctx) {
      let accepting = true, closed = false;
      const ref = { request() { if (!accepting || closed) throw Error("admission_closed"); }, closes: 0 }; refs.push(ref);
      const close = async () => { ref.closes++; await options.close?.(); closed = true; };
      registerPluginLifecycle(ctx, () => ({ disposition: options.busy ? "blocked" : "direct", code: options.busy ? "owner_busy" : "owner_idle" }),
        () => { accepting = false; return { close, release: () => { if (!closed) accepting = true; } }; });
      ctx.effect(() => () => { closed = true; });
    },
  } });
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
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    assert.equal(f.refs[0].closes, 1); assert.throws(() => f.refs[0].request(), /admission_closed/);
    assert.deepEqual(await f.control.change(off), receipt);
    await assert.rejects(f.control.change({ ...off, preference: "enabled" }), { code: "management_request_conflict" });
    await assert.rejects(f.control.change({ ...off, requestId: "stale" }), { code: "management_revision_conflict" });
    assert.equal((await f.control.change(request(f, "enabled"))).status, "succeeded");
    assert.equal(f.root.loader.resolve("include:feature").disabled, false);
    assert.equal(f.refs.length, 2); f.refs[1].request();
    assert.deepEqual(f.root.loader.resolve("include:feature").options.disabled, { __jsExpr: "launch.blocked" });
    assert.equal(await readFile(join(directory, "cordis.yml"), "utf8"), profileText);
    assert.ok(events.includes("working")); assert.equal(events.at(-1), "ready");
  } finally { await f.close(); }
}));
test("enabled preference never overrides deployment gate and reset removes only user preference", () => fixture(async directory => {
  const f = await start(directory, { blocked: true });
  try {
    assert.equal((await f.control.change(request(f, "enabled"))).status, "succeeded");
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
    assert.equal(f.refs.length, 0);
    assert.equal((await f.control.change(request(f, "inherit"))).status, "succeeded");
    assert.deepEqual(f.control.snapshot().preferences, {});
    assert.equal(f.root.loader.resolve("include:feature").disabled, true);
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
