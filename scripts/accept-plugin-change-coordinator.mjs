import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import {
  installPluginChangeCoordinator,
  PluginChangeError,
} from "../dist/boot/plugin-control/change-coordinator.js";
import { SafePluginChangeTransaction } from "../dist/boot/plugin-control/safe-change.js";

const deferred = () => Promise.withResolvers();

function withJournal(changes) {
  const operations = new Map(), writes = [];
  changes.attachJournal({
    latest: () => [...operations.values()].at(-1) ?? null,
    record: async operation => {
      writes.push(operation);
      operations.set(operation.id, operation);
    },
  });
  return { operations, writes };
}

test("accepted changes are durable, FIFO and serialized under one top-level identity", async () => {
  const root = new Context();
  try {
    const changes = installPluginChangeCoordinator(root), journal = withJournal(changes);
    const phases = [], entered = deferred(), finish = deferred();
    let secondStarted = false;
    changes.subscribe(() => {
      const phase = changes.snapshot().active?.phase;
      if (phase && phases.at(-1) !== phase) phases.push(phase);
    });
    const first = changes.submit({ kind: "replace", source: "hmr" }, async scope => {
      await scope.target(["include:feature"]);
      await scope.phase("waiting-safe-point");
      await scope.phase("fencing");
      await scope.phase("draining");
      await scope.phase("staging");
      await scope.phase("switching");
      await scope.phase("retiring");
      await scope.phase("verifying");
      entered.resolve();
      await finish.promise;
      return "done";
    });
    await first.accepted;
    await entered.promise;
    assert.deepEqual(phases, ["queued", "preflight", "waiting-safe-point", "fencing", "draining", "staging", "switching", "retiring", "verifying"]);
    const second = changes.submit({ kind: "disable", source: "standalone-stop", requestId: "second" }, async () => {
      secondStarted = true;
      return "second";
    });
    const accepted = await second.accepted;
    assert.equal(journal.operations.get(accepted.id).phase, "queued");
    assert.deepEqual(changes.snapshot().queued.map(operation => operation.id), [accepted.id]);
    assert.equal(secondStarted, false);
    finish.resolve();
    assert.equal(await first.completion, "done");
    assert.equal(await second.completion, "second");
    assert.deepEqual(changes.snapshot().queued, []);
    assert.equal(changes.snapshot().last.phase, "succeeded");
    assert.equal(journal.operations.get(accepted.id).phase, "succeeded");
  } finally { await root.fiber.dispose(); }
});

test("phase persistence is awaited and regressions reject with a stable code", async () => {
  const root = new Context();
  try {
    const changes = installPluginChangeCoordinator(root); withJournal(changes);
    await assert.rejects(changes.run({ kind: "enable", source: "management", requestId: "request" }, async scope => {
      await scope.phase("switching");
      await scope.phase("staging");
    }), error => error instanceof PluginChangeError && error.code === "plugin_change_phase_regression");
    assert.equal(changes.snapshot().last.phase, "rejected");
    assert.equal(changes.snapshot().last.code, "plugin_change_phase_regression");
  } finally { await root.fiber.dispose(); }
});

test("queued and waiting changes cancel, but fenced changes cannot be cancelled", async () => {
  const root = new Context();
  try {
    const changes = installPluginChangeCoordinator(root); withJournal(changes);
    const entered = deferred();
    const first = changes.submit({ kind: "replace", source: "hmr" }, async scope => {
      await scope.phase("waiting-safe-point");
      entered.resolve();
      await new Promise((_, reject) => {
        const abort = () => reject(scope.signal.reason);
        scope.signal.addEventListener("abort", abort, { once: true });
        if (scope.signal.aborted) abort();
      });
    });
    await first.accepted; await entered.promise;
    assert.equal(changes.cancel(first.id), true);
    await assert.rejects(first.completion, { code: "plugin_change_cancelled" });
    assert.equal(changes.snapshot().last.phase, "rejected");

    const hold = deferred(), active = deferred();
    const second = changes.submit({ kind: "disable", source: "management" }, async scope => {
      await scope.phase("fencing"); active.resolve(); await hold.promise;
    });
    await second.accepted; await active.promise;
    const queued = changes.submit({ kind: "enable", source: "management" }, async () => {});
    await queued.accepted;
    assert.equal(changes.cancel(queued.id), true);
    await assert.rejects(queued.completion, { code: "plugin_change_cancelled" });
    assert.equal(changes.cancel(second.id), false);
    hold.resolve(); await second.completion;
  } finally { await root.fiber.dispose(); }
});

test("recovery marking remains active until owned work settles and later work stays queued", async () => {
  const root = new Context();
  try {
    const changes = installPluginChangeCoordinator(root); withJournal(changes);
    const marked = deferred(), finish = deferred(), laterEntered = deferred();
    const running = changes.run({ kind: "reconfigure", source: "configuration" }, async scope => {
      await scope.recovery("management_apply_failed");
      marked.resolve();
      await finish.promise;
      throw Error("private failure");
    });
    await marked.promise;
    assert.equal(changes.snapshot().active.phase, "recovery-required");
    const later = changes.submit({ kind: "enable", source: "management" }, async () => { laterEntered.resolve(); });
    await later.accepted;
    assert.equal(changes.snapshot().queued.length, 1);
    finish.resolve();
    await assert.rejects(running, /private failure/);
    await later.completion;
    assert.equal(changes.snapshot().last.phase, "succeeded");
  } finally { await root.fiber.dispose(); }
});

test("Root disposal aborts active and queued scopes and rejects future changes", async () => {
  const root = new Context();
  const changes = installPluginChangeCoordinator(root); withJournal(changes);
  const entered = deferred();
  const running = changes.run({ kind: "disable", source: "standalone-stop" }, async scope => {
    entered.resolve();
    await new Promise((_, reject) => {
      const abort = () => reject(scope.signal.reason);
      scope.signal.addEventListener("abort", abort, { once: true });
      if (scope.signal.aborted) abort();
    });
  });
  await entered.promise;
  await root.fiber.dispose();
  await assert.rejects(running, { code: "plugin_change_closed" });
  assert.equal(changes.snapshot().last.code, "plugin_change_closed");
  assert.throws(() => changes.run({ kind: "enable", source: "management" }, async () => {}), { code: "plugin_change_closed" });
});

test("Root disposal during admission still records a terminal queued operation", async () => {
  const root = new Context(), changes = installPluginChangeCoordinator(root), release = deferred();
  const operations = new Map();
  changes.attachJournal({ latest: () => null, record: async operation => {
    if (operation.phase === "queued") await release.promise;
    operations.set(operation.id, operation);
  } });
  const handle = changes.submit({ kind: "enable", source: "management" }, async () => {
    throw Error("queued task must not execute");
  });
  const closing = root.fiber.dispose();
  release.resolve();
  await handle.accepted;
  await assert.rejects(handle.completion, { code: "plugin_change_closed" });
  await closing;
  assert.equal(operations.get(handle.id).phase, "rejected");
  assert.equal(operations.get(handle.id).code, "plugin_change_closed");
});

test("safe change failure distinguishes unchanged, restored and unverified runtime", async () => {
  const unchanged = new SafePluginChangeTransaction();
  assert.deepEqual(await unchanged.fail({ rejected: "unchanged", rolledBack: "restored", recovery: "isolated" }),
    { phase: "rejected", code: "unchanged", restored: false });

  let restored = 0;
  const recoverable = new SafePluginChangeTransaction();
  recoverable.changed({ restore: async () => { restored++; }, verify: () => true });
  assert.deepEqual(await recoverable.fail({ rejected: "unchanged", rolledBack: "restored", recovery: "isolated" }),
    { phase: "rejected", code: "restored", restored: true });
  assert.equal(restored, 1);

  const uncertain = new SafePluginChangeTransaction();
  uncertain.changed({ restore: async () => {}, verify: () => false });
  assert.deepEqual(await uncertain.fail({ rejected: "unchanged", rolledBack: "restored", recovery: "isolated" }),
    { phase: "recovery-required", code: "isolated", restored: false });
});
