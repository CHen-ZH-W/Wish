import assert from "node:assert/strict";
// Integration coverage for the Blob/KV-backed Tool Result Archive provider.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { StorageHub } from "../dist/storage/index.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import FileStorageProvider from "../dist/storage/providers/file/plugin.js";
import { BlobToolResultArchive } from
  "../dist/tools/results/providers/blob.js";
import BlobToolResultArchiveProvider from
  "../dist/tools/results/providers/blob.js";
import BlobToolOutputArtifacts from
  "../dist/tools/results/artifacts/providers/blob.js";
import { FileToolResultArchive } from
  "../dist/tools/results/providers/file.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-blob-tool-result-"));
  const backend = new FileStorageBackend({
    id: "file",
    rootDirectory: join(directory, "storage"),
  });
  const archive = new BlobToolResultArchive({
    storage: {
      backend(id, requirement) {
        assert.equal(id, "file");
        void requirement;
        return backend;
      },
      resolve(id, facet) {
        assert.equal(id, "file");
        return backend[facet];
      },
    },
    backendId: "file",
    legacyLocatorRoot: directory,
    now: () => new Date("2026-09-11T12:00:00.000Z"),
  });
  return {
    directory,
    backend,
    archive,
    async close() {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function input(content = "complete") {
  return {
    sessionId: "session-1",
    runId: "run-1",
    userTurnId: "turn-1",
    stepId: "step-1",
    result: {
      ok: true,
      callId: "call-1",
      toolName: "read",
      output: { content, nested: [1, 2, 3] },
      phase: "completed",
    },
  };
}

test("Blob Tool Result Archive is versioned, readable and idempotent", async () => {
  const value = await fixture();
  try {
    const source = input();
    const first = await value.archive.archive(source);
    source.result.output.content = "mutated";
    source.result.output.nested.push(4);
    const second = await value.archive.archive(input());
    assert.deepEqual(second, first);
    assert.match(first.locator, /^wish-tool-result:v2:/u);
    assert.match(first.hash, /^[a-f0-9]{64}$/u);
    assert.equal(first.locator.includes("/storage/"), false);
    assert.equal(Object.isFrozen(first), true);
    const stored = await value.archive.read(first);
    assert.equal(stored.result.output.content, "complete");
    assert.deepEqual(stored.result.output.nested, [1, 2, 3]);
    assert.equal(stored.createdAt, "2026-09-11T12:00:00.000Z");
  } finally {
    await value.close();
  }
});

test("Blob Tool Result Archive rejects a reused call identity with other content", async () => {
  const value = await fixture();
  try {
    await value.archive.archive(input("first"));
    await assert.rejects(
      value.archive.archive(input("second")),
      (error) => error?.code === "storage_conflict",
    );
  } finally {
    await value.close();
  }
});

test("Blob Tool Result Archive reads legacy relative locators", async () => {
  const value = await fixture();
  try {
    const legacy = new FileToolResultArchive({
      directory: join(value.directory, "tool-results"),
      locatorRoot: value.directory,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    const reference = await legacy.archive(input("legacy"));
    const stored = await value.archive.read(reference);
    assert.equal(stored.result.output.content, "legacy");
    assert.equal(stored.resultSha256, reference.hash);
  } finally {
    await value.close();
  }
});

test("Cordis Archive Provider controls Consumer availability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-archive-provider-"));
  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  await root.plugin(StorageHub);
  const storageProvider = await root.plugin(FileStorageProvider, {
    id: "file",
    rootDirectory: join(directory, "storage"),
  });
  const generations = [];
  const consumer = root.plugin({
    inject: ["toolResultArchive"],
    apply(ctx) {
      generations.push(ctx.toolResultArchive);
    },
  });
  const states = { pending: 0, active: 2 };
  assert.equal(consumer.state, states.pending);
  const provider = await root.plugin(BlobToolResultArchiveProvider, {
    backendId: "file",
  });
  await consumer.await();
  assert.equal(consumer.state, states.active);
  assert.equal(generations.length, 1);
  const archive = generations[0].open({ legacyLocatorRoot: directory });
  assert.match(
    (await archive.archive(input())).locator,
    /^wish-tool-result:v2:/u,
  );
  assert.equal(archive.released, false);
  assert.equal(archive.release(), true);
  assert.equal(archive.release(), false);
  await storageProvider.dispose();
  assert.equal(root.get("toolResultArchive"), undefined);
  assert.equal(consumer.state, states.pending);
  assert.equal(provider.state, states.pending);
  await root.plugin(FileStorageProvider, {
    id: "file",
    rootDirectory: join(directory, "storage"),
  });
  await consumer.await();
  assert.equal(generations.length, 2);
  await root.fiber.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("Blob Tool Output Artifacts return opaque readable references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-output-artifacts-"));
  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  try {
    await root.plugin(StorageHub);
    await root.plugin(FileStorageProvider, {
      id: "file",
      rootDirectory: join(directory, "storage"),
    });
    const provider = await root.plugin(BlobToolOutputArtifacts, {
      backendId: "file",
    });
    const source = new TextEncoder().encode("complete bash output");
    const artifact = await root.toolOutputArtifacts.put({
      sessionId: "session-1",
      runId: "run-1",
      userTurnId: "turn-1",
      stepId: "step-1",
      toolCallId: "call-1",
      toolName: "bash",
      mediaType: "text/plain;charset=utf-8",
      value: source,
    });
    assert.equal(artifact.kind, "blob");
    assert.match(artifact.locator, /^wish-tool-output:v1:/u);
    assert.equal(artifact.locator.includes(directory), false);
    assert.deepEqual(
      await root.toolOutputArtifacts.get({ artifact }),
      source,
    );

    await provider.dispose();
    assert.equal(root.get("toolOutputArtifacts"), undefined);
  } finally {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Storage Provider retirement waits for an Archive handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-archive-lease-"));
  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  await root.plugin(StorageHub);
  const storageProvider = await root.plugin(FileStorageProvider, {
    id: "file",
    rootDirectory: join(directory, "storage"),
  });
  await root.plugin(BlobToolResultArchiveProvider, { backendId: "file" });
  const archive = root.toolResultArchive.open({ legacyLocatorRoot: directory });
  let retired = false;
  const retirement = storageProvider.dispose().then(() => {
    retired = true;
  });
  try {
    await Promise.resolve();
    assert.equal(retired, false);
    assert.match(
      (await archive.archive(input("during-retirement"))).locator,
      /^wish-tool-result:v2:/u,
    );
    assert.equal(retired, false);
    assert.equal(archive.release(), true);
    await retirement;
    assert.equal(retired, true);
    assert.equal(archive.released, true);
    await assert.rejects(
      async () => archive.archive(input("after-release")),
      (error) => error?.code === "storage_closed",
    );
  } finally {
    archive.release();
    await retirement;
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
