import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateModelCost,
  TokenizerUsageEstimator,
  UsageResolvingModel,
} from "../dist/models/usage.js";

const requested = Object.freeze({ provider: "provider", model: "requested" });
const actual = Object.freeze({ provider: "provider", model: "actual" });

function request() {
  return {
    model: requested,
    messages: [{
      role: "user",
      content: "question",
      contentParts: [{
        type: "image_url",
        imageUrl: { url: "https://images.example.test/a.png" },
      }],
    }],
    tools: [{
      name: "lookup",
      description: "Lookup",
      inputSchemaJson: '{"type":"object"}',
    }],
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("UsageResolvingModel estimates a no-usage completion with the actual model tokenizer", async () => {
  const estimator = new TokenizerUsageEstimator();
  let tokenizerInput;
  estimator.register(actual, {
    method: "fixture-tokenizer-v1",
    count(input) {
      tokenizerInput = input;
      assert.equal(input.request.messages[0].contentParts[0].type, "image_url");
      assert.equal(input.request.tools[0].inputSchemaJson, '{"type":"object"}');
      assert.equal(input.output.toolCalls[0].id, "call-1");
      return { inputTokens: 21, outputTokens: 7 };
    },
  });
  const delegate = {
    async *stream() {
      yield { type: "start", model: actual };
      yield { type: "reasoning_delta", text: "think" };
      yield { type: "text_delta", text: "answer" };
      yield {
        type: "tool_call",
        call: { id: "call-1", name: "lookup", argumentsJson: '{"q":"a"}' },
      };
      yield { type: "done", finishReason: "tool_calls" };
    },
  };
  const events = await collect(new UsageResolvingModel(delegate, estimator).stream(request()));

  assert.deepEqual(tokenizerInput.output.model, actual);
  assert.equal(Object.isFrozen(tokenizerInput.request), true);
  assert.deepEqual(events.at(-1).usage, {
    inputTokens: 21,
    outputTokens: 7,
    totalTokens: 28,
    source: "estimated",
    estimationMethod: "fixture-tokenizer-v1",
  });
});

test("Provider usage wins and estimator failures never change Model completion", async () => {
  let estimateCalls = 0;
  const providerUsage = {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    source: "provider",
  };
  const withUsage = {
    async *stream() {
      yield { type: "start", model: actual };
      yield { type: "done", usage: providerUsage };
    },
  };
  const estimator = {
    estimate() {
      estimateCalls += 1;
      throw new Error("estimator unavailable");
    },
  };
  const providerEvents = await collect(
    new UsageResolvingModel(withUsage, estimator).stream(request()),
  );
  assert.equal(estimateCalls, 0);
  assert.equal(providerEvents.at(-1).usage, providerUsage);

  const withoutUsage = {
    async *stream() {
      yield { type: "start", model: actual };
      yield { type: "text_delta", text: "completed" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const noUsageEvents = await collect(
    new UsageResolvingModel(withoutUsage, estimator).stream(request()),
  );
  assert.equal(noUsageEvents.at(-1).type, "done");
  assert.equal("usage" in noUsageEvents.at(-1), false);
});

test("cost uses actual model, cache categories, price version, and estimation state", () => {
  const cost = calculateModelCost({
    model: actual,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 50,
      totalTokens: 150,
      source: "mixed",
      estimationMethod: "fixture-tokenizer-v1",
    },
    price: {
      version: "2026-09-01",
      currency: "USD",
      effectiveFrom: "2026-09-01T00:00:00Z",
      inputPerMillionTokens: 2,
      cachedInputPerMillionTokens: 0.5,
      cacheWriteInputPerMillionTokens: 3,
      outputPerMillionTokens: 8,
    },
  });

  assert.deepEqual(cost.model, actual);
  assert.equal(cost.status, "available");
  assert.equal(cost.uncachedInputCost, 0.00014);
  assert.equal(cost.cachedInputCost, 0.00001);
  assert.equal(cost.cacheWriteInputCost, 0.00003);
  assert.equal(cost.outputCost, 0.0004);
  assert.equal(cost.totalCost, 0.00058);
  assert.equal(cost.cacheSavings, 0.00003);
  assert.equal(cost.estimated, true);
  assert.equal(cost.priceVersion, "2026-09-01");
  assert.equal(Object.isFrozen(cost), true);
});

test("cost remains unavailable when price or priced cache usage is unknown", () => {
  const usage = {
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    source: "provider",
  };
  assert.equal(calculateModelCost({ model: actual, usage }).reason, "price_unavailable");
  assert.equal(calculateModelCost({
    model: actual,
    usage,
    price: {
      version: "v1",
      currency: "USD",
      inputPerMillionTokens: 1,
      cachedInputPerMillionTokens: 0.1,
      outputPerMillionTokens: 2,
    },
  }).reason, "cached_usage_unknown");
});
