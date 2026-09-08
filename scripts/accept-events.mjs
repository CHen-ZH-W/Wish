import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeEventStream } from "../dist/core/events/event.js";

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("Model events own an immutable payload snapshot", async () => {
  const stream = new RuntimeEventStream("run-1", 10);
  const source = {
    type: "retry",
    error: {
      code: "network_error",
      message: "temporary failure",
      retryable: true,
    },
    retryCount: 1,
    delayMs: 10,
    fromModel: { provider: "provider-a", model: "model-a" },
    toModel: { provider: "provider-b", model: "model-b" },
  };

  const published = stream.publishModel({
    eventId: "event-1",
    occurredAt: "2026-01-01T00:00:00Z",
    event: source,
    userTurnId: "turn-1",
    stepId: "step-1",
  });
  source.error.message = "changed";
  source.fromModel.model = "changed";
  source.toModel.provider = "changed";
  stream.close();

  const replay = await collect(stream.observe());
  assert.equal(replay.length, 1);
  assert.equal(replay[0], published);
  assert.notEqual(published.payload, source);
  assert.deepEqual(published.payload, {
    type: "retry",
    error: {
      code: "network_error",
      message: "temporary failure",
      retryable: true,
    },
    retryCount: 1,
    delayMs: 10,
    fromModel: { provider: "provider-a", model: "model-a" },
    toModel: { provider: "provider-b", model: "model-b" },
  });
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.payload), true);
  assert.equal(Object.isFrozen(published.payload.error), true);
  assert.equal(Object.isFrozen(published.payload.fromModel), true);
  assert.equal(Object.isFrozen(published.payload.toModel), true);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(source.error), false);
});

test("a slow observer receives tail events appended immediately before close", async () => {
  const stream = new RuntimeEventStream("run-tail", 10);
  const first = stream.publish({
    eventId: "event-1",
    occurredAt: "2026-01-01T00:00:00Z",
    transition: { type: "first" },
  });
  const iterator = stream.observe()[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { value: first, done: false });
  const terminal = stream.publish({
    eventId: "event-2",
    occurredAt: "2026-01-01T00:00:01Z",
    transition: { type: "terminal" },
  });
  stream.close();

  assert.deepEqual(await iterator.next(), { value: terminal, done: false });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});
