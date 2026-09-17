import assert from "node:assert/strict";
import test from "node:test";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function collect(journal, options) {
  const entries = [];
  for await (const entry of journal.read(options)) entries.push(entry);
  return entries;
}

/** Reusable behavior contract for every Journal Provider. */
export function defineStorageJournalConformance(label, createFixture) {
  test(`${label}: atomically appends batches with monotonic cursors`, async () => {
    const fixture = await createFixture();
    try {
      const journal = fixture.journal;
      const first = await journal.append({
        idempotencyKey: "batch-1",
        entries: [encoder.encode("one"), encoder.encode("two")],
      }, { kind: "any" });
      assert.deepEqual({
        firstCursor: first.firstCursor,
        lastCursor: first.lastCursor,
        replayed: first.replayed,
      }, { firstCursor: 1, lastCursor: 2, replayed: false });
      const second = await journal.append({
        idempotencyKey: "batch-2",
        entries: [encoder.encode("three")],
      }, { kind: "revision", revision: first.revision });
      assert.equal(second.firstCursor, 3);
      assert.equal(second.lastCursor, 3);
      assert.notEqual(second.revision, first.revision);
      assert.equal(second.revision > first.revision, true);
      const entries = await collect(journal);
      assert.deepEqual(entries.map((entry) => ({
        cursor: entry.cursor,
        value: decoder.decode(entry.value),
        key: entry.idempotencyKey,
      })), [
        { cursor: 1, value: "one", key: "batch-1" },
        { cursor: 2, value: "two", key: "batch-1" },
        { cursor: 3, value: "three", key: "batch-2" },
      ]);
      assert.deepEqual(
        (await collect(journal, { afterCursor: 2 })).map((entry) => entry.cursor),
        [3],
      );
      await journal.flush();
    } finally {
      await fixture.close();
    }
  });

  test(`${label}: replays idempotent batches and rejects conflicts`, async () => {
    const fixture = await createFixture();
    try {
      const batch = {
        idempotencyKey: "stable-key",
        entries: [encoder.encode("stable")],
      };
      const first = await fixture.journal.append(batch, { kind: "any" });
      const replay = await fixture.journal.append(batch, {
        kind: "revision",
        revision: "stale-but-idempotent",
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.revision, first.revision);
      assert.equal((await collect(fixture.journal)).length, 1);
      await assert.rejects(
        fixture.journal.append({
          idempotencyKey: "stable-key",
          entries: [encoder.encode("different")],
        }, { kind: "any" }),
        (error) => error?.code === "storage_conflict",
      );
      await assert.rejects(
        fixture.journal.append({
          idempotencyKey: "next",
          entries: [encoder.encode("value")],
        }, { kind: "revision", revision: "wrong" }),
        (error) => error?.code === "storage_conflict",
      );
    } finally {
      await fixture.close();
    }
  });

  test(`${label}: honors abort and rejects operations after close`, async () => {
    const fixture = await createFixture();
    try {
      const controller = new AbortController();
      const reason = new Error("stop Journal");
      controller.abort(reason);
      await assert.rejects(
        fixture.journal.append({
          idempotencyKey: "aborted",
          entries: [encoder.encode("never")],
        }, { kind: "any" }, controller.signal),
        reason,
      );
      await fixture.journal.close();
      await assert.rejects(
        async () => await fixture.journal.append({
          idempotencyKey: "closed",
          entries: [encoder.encode("never")],
        }, { kind: "any" }),
        (error) => error?.code === "storage_closed",
      );
      await assert.rejects(
        async () => await collect(fixture.journal),
        (error) => error?.code === "storage_closed",
      );
      await assert.rejects(
        async () => await fixture.journal.flush(),
        (error) => error?.code === "storage_closed",
      );
    } finally {
      await fixture.close();
    }
  });

  test(`${label}: close drains an accepted read iterator`, async () => {
    const fixture = await createFixture();
    try {
      await fixture.journal.append({
        idempotencyKey: "read-drain",
        entries: [encoder.encode("one"), encoder.encode("two")],
      }, { kind: "any" });
      const iterator = fixture.journal.read()[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      let closed = false;
      const closing = fixture.journal.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false);
      await iterator.return();
      await closing;
      assert.equal(closed, true);
    } finally {
      await fixture.close();
    }
  });
}
