import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { StorageHub } from "../dist/storage/index.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import {
  fileKvStoragePath,
} from "../dist/storage/providers/file/kv.js";
import FileStoragePlugin from "../dist/storage/providers/file/plugin.js";
import { defineStorageKvConformance } from "./support/storage-kv-conformance.mjs";

let fixtureId = 0;

async function createFileFixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-storage-file-kv-"));
  let revision = 0;
  let temporary = 0;
  const backend = new FileStorageBackend({
    id: `file-${++fixtureId}`,
    rootDirectory: directory,
    revision: () => `revision-${++revision}`,
    temporaryId: () => `temporary-${++temporary}`,
  });
  return {
    directory,
    backend,
    kv: backend.kv,
    async close() {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

defineStorageKvConformance("File KV", createFileFixture);

test("File KV hashes logical identities and leaves only the committed envelope", async () => {
  const fixture = await createFileFixture();
  try {
    const namespace = "../external/session-id";
    const key = "../../user/file.json";
    await fixture.kv.put({
      namespace,
      key,
      value: new TextEncoder().encode("durable"),
      precondition: { kind: "absent" },
    });
    const path = fileKvStoragePath(fixture.kv, namespace, key);
    assert.equal(relative(fixture.directory, path).startsWith(".."), false);
    assert.equal(path.includes(namespace), false);
    assert.equal(path.includes(key), false);
    assert.deepEqual(await readdir(dirname(path)), [path.slice(path.lastIndexOf("/") + 1)]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    assert.equal(envelope.namespace, namespace);
    assert.equal(envelope.key, key);
    assert.equal(envelope.valueBase64, Buffer.from("durable").toString("base64"));
  } finally {
    await fixture.close();
  }
});

test("File KV classifies malformed envelopes as corruption", async () => {
  const fixture = await createFileFixture();
  try {
    const namespace = "corruption";
    const key = "state";
    const path = fileKvStoragePath(fixture.kv, namespace, key);
    await mkdir(dirname(path), { recursive: true });
    for (const invalid of [
      "{",
      JSON.stringify({
        schemaVersion: 2,
        type: "wish_storage_kv",
        namespace,
        key,
        revision: "r1",
        valueBase64: "",
      }),
      JSON.stringify({
        schemaVersion: 1,
        type: "wish_storage_kv",
        namespace: "other",
        key,
        revision: "r1",
        valueBase64: "",
      }),
      JSON.stringify({
        schemaVersion: 1,
        type: "wish_storage_kv",
        namespace,
        key,
        revision: "r1",
        valueBase64: "not-base64",
      }),
    ]) {
      await writeFile(path, invalid, "utf8");
      await assert.rejects(
        fixture.kv.get({ namespace, key }),
        (error) => error?.code === "storage_corruption",
      );
    }
  } finally {
    await fixture.close();
  }
});

test("File KV maps filesystem failures to storage_unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-storage-file-unavailable-"));
  const rootPath = join(directory, "not-a-directory");
  await writeFile(rootPath, "file", "utf8");
  const backend = new FileStorageBackend({
    id: "unavailable",
    rootDirectory: rootPath,
  });
  try {
    await assert.rejects(
      backend.kv.put({
        namespace: "fixture",
        key: "state",
        value: new Uint8Array(),
        precondition: { kind: "any" },
      }),
      (error) => error?.code === "storage_unavailable" && error.cause !== undefined,
    );
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("File Storage plugin registers one process-local Backend and closes it on unload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-storage-file-plugin-"));
  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  await root.plugin(StorageHub);
  const provider = root.plugin(FileStoragePlugin, {
    id: "fixture",
    rootDirectory: "./data",
  });
  await provider;
  const backend = root.storage.backend("fixture", {
    writerConcurrency: "process-local",
    kv: { list: true },
  });
  const kv = backend.kv;
  assert.equal(root.storageBackend.id, "fixture");
  assert.equal(root.storageBackend.resolve("fixture", "kv"), kv);
  assert.equal(backend.capabilities.writerConcurrency, "process-local");
  assert.equal(backend.rootDirectory, join(directory, "data"));
  await provider.dispose();
  assert.equal(root.storage.has("fixture"), false);
  assert.equal(root.get("storageBackend"), undefined);
  await assert.rejects(
    kv.get({ namespace: "closed", key: "state" }),
    (error) => error?.code === "storage_closed",
  );
  await root.fiber.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("File Storage provider unload drains dependent Backend leases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-storage-file-lease-"));
  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  await root.plugin(StorageHub);
  const provider = root.plugin(FileStoragePlugin, {
    id: "fixture",
    rootDirectory: "./data",
  });
  await provider;

  let lease;
  let allowDrain;
  let markDrainStarted;
  const drainBarrier = new Promise((resolve) => {
    allowDrain = resolve;
  });
  const drainStarted = new Promise((resolve) => {
    markDrainStarted = resolve;
  });
  const consumer = root.plugin({
    inject: ["storageBackend"],
    apply(ctx) {
      lease = ctx.storageBackend.acquire("fixture", { kv: { list: true } });
      ctx.effect(() => async () => {
        markDrainStarted();
        await drainBarrier;
        lease.release();
      }, "fixture-consumer.drain-and-release");
    },
  });
  await consumer;
  const kv = lease.resolve("fixture", "kv");

  const retiring = provider.dispose();
  await drainStarted;
  assert.equal(root.storage.has("fixture"), false);
  assert.equal(root.get("storageBackend"), undefined);
  assert.equal(await kv.get({
    namespace: "fixture",
    key: "while-draining",
  }), undefined);

  let retired = false;
  void retiring.then(() => {
    retired = true;
  });
  await Promise.resolve();
  assert.equal(retired, false);

  allowDrain();
  await retiring;
  assert.equal(retired, true);
  await assert.rejects(
    kv.get({ namespace: "fixture", key: "closed" }),
    (error) => error?.code === "storage_closed",
  );

  await root.fiber.dispose();
  await rm(directory, { recursive: true, force: true });
});
