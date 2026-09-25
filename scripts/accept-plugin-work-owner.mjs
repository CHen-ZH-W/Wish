import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { PluginWorkOwner } from "../dist/boot/plugin-control/work-owner.js";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { installPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(run, options = {}) {
  const root = new Context(); let owner, participant, activate;
  try {
    await root.plugin(Loader);
    const inspection = installPluginInspection(root), lifecycle = installPluginLifecycle(root, inspection);
    if (options.codeReload) root.provide("codeReload", {
      register() { throw Error("PluginWorkOwner must use the unified Owner Registry"); },
      startWhenReady(_ctx, start) { activate = start; },
    });
    root.loader.builtins.sample = { apply(ctx) { owner = new PluginWorkOwner(ctx, { code: "sample", ...options }); } };
    await root.loader.create({ id: "sample", name: "cordis:sample" });
    if (options.codeReload) {
      const fiberId = inspection.inspect().entries.find(entry => entry.id === "sample").fiberId;
      const record = root.pluginOwners.record(fiberId);
      participant = { prepare: () => root.pluginOwners.prepare(record, { kind: "replace" }) };
    }
    const selection = { instanceId: inspection.inspect().instanceId, entryIds: ["sample"] };
    const prepare = async () => root.pluginLifecycle.prepareStop(await lifecycle.collect(selection), selection);
    await run({ root, owner, prepare, participant, activate, status: async () => (await lifecycle.collect(selection)).owners[0].status });
  } finally { await root.fiber.dispose(); }
}

test("a stop fence drains admitted work, rejects retained entrypoints and never runs cleanup early", async () => {
  const finish = deferred(); let cleaned = 0, started = 0;
  await fixture(async ({ owner, prepare, status }) => {
    const work = owner.run(async () => { started++; await finish.promise; return 42; });
    assert.equal((await status()).disposition, "drain");
    const prepared = await prepare();
    await assert.rejects(owner.run(() => { started++; }), /sample_closed/);
    assert.throws(() => owner.assertOpen(), /sample_closed/);
    let done = false;
    const closing = prepared.guards[0].close().then(() => { done = true; });
    try {
      await Promise.resolve(); assert.equal(done, false); assert.equal(cleaned, 0);
    } finally { finish.resolve(); }
    assert.equal(await work, 42); await closing;
    assert.equal(started, 1); assert.equal(cleaned, 1);
    prepared.release(); await assert.rejects(owner.run(() => 1), /sample_closed/);
    await owner.close(); assert.equal(cleaned, 1);
  }, { close() { cleaned++; } });
});

test("abandoning a prepared stop reopens admission and release is idempotent", async () => {
  await fixture(async ({ owner, prepare }) => {
    const prepared = await prepare();
    await assert.rejects(owner.run(() => 1), /sample_closed/);
    prepared.release(); prepared.release();
    assert.equal(await owner.run(() => 2), 2);
  });
});

test("immediate disposal finishes calls admitted before their microtask begins", async () => {
  await fixture(async ({ root, owner }) => {
    let calls = 0;
    const work = owner.run(() => ++calls);
    const disposal = root.loader.resolve("sample").update({ disabled: true });
    assert.equal(await work, 1); await disposal;
    await assert.rejects(owner.run(() => ++calls), /sample_closed/);
    assert.equal(calls, 1);
  });
});

test("failed calls release accounting and cleanup failures remain failures", async () => {
  const root = new Context(); let owner;
  await root.plugin({ apply(ctx) { owner = new PluginWorkOwner(ctx, { code: "failed", close() { throw Error("cleanup failed"); } }); } });
  await assert.rejects(owner.run(() => { throw Error("call failed"); }), /call failed/);
  const first = owner.close();
  await assert.rejects(first, /cleanup failed/);
  assert.equal(owner.close(), first);
  await assert.rejects(owner.close(), /cleanup failed/);
  // Cordis reports failed effect disposal; the owner must not hide that failure.
  await root.fiber.dispose().catch(error => assert.match(String(error), /cleanup failed/));
});

test("reload drains old calls and a successor stays closed until activation is committed", async () => {
  const finish = deferred();
  await fixture(async ({ owner, participant, activate }) => {
    await assert.rejects(owner.run(() => 0), /sample_closed/);
    assert.doesNotThrow(() => owner.assertAttached(), "activation can register synchronous contributions before the receipt");
    activate();
    const work = owner.run(() => finish.promise);
    const prepared = participant.prepare();
    assert.throws(() => owner.assertAttached(), /sample_closed/, "a retired generation cannot register new contributions");
    let drained = false; void prepared.drained.then(() => { drained = true; });
    try { await Promise.resolve(); assert.equal(drained, false); await assert.rejects(owner.run(() => 0), /sample_closed/); }
    finally { finish.resolve(3); }
    assert.equal(await work, 3); await prepared.drained;
    prepared.release(); assert.equal(await owner.run(() => 4), 4);
  }, { codeReload: true });
});

test("domain owners may refuse stopping while accepted work remains", async () => {
  const finish = deferred();
  await fixture(async ({ owner, status }) => {
    const work = owner.run(() => finish.promise);
    try { assert.equal((await status()).disposition, "blocked"); }
    finally { finish.resolve(); }
    await work; assert.equal((await status()).disposition, "direct");
  }, { busy: "blocked" });
});

test("a streaming call owns the gaps between chunks and iterator cancellation drains it", async () => {
  let finalized = false;
  await fixture(async ({ owner, prepare, status }) => {
    const unused = owner.stream(async function* () { yield 9; });
    const stream = owner.stream(async function* () {
      try { yield 1; yield 2; } finally { finalized = true; }
    });
    assert.deepEqual(await stream.next(), { value: 1, done: false });
    assert.equal((await status()).disposition, "drain");
    const prepared = await prepare(); let closed = false;
    const closing = prepared.guards[0].close().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    await assert.rejects(unused.next(), /sample_closed/);
    await stream.return(); await closing;
    assert.equal(finalized, true); assert.equal(closed, true);
  });
});

test("only a same-Root loading dependent can reconcile against an uncommitted successor", async () => {
  await fixture(async ({ root, owner, activate }) => {
    await assert.rejects(owner.runDuringActivation(root, () => 1), /sample_closed/);
    let value;
    await root.plugin({ async apply(ctx) {
      value = await owner.runDuringActivation(ctx, () => 42);
      await assert.rejects(owner.run(() => 1), /sample_closed/);
    } });
    assert.equal(value, 42);
    activate(); await owner.close();
    await root.plugin({ async apply(ctx) {
      await assert.rejects(owner.runDuringActivation(ctx, () => 1), /sample_closed/);
    } });
  }, { codeReload: true });
});

test("retirement cancels only the owner's wait before draining and keeps cleanup exactly once", async () => {
  const entered = deferred(), cancelled = deferred(); let cleaned = 0;
  await fixture(async ({ root, owner }) => {
    const waiting = owner.run(async () => { entered.resolve(); await cancelled.promise; return "cancelled"; });
    await entered.promise;
    await root.loader.resolve("sample").update({ disabled: true });
    assert.equal(await waiting, "cancelled");
    assert.equal(cleaned, 1);
    await owner.close(); assert.equal(cleaned, 1);
  }, { beforeDrain: () => cancelled.resolve(), close: () => { cleaned++; } });
});

test("a post-commit activation failure keeps Step admission closed", async () => {
  const { installCodeReload } = await import("../dist/boot/plugin-control/code-reload.js");
  const { StepExecutionCoordinator } = await import("../dist/composition/step-execution.js");
  const root = new Context();
  try {
    await root.plugin(Loader);
    const inspection = installPluginInspection(root);
    installCodeReload(root, inspection);
    const boundary = new StepExecutionCoordinator();
    await root.plugin(ctx => ctx.root.codeReload.registerBoundary(ctx, boundary));
    let committed = false;
    await assert.rejects(root.codeReload.pauseConfiguration([], async () => {
      await root.plugin(ctx => {
        ctx.root.codeReload.register(ctx);
        ctx.root.codeReload.startWhenReady(ctx, () => { throw Error("activation failed after commit"); });
      });
      committed = true;
    }, { signal: new AbortController().signal, uncertain: () => false }), /activation failed/);
    assert.equal(committed, true);
    assert.equal(boundary.snapshot().phase, "failed");
    assert.equal(root.codeReload.snapshot().phase, "recovery-required");
  } finally { await root.fiber.dispose(); }
});

test("post-reload activation removes its one-shot Fiber effect after commit", async () => {
  const { installCodeReload } = await import("../dist/boot/plugin-control/code-reload.js");
  const root = new Context();
  try {
    await root.plugin(Loader);
    const inspection = installPluginInspection(root);
    installCodeReload(root, inspection);
    let owner, starts = 0;
    await root.codeReload.pauseConfiguration([], async () => {
      owner = await root.plugin(ctx => {
        ctx.root.codeReload.register(ctx);
        ctx.root.codeReload.startWhenReady(ctx, () => { starts++; });
      });
      assert.equal(owner.getEffects().some(effect => effect.label === "post-reload activation"), true);
    }, { signal: new AbortController().signal, uncertain: () => false });
    assert.equal(starts, 1);
    assert.equal(owner.getEffects().some(effect => effect.label === "post-reload activation"), false);
  } finally { await root.fiber.dispose(); }
});
