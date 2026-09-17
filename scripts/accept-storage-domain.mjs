import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  DOMAIN_ABSENT,
  StorageDomain,
  StorageHub,
} from "../dist/storage/index.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import { fileKvStoragePath } from "../dist/storage/providers/file/kv.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-storage-domain-"));
  let revision = 0;
  const backend = new FileStorageBackend({
    id: "file",
    rootDirectory: directory,
    revision: () => `revision-${++revision}`,
  });
  const root = new Context();
  await root.plugin(StorageHub);
  root.storage.register(backend);
  return {
    directory,
    backend,
    root,
    async dispose() {
      await root.fiber.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function jsonSpec(events, eventErrors = []) {
  return {
    id: "fixtures/settings",
    schemaVersion: 2,
    shape: "keyed",
    requirements: { kv: { list: false } },
    resolve(request) {
      return {
        key: request.key,
        default: request.default === undefined
          ? DOMAIN_ABSENT
          : { kind: "value", value: request.default },
      };
    },
    encode(value) {
      return new TextEncoder().encode(JSON.stringify(value));
    },
    decode(payload) {
      return JSON.parse(new TextDecoder().decode(payload));
    },
    validate(value) {
      if (
        value === null || typeof value !== "object" ||
        typeof value.label !== "string"
      ) throw new Error("settings are invalid");
      return Object.freeze({ label: value.label });
    },
    migrate({ value, fromVersion, toVersion }) {
      assert.equal(fromVersion, 1);
      assert.equal(toVersion, 2);
      return { label: value.name };
    },
    events,
    eventErrors,
  };
}

test("Storage Domain resolves defaults before IO and publishes only durable commits", async () => {
  const state = await fixture();
  try {
    const events = [];
    const eventErrors = [];
    let targetPath;
    const spec = jsonSpec(events, eventErrors);
    const domain = new StorageDomain({
      storage: state.root.storage,
      backendId: "file",
      spec,
      events: {
        publish(event) {
          assert.equal(existsSync(targetPath), event.operation === "put");
          events.push(event);
        },
      },
      onEventError(error, event) {
        eventErrors.push({ error, event });
      },
    });
    const missing = domain.resolve({ key: "theme", default: { label: "dark" } });
    targetPath = fileKvStoragePath(state.backend.kv, spec.id, missing.key);
    assert.deepEqual(await missing.load(), {
      value: { label: "dark" },
      persisted: false,
    });
    const saved = await missing.save({ label: "light" }, { kind: "absent" });
    assert.equal(saved.persisted, true);
    assert.equal(saved.revision, "revision-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, "put");

    await assert.rejects(
      missing.save({ label: "stale" }, { kind: "absent" }),
      (error) => error?.code === "storage_conflict",
    );
    assert.equal(events.length, 1);
    assert.deepEqual((await missing.load()).value, { label: "light" });
    assert.deepEqual(await missing.delete({
      kind: "revision",
      revision: saved.revision,
    }), { deleted: true });
    assert.equal(events.length, 2);
    assert.equal(events[1].operation, "delete");
    assert.deepEqual((await missing.load()).value, { label: "dark" });
    assert.deepEqual(eventErrors, []);

    const observerFailures = [];
    const observed = new StorageDomain({
      storage: state.root.storage,
      backendId: "file",
      spec,
      events: {
        publish() {
          throw new Error("observer failed");
        },
      },
      onEventError(error) {
        observerFailures.push(error.message);
        throw new Error("diagnostic failed");
      },
    }).resolve({ key: "observer" });
    assert.equal(
      (await observed.save({ label: "committed" }, { kind: "absent" })).persisted,
      true,
    );
    assert.deepEqual(observerFailures, ["observer failed"]);
    assert.deepEqual((await observed.load()).value, { label: "committed" });
  } finally {
    await state.dispose();
  }
});

test("Storage Domain classifies malformed payloads and applies declared migrations", async () => {
  const state = await fixture();
  try {
    const domain = new StorageDomain({
      storage: state.root.storage,
      backendId: "file",
      spec: jsonSpec([]),
    });
    const handle = domain.resolve({ key: "migration" });
    const legacyPayload = Buffer.from(JSON.stringify({ name: "legacy" })).toString("base64");
    await state.backend.kv.put({
      namespace: "fixtures/settings",
      key: "migration",
      value: new TextEncoder().encode(JSON.stringify({
        schemaVersion: 1,
        type: "wish_storage_domain",
        domainId: "fixtures/settings",
        domainSchemaVersion: 1,
        payloadBase64: legacyPayload,
      })),
      precondition: { kind: "absent" },
    });
    assert.deepEqual((await handle.load()).value, { label: "legacy" });

    await state.backend.kv.put({
      namespace: "fixtures/settings",
      key: "migration",
      value: new TextEncoder().encode("not a domain envelope"),
      precondition: { kind: "any" },
    });
    await assert.rejects(
      handle.load(),
      (error) => error?.code === "storage_corruption",
    );
  } finally {
    await state.dispose();
  }
});

test("Storage Domain serializes every key across instances of the same domain", async () => {
  let active = 0;
  let maximum = 0;
  let revision = 0;
  const values = new Map();
  const kv = {
    facet: "kv",
    async get({ namespace, key }) {
      return values.get(`${namespace}:${key}`);
    },
    async put({ namespace, key, value }) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, key === "left" ? 10 : 0));
      const result = {
        value: Uint8Array.from(value),
        revision: `r${++revision}`,
      };
      values.set(`${namespace}:${key}`, result);
      active -= 1;
      return { revision: result.revision };
    },
    async delete() {
      return { deleted: false };
    },
  };
  const backend = {
    id: "fixture",
    capabilities: {
      writerConcurrency: "process-local",
      kv: { list: false },
    },
    kv,
  };
  const storage = {
    backend(id) {
      assert.equal(id, "fixture");
      return backend;
    },
    resolve() {
      return kv;
    },
  };
  const spec = jsonSpec([]);
  const left = new StorageDomain({ storage, backendId: "fixture", spec })
    .resolve({ key: "left" });
  const right = new StorageDomain({ storage, backendId: "fixture", spec })
    .resolve({ key: "right" });
  await Promise.all([
    left.save({ label: "left" }, { kind: "any" }),
    right.save({ label: "right" }, { kind: "any" }),
  ]);
  assert.equal(maximum, 1);
});
