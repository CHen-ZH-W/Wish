import assert from "node:assert/strict";
import test from "node:test";

import { RetryingModel } from "../dist/core/model/model.js";

const primary = Object.freeze({ provider: "provider-a", model: "model-a" });
const fallback = Object.freeze({ provider: "provider-b", model: "model-b" });

function request(model = primary) {
  return {
    model,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    metadata: { runId: "run-1" },
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function failure(code = "network_error", retryable = true) {
  return {
    type: "error",
    error: { code, message: code, retryable },
  };
}

test("forwards normalized stream events and explicit authority metadata", async () => {
  const seen = [];
  const model = {
    async *stream(input) {
      seen.push(input);
      yield {
        type: "start",
        model: input.model,
        developerRoleMode: "system-fallback",
        authorityDegraded: true,
      };
      yield { type: "reasoning_delta", text: "think" };
      yield { type: "text_delta", text: "answer" };
      yield {
        type: "tool_call",
        call: { id: "call-1", name: "lookup", argumentsJson: "{}" },
      };
      yield {
        type: "done",
        finishReason: "tool_calls",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          totalTokens: 14,
        },
      };
    },
  };

  const events = await collect(new RetryingModel(model).stream(request()));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, primary);
  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "reasoning_delta",
    "text_delta",
    "tool_call",
    "done",
  ]);
  assert.equal(events[0].developerRoleMode, "system-fallback");
  assert.equal(events[0].authorityDegraded, true);
});

test("retries a retryable pre-content failure with bounded deterministic backoff", async () => {
  const attempts = [];
  const model = {
    async *stream(input) {
      attempts.push(input.model);
      yield { type: "start", model: input.model };
      if (attempts.length === 1) {
        yield failure();
        return;
      }
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const resilient = new RetryingModel(model, {
    maxRetries: 1,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    random: () => 0.5,
  });

  const events = await collect(resilient.stream(request()));
  const retry = events.find((event) => event.type === "retry");

  assert.deepEqual(attempts, [primary, primary]);
  assert.equal(retry.retryCount, 1);
  assert.equal(retry.delayMs, 1);
  assert.deepEqual(retry.fromModel, primary);
  assert.equal("toModel" in retry, false);
  assert.equal(events.at(-1).type, "done");
});

test("switches candidate after retries and keeps a global retry count", async () => {
  const attempts = [];
  const model = {
    async *stream(input) {
      attempts.push(input.model);
      yield { type: "start", model: input.model };
      if (input.model.provider === primary.provider) {
        yield failure();
        return;
      }
      yield { type: "text_delta", text: "fallback answer" };
      yield { type: "done" };
    },
  };
  const resilient = new RetryingModel(model, {
    maxRetries: 1,
    fallbackModels: [primary, fallback, fallback],
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    random: () => 0.5,
  });

  const events = await collect(resilient.stream(request()));
  const retries = events.filter((event) => event.type === "retry");

  assert.deepEqual(attempts, [primary, primary, fallback]);
  assert.deepEqual(retries.map((event) => event.retryCount), [1, 2]);
  assert.equal("toModel" in retries[0], false);
  assert.deepEqual(retries[1].toModel, fallback);
});

test("context overflow switches candidate without retrying the same model", async () => {
  const attempts = [];
  const model = {
    async *stream(input) {
      attempts.push(input.model);
      yield { type: "start", model: input.model };
      if (input.model.provider === primary.provider) {
        yield failure("context_overflow", true);
        return;
      }
      yield { type: "done", finishReason: "stop" };
    },
  };
  const resilient = new RetryingModel(model, {
    maxRetries: 3,
    fallbackModels: [fallback],
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    random: () => 0.5,
  });

  const events = await collect(resilient.stream(request()));
  const retry = events.find((event) => event.type === "retry");

  assert.deepEqual(attempts, [primary, fallback]);
  assert.deepEqual(retry.toModel, fallback);
  assert.equal(events.at(-1).type, "done");
});

test("retryable context overflow is terminal when no fallback exists", async () => {
  let attempts = 0;
  const model = {
    async *stream(input) {
      attempts += 1;
      yield { type: "start", model: input.model };
      yield failure("context_overflow", true);
    },
  };
  const resilient = new RetryingModel(model, {
    maxRetries: 3,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    random: () => 0.5,
  });

  const events = await collect(resilient.stream(request()));

  assert.equal(attempts, 1);
  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  assert.equal(events[1].error.code, "context_overflow");
  assert.equal(events[1].error.retryable, true);
});

for (const contentEvent of [
  { type: "reasoning_delta", text: "partial reasoning" },
  { type: "text_delta", text: "partial answer" },
  {
    type: "tool_call",
    call: { id: "call-1", name: "act", argumentsJson: "{}" },
  },
]) {
  test(`does not replay after ${contentEvent.type}`, async () => {
    let attempts = 0;
    const model = {
      async *stream(input) {
        attempts += 1;
        yield { type: "start", model: input.model };
        yield contentEvent;
        yield failure();
      },
    };
    const resilient = new RetryingModel(model, {
      maxRetries: 2,
      fallbackModels: [fallback],
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
    });

    const events = await collect(resilient.stream(request()));

    assert.equal(attempts, 1);
    assert.equal(events.some((event) => event.type === "retry"), false);
    assert.equal(events.at(-1).type, "error");
  });
}

test("a non-retryable failure remains terminal and does not switch candidate", async () => {
  let attempts = 0;
  const model = {
    async *stream(input) {
      attempts += 1;
      yield { type: "start", model: input.model };
      yield failure("invalid_request", false);
    },
  };
  const resilient = new RetryingModel(model, {
    fallbackModels: [fallback],
  });

  const events = await collect(resilient.stream(request()));

  assert.equal(attempts, 1);
  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  assert.equal(events[1].error.code, "invalid_request");
});

test("abort interrupts retry backoff and prevents the next attempt", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const model = {
    async *stream() {
      attempts += 1;
      yield failure();
    },
  };
  const resilient = new RetryingModel(model, {
    maxRetries: 2,
    baseRetryDelayMs: 10_000,
    maxRetryDelayMs: 10_000,
    random: () => 0.5,
  });
  const iterator = resilient.stream(request(), controller.signal)[Symbol.asyncIterator]();

  const retry = await iterator.next();
  assert.equal(retry.value.type, "retry");
  controller.abort("user_stop");
  const terminal = await iterator.next();

  assert.equal(terminal.value.type, "error");
  assert.equal(terminal.value.error.code, "aborted");
  assert.equal(terminal.value.error.message, "user_stop");
  assert.equal(attempts, 1);
  assert.equal((await iterator.next()).done, true);
});

test("rejects invalid retry limits at construction", () => {
  const model = { async *stream() {} };

  assert.throws(() => new RetryingModel(model, { maxRetries: -1 }), /maxRetries/u);
  assert.throws(
    () => new RetryingModel(model, { baseRetryDelayMs: 0 }),
    /baseRetryDelayMs/u,
  );
  assert.throws(
    () => new RetryingModel(model, { maxRetryDelayMs: 0 }),
    /maxRetryDelayMs/u,
  );
});
