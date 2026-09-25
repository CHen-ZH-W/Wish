import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import {
  installPluginOwnerRegistry,
  registerPluginOwner,
} from "../dist/boot/plugin-control/owner-registry.js";

test("one canonical declaration supplies stop and replacement from the same Fiber generation", async () => {
  const root = new Context();
  try {
    const registry = installPluginOwnerRegistry(root);
    let owner, fenced = false, deactivated = 0, prepared;
    await root.plugin(ctx => {
      owner = ctx;
      registerPluginOwner(ctx, {
        replacement: "drain",
        status: () => ({ disposition: "direct", code: "sample_idle" }),
        prepare(change) {
          assert.equal(fenced, false);
          fenced = true; prepared = change;
          return {
            drained: Promise.resolve(),
            deactivate: async () => { deactivated += 1; },
            release: () => { fenced = false; },
          };
        },
      });
    });
    const id = owner.fiber.uid;
    const coverage = registry.coverage(id);
    assert.equal(coverage.lifecycle, "managed");
    assert.equal(coverage.codeReload, "registered");
    assert.ok(coverage.registrationId);

    const record = registry.record(id);
    assert.equal(record.canonical, true);
    assert.equal(record.id, coverage.registrationId);
    assert.equal(record.replacement, "drain");
    const replacement = registry.prepare(record, { kind: "replace", source: "hmr" });
    assert.deepEqual(prepared, { kind: "replace", source: "hmr" }); assert.equal(fenced, true);
    await replacement.drained; replacement.release(); assert.equal(fenced, false);
    const reconfigure = registry.prepare(registry.record(id), { kind: "reconfigure", source: "configuration", entryIds: ["feature"] });
    assert.deepEqual(prepared, { kind: "reconfigure", source: "configuration", entryIds: ["feature"] });
    reconfigure.release(); assert.equal(fenced, false);
    const disable = registry.prepare(registry.record(id), { kind: "disable", source: "standalone-stop" });
    assert.deepEqual(prepared, { kind: "disable", source: "standalone-stop" }); await disable.deactivate();
    assert.equal(deactivated, 1);

    const beforeConflict = registry.coverage(id);
    assert.throws(() => registry.registerLifecycle(owner, () => ({ disposition: "direct", code: "duplicate" })), /already registered/);
    assert.deepEqual(registry.coverage(id), beforeConflict, "a rejected duplicate must not partially mutate the record");

    const stale = registry.record(id);
    await owner.fiber.dispose();
    assert.deepEqual(registry.coverage(id), { registrationId: null, lifecycle: "unregistered", codeReload: "unregistered" });
    assert.throws(() => registry.prepare(stale, { kind: "replace", source: "hmr" }), /plugin_owner_changed/);
  } finally { await root.fiber.dispose(); }
});

test("legacy lifecycle and reload APIs merge into one record and reject contradictory replacement policy", async () => {
  const root = new Context();
  try {
    const registry = installPluginOwnerRegistry(root);
    let owner, released = 0;
    await root.plugin(ctx => {
      owner = ctx;
      registry.registerLifecycle(ctx, () => ({ disposition: "direct", code: "legacy_idle" }), () => ({
        close: async () => {}, release: () => { released += 1; },
      }));
      registry.registerReplacement(ctx, { prepare: () => ({ drained: Promise.resolve(), release: () => { released += 1; } }) });
    });
    const id = owner.fiber.uid;
    const coverage = registry.coverage(id);
    assert.deepEqual({ lifecycle: coverage.lifecycle, codeReload: coverage.codeReload }, { lifecycle: "managed", codeReload: "registered" });
    assert.equal(registry.record(id).canonical, false, "split compatibility declarations are not a canonical managed owner");
    assert.equal(registry.recordsWithStatus().filter(record => record.fiberId === id).length, 1);

    const stop = registry.prepare(registry.record(id), { kind: "disable", source: "standalone-stop" });
    await stop.drained; await stop.deactivate(); stop.release();
    const replace = registry.prepare(registry.record(id), { kind: "replace", source: "hmr" });
    await replace.drained; await replace.release();
    assert.equal(released, 2);

    const beforeConflict = registry.coverage(id);
    assert.throws(() => registry.registerRestart(owner), /already registered/);
    assert.deepEqual(registry.coverage(id), beforeConflict);
  } finally { await root.fiber.dispose(); }
});

test("restart debt is represented by the same record without claiming managed conformance", async () => {
  const root = new Context();
  try {
    const registry = installPluginOwnerRegistry(root);
    let id;
    await root.plugin(ctx => {
      id = ctx.fiber.uid;
      registry.registerRestartOwner(ctx, () => ({ disposition: "restart", code: "legacy_restart_required" }));
    });
    const coverage = registry.coverage(id);
    assert.equal(coverage.lifecycle, "observe-only");
    assert.equal(coverage.codeReload, "restart");
    assert.ok(coverage.registrationId);
    assert.equal(registry.record(id).canonical, false);
    assert.throws(() => registry.prepare(registry.record(id), { kind: "disable", source: "standalone-stop" }), /plugin_owner_unsupported/);
    assert.throws(() => registry.prepare(registry.record(id), { kind: "replace", source: "hmr" }), /plugin_owner_unsupported/);
  } finally { await root.fiber.dispose(); }
});

test("managed configuration updates wait for the current Fiber generation before restarting", async () => {
  const root = new Context();
  const releaseFirst = Promise.withResolvers();
  const activations = [];
  try {
    installPluginOwnerRegistry(root);
    const plugin = async (ctx, config) => {
      registerPluginOwner(ctx, {
        replacement: "generation",
        status: () => ({ disposition: "direct", code: "queued_update_idle" }),
        prepare: () => ({
          drained: Promise.resolve(),
          deactivate: async () => {},
          release: () => {},
        }),
      });
      activations.push(config.value);
      if (activations.length === 2) {
        await releaseFirst.promise;
      }
    };
    const fiber = await root.plugin(plugin, { value: 0 });
    const first = fiber.update({ value: 1 });
    const second = fiber.update({ value: 2 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(activations, [0, 2], "the queued update entered the loading generation");
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(activations, [0, 2, 2]);
    assert.equal(fiber.config.value, 2);
    assert.equal(fiber.state, 2);
  } finally {
    releaseFirst.resolve();
    await root.fiber.dispose();
  }
});
