import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import { fileJournalStoragePath } from
  "../dist/storage/providers/file/journal.js";
import { defineStorageJournalConformance } from
  "./support/storage-journal-conformance.mjs";

let fixtureId = 0;

async function createFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-storage-file-journal-"));
  let revision = 0;
  const warnings = [];
  const backend = new FileStorageBackend({
    id: `file-journal-${++fixtureId}`,
    rootDirectory: directory,
    journalRevision: (cursor) => `journal-revision:${cursor}:${++revision}`,
    journalTornTailRecovery: options.recovery ?? "fail",
    onJournalWarning: (warning) => warnings.push(warning),
  });
  const namespace = options.namespace ?? "runtime/lifecycle";
  return {
    directory,
    backend,
    journal: backend.journal.open({ namespace }),
    namespace,
    warnings,
    async close() {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

defineStorageJournalConformance("File Journal", createFixture);

test("compaction keeps surviving cursors, partial-batch replay and the empty high-water across reopen", async () => {
  const f = await createFixture(), encode = text => new TextEncoder().encode(text);
  try {
    const batch = { idempotencyKey: "mixed", entries: [encode("deleted"), encode("retained")] };
    const original = await f.journal.append(batch, { kind: "any" });
    await f.journal.append({ idempotencyKey: "deleted-tail", entries: [encode("deleted")] }, { kind: "any" });
    assert.equal((await f.journal.compact(entry => new TextDecoder().decode(entry.value) === "retained")).removed, 2);
    await f.journal.close();
    let journal = f.backend.journal.open({ namespace: f.namespace });
    const entries = [];
    for await (const entry of journal.read({ afterCursor: 1 })) entries.push(entry);
    assert.deepEqual(entries.map(entry => [entry.cursor, entry.batchIndex, entry.revision]), [[2, 1, original.revision]]);
    assert.equal((await journal.append(batch, { kind: "any" })).replayed, true);
    assert.equal((await journal.append({ idempotencyKey: "next", entries: [encode("four")] }, { kind: "any" })).firstCursor, 4);
    await journal.compact(() => false);
    await journal.close();
    journal = f.backend.journal.open({ namespace: f.namespace });
    assert.equal((await journal.append({ idempotencyKey: "after-empty", entries: [encode("five")] }, { kind: "any" })).firstCursor, 5);
    const bytes = await readFile(fileJournalStoragePath(f.backend.journal, f.namespace), "utf8");
    assert.equal(bytes.includes(Buffer.from("retained").toString("base64")), false);
  } finally { await f.close(); }
});

test("compaction is atomic on predicate failure and serialized with concurrent appends", async () => {
  const f = await createFixture();
  try {
    const batch = id => ({ idempotencyKey: id, entries: [new TextEncoder().encode(id)] });
    await f.journal.append(batch("old"), { kind: "any" });
    const path = fileJournalStoragePath(f.backend.journal, f.namespace), before = await readFile(path);
    await assert.rejects(f.journal.compact(() => { throw new Error("predicate failed"); }), /predicate failed/);
    assert.deepEqual(await readFile(path), before);
    const signal = new AbortController();
    await assert.rejects(f.journal.compact(() => { signal.abort(); return false; }, signal.signal), /abort/i);
    assert.deepEqual(await readFile(path), before);
    await Promise.all([
      f.journal.compact(entry => entry.idempotencyKey !== "old"),
      f.journal.append(batch("new"), { kind: "any" }),
    ]);
    const entries = [];
    for await (const entry of f.journal.read()) entries.push(entry);
    assert.deepEqual(entries.map(entry => [entry.cursor, entry.idempotencyKey]), [[2, "new"]]);
  } finally { await f.close(); }
});

test("torn-tail recovery never discards a damaged compaction checkpoint", async () => {
  const f = await createFixture({ recovery: "truncate" });
  try {
    await f.journal.append({ idempotencyKey: "mixed", entries: [new Uint8Array([1]), new Uint8Array([2])] }, { kind: "any" });
    await f.journal.compact(entry => entry.cursor === 2);
    const path = fileJournalStoragePath(f.backend.journal, f.namespace);
    const damaged = (await readFile(path)).subarray(0, -12);
    await writeFile(path, damaged);
    await assert.rejects(async () => { for await (const entry of f.journal.read()) void entry; }, /checkpoint has a torn tail/);
    assert.deepEqual(await readFile(path), damaged);
  } finally { await f.close(); }
});

test("File Journal reopens a namespace after its prior handle closes", async () => {
  const fixture = await createFixture();
  try {
    await fixture.journal.append({
      idempotencyKey: "first-generation",
      entries: [new TextEncoder().encode("one")],
    }, { kind: "any" });
    await fixture.journal.close();
    await assert.rejects(
      async () => fixture.journal.append({
        idempotencyKey: "closed-generation",
        entries: [new TextEncoder().encode("never")],
      }, { kind: "any" }),
      (error) => error?.code === "storage_closed",
    );

    const reopened = fixture.backend.journal.open({
      namespace: fixture.namespace,
    });
    assert.notEqual(reopened, fixture.journal);
    const commit = await reopened.append({
      idempotencyKey: "second-generation",
      entries: [new TextEncoder().encode("two")],
    }, { kind: "any" });
    assert.equal(commit.firstCursor, 2);
    const values = [];
    for await (const entry of reopened.read()) {
      values.push(new TextDecoder().decode(entry.value));
    }
    assert.deepEqual(values, ["one", "two"]);
  } finally {
    await fixture.close();
  }
});

test("File Journal fails closed on a torn tail by default", async () => {
  const fixture = await createFixture();
  try {
    await fixture.journal.append({
      idempotencyKey: "committed",
      entries: [new TextEncoder().encode("one")],
    }, { kind: "any" });
    const path = fileJournalStoragePath(fixture.backend.journal, fixture.namespace);
    await appendFile(path, "{\"partial\":", "utf8");
    await assert.rejects(
      async () => {
        for await (const _entry of fixture.journal.read()) {
          // Consume to force validation.
        }
      },
      (error) => error?.code === "storage_corruption",
    );
  } finally {
    await fixture.close();
  }
});

test("File Journal explicitly truncates a torn tail when configured", async () => {
  const fixture = await createFixture({ recovery: "truncate" });
  try {
    await fixture.journal.append({
      idempotencyKey: "committed",
      entries: [new TextEncoder().encode("one")],
    }, { kind: "any" });
    const path = fileJournalStoragePath(fixture.backend.journal, fixture.namespace);
    const committed = await readFile(path);
    await appendFile(path, "torn-tail", "utf8");
    const entries = [];
    for await (const entry of fixture.journal.read()) entries.push(entry);
    assert.equal(entries.length, 1);
    assert.deepEqual(await readFile(path), committed);
    assert.equal(fixture.warnings.length, 1);
    assert.equal(fixture.warnings[0].code, "torn_tail_truncated");
    assert.equal(fixture.warnings[0].removedBytes, 9);
  } finally {
    await fixture.close();
  }
});

test("File Journal rejects a complete but corrupted transaction", async () => {
  const fixture = await createFixture();
  try {
    const path = fileJournalStoragePath(fixture.backend.journal, fixture.namespace);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      type: "wish_storage_journal_transaction",
    })}\n`, "utf8");
    await assert.rejects(
      fixture.journal.append({
        idempotencyKey: "next",
        entries: [new TextEncoder().encode("value")],
      }, { kind: "any" }),
      (error) => error?.code === "storage_corruption",
    );
  } finally {
    await fixture.close();
  }
});
