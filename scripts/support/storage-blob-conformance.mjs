import assert from "node:assert/strict";
import test from "node:test";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Reusable behavior contract for every immutable Blob Provider. */
export function defineStorageBlobConformance(label, createFixture) {
  test(`${label}: stores immutable bytes behind stable opaque references`, async () => {
    const fixture = await createFixture();
    try {
      const source = encoder.encode("complete result");
      const first = await fixture.blob.put({
        namespace: "tool-results/../session",
        value: source,
      });
      source.fill(0);
      const second = await fixture.blob.put({
        namespace: "tool-results/../session",
        value: encoder.encode("complete result"),
      });
      assert.deepEqual(second, first);
      assert.equal(Object.isFrozen(first), true);
      assert.match(first.locator, /^sha256-v1:[a-f0-9]{64}$/u);
      assert.match(first.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(first.size, 15);
      const read = await fixture.blob.get({ reference: first });
      assert.equal(decoder.decode(read), "complete result");
      read.fill(0);
      assert.equal(
        decoder.decode(await fixture.blob.get({ reference: first })),
        "complete result",
      );
      assert.deepEqual(await fixture.blob.stat({ reference: first }), {
        reference: first,
      });
    } finally {
      await fixture.close();
    }
  });

  test(`${label}: distinguishes namespaces and honors abort`, async () => {
    const fixture = await createFixture();
    try {
      const value = encoder.encode("same bytes");
      const left = await fixture.blob.put({ namespace: "left", value });
      const right = await fixture.blob.put({ namespace: "right", value });
      assert.equal(left.sha256, right.sha256);
      assert.notEqual(left.namespace, right.namespace);
      assert.equal(
        await fixture.blob.get({ reference: { ...left, namespace: "missing" } }),
        undefined,
      );
      const controller = new AbortController();
      const reason = new Error("stop Blob");
      controller.abort(reason);
      await assert.rejects(
        fixture.blob.put({ namespace: "abort", value, signal: controller.signal }),
        reason,
      );
    } finally {
      await fixture.close();
    }
  });

  test(`${label}: rejects every operation after close`, async () => {
    const fixture = await createFixture();
    const reference = await fixture.blob.put({
      namespace: "closed",
      value: encoder.encode("value"),
    });
    await fixture.backend.close();
    for (const operation of [
      () => fixture.blob.put({ namespace: "closed", value: encoder.encode("next") }),
      () => fixture.blob.get({ reference }),
      () => fixture.blob.stat({ reference }),
    ]) {
      await assert.rejects(
        async () => await operation(),
        (error) => error?.code === "storage_closed",
      );
    }
    await fixture.close();
  });
}
