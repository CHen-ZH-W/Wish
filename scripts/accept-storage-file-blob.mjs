import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import { fileBlobStoragePath } from "../dist/storage/providers/file/blob.js";
import { defineStorageBlobConformance } from
  "./support/storage-blob-conformance.mjs";

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-storage-file-blob-"));
  const backend = new FileStorageBackend({
    id: "file-blob",
    rootDirectory: directory,
    temporaryId: () => "fixture-temporary",
  });
  return {
    directory,
    backend,
    blob: backend.blob,
    async close() {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

defineStorageBlobConformance("File Blob", createFixture);

test("File Blob hashes logical namespaces and leaves one durable file", async () => {
  const fixture = await createFixture();
  try {
    const reference = await fixture.blob.put({
      namespace: "../../external/session",
      value: new TextEncoder().encode("durable"),
    });
    const path = fileBlobStoragePath(fixture.blob, reference);
    assert.equal(relative(fixture.directory, path).startsWith(".."), false);
    assert.equal(path.includes("external/session"), false);
    assert.deepEqual(await readdir(dirname(path)), [path.split("/").at(-1)]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await fixture.close();
  }
});

test("File Blob detects content that conflicts with its immutable reference", async () => {
  const fixture = await createFixture();
  try {
    const reference = await fixture.blob.put({
      namespace: "corruption",
      value: new TextEncoder().encode("original"),
    });
    await writeFile(fileBlobStoragePath(fixture.blob, reference), "tampered");
    await assert.rejects(
      fixture.blob.get({ reference }),
      (error) => error?.code === "storage_conflict",
    );
  } finally {
    await fixture.close();
  }
});
