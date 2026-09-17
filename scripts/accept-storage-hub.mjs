import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { StorageHub } from "../dist/storage/index.js";

function fixtureBackend(id, options = {}) {
  let closed = false;
  const kv = {
    facet: "kv",
    async get() {
      if (closed) throw Object.assign(new Error("closed"), { code: "storage_closed" });
      return undefined;
    },
    async put() {
      return { revision: "fixture" };
    },
    async delete() {
      return { deleted: false };
    },
    ...(options.list === false ? {} : { async list() { return []; } }),
  };
  return {
    backend: {
      id,
      capabilities: Object.freeze({
        writerConcurrency: "process-local",
        kv: Object.freeze({ list: options.list !== false }),
      }),
      kv,
      async close() {
        closed = true;
        options.onClose?.();
      },
    },
    kv,
  };
}

test("Storage Hub registers named Backends and validates facets", async () => {
  const root = new Context();
  await root.plugin(StorageHub);
  let closes = 0;
  try {
    const first = fixtureBackend("file", { onClose: () => closes += 1 });
    const registration = root.storage.register(first.backend);
    assert.deepEqual(root.storage.ids(), ["file"]);
    assert.equal(root.storage.resolve("file", "kv"), first.kv);
    assert.equal(
      root.storage.backend("file", { kv: { list: true } }),
      first.backend,
    );
    assert.throws(
      () => root.storage.register(fixtureBackend("file").backend),
      (error) => error?.code === "storage_conflict",
    );
    assert.throws(
      () => root.storage.resolve("missing", "kv"),
      (error) => error?.code === "storage_backend_not_found",
    );
    assert.throws(
      () => root.storage.resolve("file", "blob"),
      (error) => error?.code === "storage_facet_unavailable",
    );
    assert.equal(await registration.unregister(), true);
    assert.equal(await registration.unregister(), false);
    assert.equal(closes, 1);
    assert.deepEqual(root.storage.ids(), []);
  } finally {
    await root.fiber.dispose();
  }
});

test("Storage Backend leases stop new admission and drain before close", async () => {
  const root = new Context();
  await root.plugin(StorageHub);
  let closes = 0;
  try {
    const fixture = fixtureBackend("leased", { onClose: () => closes += 1 });
    const registration = root.storage.register(fixture.backend);
    const lease = root.storage.acquire("leased", { kv: { list: true } });

    assert.equal(lease.id, "leased");
    assert.equal(lease.released, false);
    assert.equal(lease.backend("leased"), fixture.backend);
    assert.equal(lease.resolve("leased", "kv"), fixture.kv);
    const childLease = lease.acquire("leased", { kv: { list: false } });
    const initial = registration.snapshot();
    assert.deepEqual(initial, { state: "active", leases: 2 });
    assert.throws(() => { initial.leases = 0; }, TypeError);
    assert.notEqual(childLease, lease);
    assert.throws(
      () => lease.backend("another"),
      /lease is for "leased", not "another"/,
    );

    let retired = false;
    const retiring = registration.unregister().then(() => {
      retired = true;
    });
    assert.equal(root.storage.has("leased"), false);
    assert.deepEqual(registration.snapshot(), { state: "retiring", leases: 2 });
    assert.equal(closes, 0);
    assert.equal(retired, false);
    assert.throws(
      () => root.storage.acquire("leased"),
      (error) => error?.code === "storage_backend_not_found",
    );
    assert.throws(
      () => lease.acquire("leased"),
      (error) => error?.code === "storage_backend_not_found",
    );
    assert.equal(await lease.resolve("leased", "kv").get({
      namespace: "fixture",
      key: "during-retirement",
    }), undefined);

    assert.equal(lease.release(), true);
    assert.equal(lease.release(), false);
    await Promise.resolve();
    assert.equal(retired, false);
    assert.equal(closes, 0);
    assert.equal(childLease.release(), true);
    await retiring;
    assert.equal(retired, true);
    assert.equal(closes, 1);
    assert.deepEqual(registration.snapshot(), { state: "closed", leases: 0 });
    assert.deepEqual(initial, { state: "active", leases: 2 });
    assert.equal(lease.released, true);
    assert.throws(
      () => lease.backend("leased"),
      (error) => error?.code === "storage_closed",
    );
  } finally {
    await root.fiber.dispose();
  }
});

test("reversible acquisition fences compose and never resurrect an unregistered backend", async () => {
  const root = new Context();
  await root.plugin(StorageHub);
  try {
    const registration = root.storage.register(fixtureBackend("fenced").backend);
    const lease = root.storage.acquire("fenced");
    try {
      const resumeOne = registration.suspendAcquisitions(), resumeTwo = registration.suspendAcquisitions();
      assert.throws(() => root.storage.acquire("fenced"));
      assert.throws(() => root.storage.backend("fenced"));
      assert.throws(() => root.storage.resolve("fenced", "kv"));
      assert.throws(() => lease.acquire("fenced"));
      assert.equal(await lease.resolve("fenced", "kv").get({}), undefined);
      resumeOne(); assert.throws(() => root.storage.acquire("fenced"));
      resumeTwo(); const child = lease.acquire("fenced"); child.release();
      const resumeLast = registration.suspendAcquisitions();
      const retiring = registration.unregister();
      resumeLast(); resumeOne(); resumeTwo();
      assert.throws(() => root.storage.acquire("fenced"));
      lease.release(); await retiring;
      assert.equal(registration.snapshot().state, "closed");
    } finally { lease.release(); }
  } finally { await root.fiber.dispose(); }
});

test("a failed physical close remains failed in its registration snapshot", async () => {
  const root = new Context();
  await root.plugin(StorageHub);
  try {
    const fixture = fixtureBackend("failing", { onClose() { throw new Error("physical close failed"); } });
    const registration = root.storage.register(fixture.backend);
    await assert.rejects(registration.unregister(), { code: "storage_unavailable" });
    assert.deepEqual(registration.snapshot(), { state: "failed", leases: 0 });
    assert.equal(root.storage.has("failing"), false);
    await assert.rejects(registration.unregister(), { code: "storage_unavailable" });
  } finally { await root.fiber.dispose(); }
});

test("Storage Provider disposal unregisters and closes its Backend", async () => {
  const root = new Context();
  await root.plugin(StorageHub);
  let closes = 0;
  const fixture = fixtureBackend("provider", { onClose: () => closes += 1 });
  const provider = root.plugin({
    inject: ["storage"],
    apply(ctx) {
      ctx.storage.register(fixture.backend);
    },
  });
  await provider;
  assert.equal(root.storage.has("provider"), true);
  await provider.dispose();
  assert.equal(root.storage.has("provider"), false);
  assert.equal(closes, 1);
  await root.fiber.dispose();
});
