import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withFileMutationQueue } from "../dist/filesystem/consumers/model-tools/mutation-queue.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("serializes the same normalized path in FIFO order", async () => {
  const gate = deferred();
  const started = deferred();
  const order = [];
  const first = withFileMutationQueue("/tmp/wish-queue/../wish-queue-file", async () => {
    order.push("first:start");
    started.resolve();
    await gate.promise;
    order.push("first:end");
  });
  await started.promise;
  const second = withFileMutationQueue("/tmp/wish-queue-file", () => {
    order.push("second:start");
    order.push("second:end");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("allows different paths to mutate concurrently", async () => {
  const gate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const first = withFileMutationQueue("/tmp/wish-queue-a", async () => {
    firstStarted.resolve();
    await gate.promise;
  });
  const second = withFileMutationQueue("/tmp/wish-queue-b", async () => {
    secondStarted.resolve();
    await gate.promise;
  });

  await Promise.all([firstStarted.promise, secondStarted.promise]);
  gate.resolve();
  await Promise.all([first, second]);
});

test("uses one queue for existing symlink aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-mutation-queue-"));
  try {
    const target = join(directory, "target.txt");
    const alias = join(directory, "alias.txt");
    await writeFile(target, "content", "utf8");
    await symlink(target, alias);

    const gate = deferred();
    const started = deferred();
    const order = [];
    const first = withFileMutationQueue(target, async () => {
      order.push("target:start");
      started.resolve();
      await gate.promise;
      order.push("target:end");
    });
    await started.promise;
    const second = withFileMutationQueue(alias, () => order.push("alias"));

    await Promise.resolve();
    assert.deepEqual(order, ["target:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["target:start", "target:end", "alias"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("releases the queue after an operation fails", async () => {
  const first = withFileMutationQueue("/tmp/wish-queue-failure", () => {
    throw new Error("mutation failed");
  });
  let secondRan = false;
  const second = withFileMutationQueue("/tmp/wish-queue-failure", () => {
    secondRan = true;
  });

  await assert.rejects(first, /mutation failed/u);
  await second;
  assert.equal(secondRan, true);
});

test("an aborted waiter never runs and cannot release the active mutation", async () => {
  const gate = deferred();
  const started = deferred();
  const order = [];
  const first = withFileMutationQueue("/tmp/wish-queue-abort", async () => {
    order.push("first:start");
    started.resolve();
    await gate.promise;
    order.push("first:end");
  });
  await started.promise;

  const controller = new AbortController();
  let abortedOperationRan = false;
  const aborted = withFileMutationQueue(
    "/tmp/wish-queue-abort",
    () => {
      abortedOperationRan = true;
    },
    controller.signal,
  );
  controller.abort(new Error("cancelled while waiting"));
  await assert.rejects(aborted, /cancelled while waiting/u);

  const third = withFileMutationQueue("/tmp/wish-queue-abort", () => {
    order.push("third");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  assert.equal(abortedOperationRan, false);

  gate.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(order, ["first:start", "first:end", "third"]);
});

test("releases the queue after an active mutation settles from abort", async () => {
  const controller = new AbortController();
  const started = deferred();
  const first = withFileMutationQueue(
    "/tmp/wish-queue-active-abort",
    () => new Promise((_resolve, reject) => {
      started.resolve();
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    }),
    controller.signal,
  );
  await started.promise;

  let secondRan = false;
  const second = withFileMutationQueue("/tmp/wish-queue-active-abort", () => {
    secondRan = true;
  });
  controller.abort(new Error("cancelled while active"));

  await assert.rejects(first, /cancelled while active/u);
  await second;
  assert.equal(secondRan, true);
});
