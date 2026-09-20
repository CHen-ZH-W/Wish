import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateModelCost,
  TokenizerUsageEstimator,
  UsageResolvingModel,
} from "../dist/models/usage.js";
import {
  createDefaultModelPricingResolver,
  ModelPricingResolver,
} from "../dist/models/pricing.js";

const requested = Object.freeze({ provider: "provider", model: "requested" });
const actual = Object.freeze({ provider: "provider", model: "actual" });

function request() {
  return {
    model: requested,
    instructions: [{ role: "system", content: "stable instruction" }],
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
    reasoningEffort: "high",
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
  let delegatedRequest;
  estimator.register(actual, {
    method: "fixture-tokenizer-v1",
    count(input) {
      tokenizerInput = input;
      assert.equal(input.request.instructions[0].content, "stable instruction");
      assert.equal(input.request.messages[0].contentParts[0].type, "image_url");
      assert.equal(input.request.tools[0].inputSchemaJson, '{"type":"object"}');
      assert.equal(input.output.toolCalls[0].id, "call-1");
      return { inputTokens: 21, outputTokens: 7 };
    },
  });
  const delegate = {
    async *stream(input) {
      delegatedRequest = input;
      yield { type: "start", model: actual };
      yield { type: "reasoning_delta", text: "think" };
      yield { type: "text_delta", text: "answer" };
      yield {
        type: "tool_call",
        call: { id: "call-1", name: "lookup", argumentsJson: '{"q":"a"}' },
      };
      yield {
        type: "done",
        finishReason: "tool_calls",
        providerCreatedAt: 1_789_963_200_000,
      };
    },
  };
  const events = await collect(new UsageResolvingModel(delegate, estimator).stream(request()));

  assert.deepEqual(tokenizerInput.output.model, actual);
  assert.equal(delegatedRequest.reasoningEffort, "high");
  assert.equal(tokenizerInput.request.reasoningEffort, "high");
  assert.equal(Object.isFrozen(tokenizerInput.request), true);
  assert.deepEqual(events.at(-1).usage, {
    inputTokens: 21,
    outputTokens: 7,
    totalTokens: 28,
    source: "estimated",
    estimationMethod: "fixture-tokenizer-v1",
  });
  assert.equal(events.at(-1).providerCreatedAt, 1_789_963_200_000);
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

test("DeepSeek Pricing shares UTC periods while selecting model and currency rates", () => {
  const pricing = createDefaultModelPricingResolver();
  const flash = { provider: "deepseek", model: "deepseek-flash" };
  const pro = { provider: "deepseek", model: "deepseek-v4-pro" };
  const mondayPeak = Date.parse("2026-09-21T01:30:00.000Z");
  const mondayBoundary = Date.parse("2026-09-21T04:00:00.000Z");
  const sunday = Date.parse("2026-09-20T02:00:00.000Z");

  const flashPeak = pricing.resolve({
    requestedModel: flash,
    requestedAt: mondayPeak,
    currency: "USD",
  });
  assert.deepEqual(flashPeak, {
    version: "deepseek-flash:2026-09-10T04:00Z",
    currency: "USD",
    effectiveFrom: "2026-09-10T04:00:00.000Z",
    inputPerMillionTokens: 0.3,
    cachedInputPerMillionTokens: 0.006,
    outputPerMillionTokens: 1.2,
    requestedModel: flash,
    billedModel: flash,
    period: "peak",
    pricedAt: "2026-09-21T01:30:00.000Z",
    timeBasis: "request_started",
  });

  const proOffPeak = pricing.resolve({
    requestedModel: pro,
    requestedAt: mondayBoundary,
    currency: "CNY",
  });
  assert.equal(proOffPeak.period, "off_peak");
  assert.equal(proOffPeak.inputPerMillionTokens, 4.5);
  assert.equal(proOffPeak.cachedInputPerMillionTokens, 0.15);
  assert.equal(proOffPeak.outputPerMillionTokens, 13.5);
  assert.equal(proOffPeak.version, "deepseek-v4-pro:2026-08-16T16:00Z");
  assert.equal(proOffPeak.effectiveFrom, "2026-08-16T16:00:00.000Z");

  const weekend = pricing.resolve({
    requestedModel: flash,
    requestedAt: sunday,
    currency: "USD",
  });
  assert.equal(weekend.period, "off_peak");
  assert.equal(weekend.inputPerMillionTokens, 0.15);
});

test("DeepSeek Pricing canonicalizes legacy names and prefers Provider time", () => {
  const pricing = createDefaultModelPricingResolver();
  const legacy = { provider: "deepseek", model: "deepseek-v4-flash" };
  const quote = pricing.resolve({
    requestedModel: legacy,
    requestedAt: Date.parse("2026-09-21T04:30:00.000Z"),
    providerCreatedAt: Date.parse("2026-09-21T06:15:00.000Z"),
    currency: "USD",
  });

  assert.deepEqual(quote.requestedModel, legacy);
  assert.deepEqual(quote.billedModel, {
    provider: "deepseek",
    model: "deepseek-flash",
  });
  assert.equal(quote.period, "peak");
  assert.equal(quote.pricedAt, "2026-09-21T06:15:00.000Z");
  assert.equal(quote.timeBasis, "provider_created");
  assert.equal(pricing.resolve({
    requestedModel: legacy,
    requestedAt: Date.parse("2026-09-10T03:59:59.999Z"),
    currency: "USD",
  }), undefined, "unknown historical schedules must remain unavailable");
  assert.equal(pricing.resolve({
    requestedModel: legacy,
    requestedAt: Date.parse("2026-09-10T04:00:00.000Z"),
    currency: "USD",
  }).effectiveFrom, "2026-09-10T04:00:00.000Z");
  assert.equal(pricing.resolve({
    requestedModel: legacy,
    requestedAt: Date.parse("2026-09-21T01:00:00.000Z"),
    currency: "EUR",
  }), undefined, "Pricing must not perform implicit FX conversion");
});

test("quoted cost preserves the immutable pricing evidence", () => {
  const model = { provider: "deepseek", model: "deepseek-flash" };
  const quote = createDefaultModelPricingResolver().resolve({
    requestedModel: model,
    requestedAt: Date.parse("2026-09-21T01:30:00.000Z"),
    currency: "USD",
  });
  const cost = calculateModelCost({
    model,
    usage: {
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 100,
      totalTokens: 1_100,
      source: "provider",
    },
    price: quote,
  });

  assert.equal(cost.status, "available");
  assert.equal(cost.uncachedInputCost, 0.00006);
  assert.equal(cost.cachedInputCost, 0.0000048);
  assert.equal(cost.outputCost, 0.00012);
  assert.equal(cost.totalCost, 0.0001848);
  assert.deepEqual(cost.billedModel, model);
  assert.equal(cost.pricePeriod, "peak");
  assert.equal(cost.pricedAt, "2026-09-21T01:30:00.000Z");
  assert.equal(cost.priceTimeBasis, "request_started");
  assert.equal(cost.estimated, false);
  assert.equal(Object.isFrozen(quote), true);
  assert.equal(Object.isFrozen(quote.billedModel), true);

  assert.equal(calculateModelCost({
    model: { provider: "deepseek", model: "deepseek-v4-pro" },
    usage: {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 2,
      source: "provider",
    },
    price: quote,
  }).reason, "price_model_mismatch");
});

test("static configured prices resolve as flat quotes without FX", () => {
  const pricing = new ModelPricingResolver();
  const model = { provider: "fixture", model: "one" };
  const configuredPrice = {
    version: "fixture:v1",
    currency: "USD",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
  };
  const quote = pricing.resolve({
    requestedModel: model,
    requestedAt: Date.parse("2026-09-21T01:00:00.000Z"),
    currency: "USD",
    configuredPrice,
  });

  assert.equal(quote.period, "flat");
  assert.deepEqual(quote.requestedModel, model);
  assert.deepEqual(quote.billedModel, model);
  assert.equal(pricing.resolve({
    requestedModel: model,
    requestedAt: Date.parse("2026-09-21T01:00:00.000Z"),
    currency: "CNY",
    configuredPrice,
  }), undefined);
});

test("Pricing policy registration is exact, duplicate-safe, and disposable", () => {
  const pricing = new ModelPricingResolver();
  const model = { provider: "dynamic", model: "one" };
  const policy = {
    provider: "dynamic",
    quote(input) {
      return {
        version: "dynamic:v1",
        currency: input.currency,
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
        requestedModel: input.requestedModel,
        billedModel: input.requestedModel,
        period: "custom",
        pricedAt: new Date(input.requestedAt).toISOString(),
        timeBasis: "request_started",
      };
    },
  };
  const registration = pricing.register(policy);
  assert.throws(() => pricing.register(policy), /already registered/u);
  assert.equal(pricing.resolve({
    requestedModel: model,
    requestedAt: Date.parse("2026-09-21T01:00:00.000Z"),
    currency: "USD",
  }).period, "custom");
  assert.equal(registration.unregister(), true);
  assert.equal(registration.unregister(), false);
  assert.equal(pricing.resolve({
    requestedModel: model,
    requestedAt: Date.parse("2026-09-21T01:00:00.000Z"),
    currency: "USD",
  }), undefined);
});
