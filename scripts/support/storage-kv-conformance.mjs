import assert from "node:assert/strict";
import test from "node:test";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Register the Provider-neutral KV behavior suite for one Backend factory. */
export function defineStorageKvConformance(name, create) {
  test(`${name}: owns byte values and implements explicit CAS`, async () => {
    const fixture = await create();
    try {
      const input = encoder.encode("first");
      const first = await fixture.kv.put({
        namespace: "catalog",
        key: "current",
        value: input,
        precondition: { kind: "absent" },
      });
      input[0] = 0;
      assert.equal(decoder.decode((await fixture.kv.get({
        namespace: "catalog",
        key: "current",
      })).value), "first");

      await assert.rejects(
        fixture.kv.put({
          namespace: "catalog",
          key: "current",
          value: encoder.encode("duplicate"),
          precondition: { kind: "absent" },
        }),
        (error) => error?.code === "storage_conflict",
      );
      await assert.rejects(
        fixture.kv.put({
          namespace: "catalog",
          key: "missing-precondition",
          value: encoder.encode("invalid"),
        }),
        /precondition/u,
      );
      await assert.rejects(
        fixture.kv.put({
          namespace: "catalog",
          key: "current",
          value: encoder.encode("stale"),
          precondition: { kind: "revision", revision: "stale" },
        }),
        (error) => error?.code === "storage_conflict",
      );

      const second = await fixture.kv.put({
        namespace: "catalog",
        key: "current",
        value: encoder.encode("second"),
        precondition: { kind: "revision", revision: first.revision },
      });
      assert.notEqual(second.revision, first.revision);
      const loaded = await fixture.kv.get({ namespace: "catalog", key: "current" });
      loaded.value[0] = 0;
      assert.equal(decoder.decode((await fixture.kv.get({
        namespace: "catalog",
        key: "current",
      })).value), "second");

      await assert.rejects(
        fixture.kv.delete({
          namespace: "catalog",
          key: "current",
          precondition: { kind: "revision", revision: first.revision },
        }),
        (error) => error?.code === "storage_conflict",
      );
      assert.deepEqual(await fixture.kv.delete({
        namespace: "catalog",
        key: "current",
        precondition: { kind: "revision", revision: second.revision },
      }), { deleted: true });
      assert.equal(await fixture.kv.get({ namespace: "catalog", key: "current" }), undefined);
      assert.deepEqual(await fixture.kv.delete({
        namespace: "catalog",
        key: "current",
        precondition: { kind: "absent" },
      }), { deleted: false });
    } finally {
      await fixture.close();
    }
  });

  test(`${name}: keeps logical identities independent from paths`, async () => {
    const fixture = await create();
    try {
      const addresses = [
        ["../sessions/customer", "../../outside"],
        ["../sessions/customer", "sibling"],
        ["another/namespace", "../../outside"],
      ];
      for (const [namespace, key] of addresses) {
        await fixture.kv.put({
          namespace,
          key,
          value: encoder.encode(`${namespace}:${key}`),
          precondition: { kind: "absent" },
        });
      }
      for (const [namespace, key] of addresses) {
        const loaded = await fixture.kv.get({ namespace, key });
        assert.equal(decoder.decode(loaded.value), `${namespace}:${key}`);
      }
      assert.equal(typeof fixture.kv.list, "function");
      assert.deepEqual(
        (await fixture.kv.list({ namespace: "../sessions/customer" }))
          .map((entry) => entry.key),
        ["../../outside", "sibling"],
      );
      assert.deepEqual(await fixture.kv.list({ namespace: "missing" }), []);
    } finally {
      await fixture.close();
    }
  });

  test(`${name}: serializes competing process-local CAS writes`, async () => {
    const fixture = await create();
    try {
      const initial = await fixture.kv.put({
        namespace: "race",
        key: "one",
        value: encoder.encode("initial"),
        precondition: { kind: "absent" },
      });
      const outcomes = await Promise.allSettled([
        fixture.kv.put({
          namespace: "race",
          key: "one",
          value: encoder.encode("left"),
          precondition: { kind: "revision", revision: initial.revision },
        }),
        fixture.kv.put({
          namespace: "race",
          key: "one",
          value: encoder.encode("right"),
          precondition: { kind: "revision", revision: initial.revision },
        }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const rejection = outcomes.find((outcome) => outcome.status === "rejected");
      assert.equal(rejection.reason.code, "storage_conflict");
      assert.match(decoder.decode((await fixture.kv.get({
        namespace: "race",
        key: "one",
      })).value), /^(left|right)$/u);
    } finally {
      await fixture.close();
    }
  });

  test(`${name}: preserves AbortSignal and rejects every operation after close`, async () => {
    const fixture = await create();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fixture.kv.get({ namespace: "abort", key: "one", signal: controller.signal }),
      (error) => error?.name === "AbortError",
    );
    await fixture.close();

    const calls = [
      () => fixture.kv.get({ namespace: "closed", key: "one" }),
      () => fixture.kv.put({
        namespace: "closed",
        key: "one",
        value: encoder.encode("value"),
        precondition: { kind: "any" },
      }),
      () => fixture.kv.delete({
        namespace: "closed",
        key: "one",
        precondition: { kind: "any" },
      }),
      () => fixture.kv.list({ namespace: "closed" }),
    ];
    for (const call of calls) {
      await assert.rejects(call, (error) => error?.code === "storage_closed");
    }
  });
}
