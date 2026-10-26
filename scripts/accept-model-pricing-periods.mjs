import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultModelPricingResolver,
  DeepSeekPricingPolicy,
} from "../dist/models/pricing.js";

const flash = Object.freeze({ provider: "deepseek", model: "deepseek-flash" });
const pro = Object.freeze({ provider: "deepseek", model: "deepseek-v4-pro" });

function input(at, extra = {}) {
  return {
    requestedModel: flash,
    requestedAt: Date.parse(at),
    currency: "USD",
    ...extra,
  };
}

test("DeepSeek peak windows include their start and exclude their end in Beijing time", () => {
  const pricing = createDefaultModelPricingResolver();
  const cases = [
    ["08:59:59.999", "off_peak"],
    ["09:00:00.000", "peak"],
    ["11:59:59.999", "peak"],
    ["12:00:00.000", "off_peak"],
    ["13:59:59.999", "off_peak"],
    ["14:00:00.000", "peak"],
    ["17:59:59.999", "peak"],
    ["18:00:00.000", "off_peak"],
  ];
  for (const [time, expected] of cases) {
    const at = `2026-10-19T${time}+08:00`;
    const quote = pricing.resolve(input(at));
    assert.equal(quote.period, expected, at);
    assert.equal(quote.pricedAt, new Date(at).toISOString());
    assert.equal(quote.timeBasis, "request_started");
  }
});

test("DeepSeek USD and CNY rates match the official model-specific peak and half-price off-peak tables", () => {
  const pricing = createDefaultModelPricingResolver();
  const cases = [
    [flash, "USD", [0.3, 0.006, 1.2]],
    [flash, "CNY", [2, 0.04, 8]],
    [pro, "USD", [1.32, 0.044, 3.96]],
    [pro, "CNY", [9, 0.3, 27]],
  ];
  for (const [model, currency, peakRates] of cases) {
    const peak = pricing.resolve(input("2026-10-19T09:00:00+08:00", {
      requestedModel: model,
      currency,
    }));
    const offPeak = pricing.resolve(input("2026-10-19T12:00:00+08:00", {
      requestedModel: model,
      currency,
    }));
    const fields = ["inputPerMillionTokens", "cachedInputPerMillionTokens", "outputPerMillionTokens"];
    assert.deepEqual(fields.map((field) => peak[field]), peakRates);
    assert.deepEqual(fields.map((field) => offPeak[field]), peakRates.map((rate) => rate / 2));
    assert.equal(peak.currency, currency);
    assert.equal(offPeak.version, peak.version, "schedule selection must not rewrite the rate version");
  }
});

test("Chinese public holidays are off-peak throughout both weekday peak windows", () => {
  const pricing = createDefaultModelPricingResolver();
  for (const date of ["2026-09-25", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]) {
    for (const time of ["09:00:00", "11:59:59", "14:00:00", "17:59:59"]) {
      const at = `${date}T${time}+08:00`;
      assert.equal(pricing.resolve(input(at)).period, "off_peak", at);
    }
  }
  assert.equal(pricing.resolve(input("2026-09-24T09:00:00+08:00")).period, "peak");
  assert.equal(pricing.resolve(input("2026-09-28T09:00:00+08:00")).period, "peak");
  assert.equal(pricing.resolve(input("2026-09-30T14:00:00+08:00")).period, "peak");
  assert.equal(pricing.resolve(input("2026-10-08T09:00:00+08:00")).period, "peak");
});

test("weekends stay off-peak, including published makeup working weekends", () => {
  const pricing = createDefaultModelPricingResolver();
  for (const date of ["2026-09-19", "2026-09-20", "2026-10-10", "2026-10-11"]) {
    for (const time of ["09:00:00", "14:00:00"]) {
      const at = `${date}T${time}+08:00`;
      assert.equal(pricing.resolve(input(at)).period, "off_peak", at);
    }
  }
});

test("UTC dates crossing Beijing midnight preserve the intended local date and request instant", () => {
  const pricing = createDefaultModelPricingResolver();
  const cases = [
    ["2026-10-23T15:59:59.999Z", "2026-10-23T23:59:59.999+08:00", "off_peak"],
    ["2026-10-23T16:00:00.000Z", "2026-10-24T00:00:00.000+08:00", "off_peak"],
    ["2026-10-25T16:00:00.000Z", "2026-10-26T00:00:00.000+08:00", "off_peak"],
    ["2026-10-26T01:00:00.000Z", "2026-10-26T09:00:00.000+08:00", "peak"],
  ];
  for (const [utc, beijing, expected] of cases) {
    const utcQuote = pricing.resolve(input(utc));
    assert.equal(utcQuote.period, expected, utc);
    assert.equal(utcQuote.pricedAt, utc);
    assert.deepEqual(utcQuote, pricing.resolve(input(beijing)));
  }
});

test("Provider creation time selects the period across request, holiday, and weekend boundaries", () => {
  const pricing = createDefaultModelPricingResolver();
  const cases = [
    ["2026-10-19T08:59:59+08:00", "2026-10-19T09:00:00+08:00", "peak"],
    ["2026-10-19T11:59:59+08:00", "2026-10-19T12:00:00+08:00", "off_peak"],
    ["2026-09-24T14:00:00+08:00", "2026-09-25T09:00:00+08:00", "off_peak"],
    ["2026-10-09T14:00:00+08:00", "2026-10-10T09:00:00+08:00", "off_peak"],
  ];
  for (const [requestedAt, providerAt, expected] of cases) {
    const quote = pricing.resolve(input(requestedAt, {
      providerCreatedAt: Date.parse(providerAt),
    }));
    assert.equal(quote.period, expected, providerAt);
    assert.equal(quote.pricedAt, new Date(providerAt).toISOString());
    assert.equal(quote.timeBasis, "provider_created");
  }
});

test("unknown holiday years leave weekday candidate peaks unpriced without an explicit static override", () => {
  const policy = new DeepSeekPricingPolicy();
  const pricing = createDefaultModelPricingResolver();
  for (const at of ["2027-01-01T09:00:00+08:00", "2027-07-05T14:00:00+08:00"]) {
    assert.equal(policy.quote(input(at)), undefined, at);
    assert.equal(pricing.resolve(input(at)), undefined, at);
  }
  assert.equal(pricing.resolve(input("2027-01-01T12:00:00+08:00")).period, "off_peak");
  assert.equal(pricing.resolve(input("2027-01-02T09:00:00+08:00")).period, "off_peak");
  assert.equal(pricing.resolve(input("2026-12-31T09:00:00+08:00", {
    providerCreatedAt: Date.parse("2027-01-01T09:00:00+08:00"),
  })), undefined, "Provider creation time also governs holiday calendar coverage");
});

test("explicit configured prices retain the existing flat fallback contract", () => {
  const configuredPrice = {
    version: "user-configured:2027",
    currency: "USD",
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
  };
  const quote = createDefaultModelPricingResolver().resolve(input("2027-01-01T09:00:00+08:00", {
    configuredPrice,
  }));
  assert.equal(quote.period, "flat");
  assert.equal(quote.version, configuredPrice.version);
  assert.equal(quote.inputPerMillionTokens, 1);
});

test("holiday additions leave exact rate versions, effective dates, and prior quote snapshots intact", () => {
  const pricing = createDefaultModelPricingResolver();
  const prior = pricing.resolve(input("2026-09-21T09:00:00+08:00"));
  const snapshot = JSON.stringify(prior);
  pricing.resolve(input("2026-09-25T09:00:00+08:00"));
  assert.equal(JSON.stringify(prior), snapshot);
  assert.equal(Object.isFrozen(prior), true);
  assert.equal(prior.version, "deepseek-flash:2026-09-10T04:00Z");
  assert.equal(prior.effectiveFrom, "2026-09-10T04:00:00.000Z");
  assert.equal(pricing.resolve(input("2026-09-10T03:59:59.999Z")), undefined);
  assert.equal(pricing.resolve(input("2026-09-10T04:00:00.000Z")).period, "off_peak");
  assert.equal(pricing.resolve(input("2026-08-16T15:59:59.999Z", { requestedModel: pro })), undefined);
  assert.equal(pricing.resolve(input("2026-08-16T16:00:00.000Z", { requestedModel: pro })).version,
    "deepseek-v4-pro:2026-08-16T16:00Z");
});

test("unknown currencies and billed routes do not acquire guessed DeepSeek rates", () => {
  const pricing = createDefaultModelPricingResolver();
  assert.equal(pricing.resolve(input("2026-10-19T09:00:00+08:00", { currency: "EUR" })), undefined);
  assert.equal(pricing.resolve(input("2026-10-19T09:00:00+08:00", {
    requestedModel: { provider: "deepseek", model: "deepseek-future" },
  })), undefined);
  assert.equal(pricing.resolve(input("2026-10-19T09:00:00+08:00", {
    billedModel: { provider: "deepseek", model: "deepseek-future" },
  })), undefined);
  for (const alias of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const quote = pricing.resolve(input("2026-10-19T09:00:00+08:00", {
      requestedModel: { provider: "deepseek", model: alias },
    }));
    assert.deepEqual(quote.billedModel, flash, "only officially documented compatibility names are canonicalized");
  }
});

test("the host timezone cannot change Beijing holiday or peak selection", () => {
  const previous = process.env.TZ;
  try {
    const pricing = createDefaultModelPricingResolver();
    for (const [timezone, offset] of [["UTC", 0], ["Asia/Shanghai", -480], ["America/Los_Angeles", 420]]) {
      process.env.TZ = timezone;
      assert.equal(new Date("2026-10-19T01:00:00Z").getTimezoneOffset(), offset,
        "verify that the host local timezone changed before checking pricing");
      const periods = ["2026-09-25T01:00:00Z", "2026-10-19T01:00:00Z", "2026-10-19T04:00:00Z"]
        .map((at) => pricing.resolve(input(at)).period);
      assert.deepEqual(periods, ["off_peak", "peak", "off_peak"], timezone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
