import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WebUiControlError } from "../dist/apps/webui/controls.js";
import { projectSessionModelUsage } from "../dist/models/pricing/consumers/webui-control.js";
import { JournalModelAttemptLedger, MODEL_ATTEMPT_JOURNAL_NAMESPACE } from "../dist/models/pricing/ledger.js";
import { calculateModelCost } from "../dist/models/usage.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";

const model = Object.freeze({ provider: "deepseek", model: "deepseek-chat" });
const scope = Object.freeze({ sessionId: "session-a", runId: "run-a", userTurnId: "turn-a", stepId: "step-a" });
const usage = Object.freeze({ inputTokens: 1_000, cachedInputTokens: 500, cacheWriteInputTokens: 0,
  outputTokens: 100, totalTokens: 1_100, source: "provider" });

function recordedCost(overrides = {}) {
  return { status: "available", model, currency: "USD", priceVersion: "historical-v1",
    uncachedInputCost: 0.1, cachedInputCost: 0.02, cacheWriteInputCost: 0.03, outputCost: 0.05,
    totalCost: 0.2, cacheSavings: 999, estimated: false, ...overrides };
}

function attempt(id, overrides = {}) {
  return { schemaVersion: 1, attemptId: id, ...scope, requestedModel: model,
    requestedAt: "2026-09-21T01:00:00.000Z", endedAt: "2026-09-21T01:00:01.000Z",
    status: "completed", ...overrides };
}

function project(records) {
  return projectSessionModelUsage(scope.sessionId, records).cost;
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12,
    `Expected ${actual} to be close to ${expected}`);
}

test("Session cost sums persisted categories without counting cache savings as spend", () => {
  const view = project([attempt("one", { cost: recordedCost() }), attempt("two", { cost: recordedCost() })]);
  assert.equal(view.coverage, "complete");
  assert.equal(view.settledAttempts, 2);
  assert.equal(view.pricedAttempts, 2);
  assert.equal(view.unavailableAttempts, 0);
  assert.equal(view.runningAttempts, 0);
  assert.equal(view.currencies.length, 1);
  const currency = view.currencies[0];
  assert.equal(currency.currency, "USD");
  assertClose(currency.totalCost, 0.4);
  assertClose(currency.uncachedInputCost, 0.2);
  assertClose(currency.cachedInputCost, 0.04);
  assertClose(currency.cacheWriteInputCost, 0.06);
  assertClose(currency.outputCost, 0.1);
  assert.equal("cacheSavings" in currency, false);
  assert.equal(currency.attempts, 2);
  assert.equal(currency.estimated, false);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.currencies), true);
  assert.equal(Object.isFrozen(currency), true);
  assert.equal(Object.isFrozen(currency.periods), true);
  assert.equal(Object.isFrozen(currency.periods[0]), true);
});

test("The Session boundary filters both tokens and costs even when the caller passes mixed records", () => {
  const view = projectSessionModelUsage(scope.sessionId, [
    attempt("own", { usage, cost: recordedCost() }),
    attempt("foreign", { sessionId: "session-b", usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }, cost: recordedCost({ totalCost: Infinity }) }),
    attempt("foreign-running", { sessionId: "session-b", status: "running" }),
  ]);
  assert.equal(view.tokens.input, usage.inputTokens);
  assert.equal(view.attempts.completed, 1);
  assert.equal(view.cost.pricedAttempts, 1);
  assert.equal(view.cost.runningAttempts, 0);
  assert.equal(view.cost.currencies[0].totalCost, 0.2);
});

test("Currencies remain separate and estimates propagate per currency and period", () => {
  const view = project([
    attempt("dollar", { cost: recordedCost({ pricePeriod: "peak" }) }),
    attempt("dollar-estimate", { cost: recordedCost({ pricePeriod: "off_peak", estimated: true }) }),
    attempt("yuan", { cost: recordedCost({ currency: "CNY", pricePeriod: "peak" }) }),
  ]);
  assert.equal(view.coverage, "complete");
  assert.equal("totalCost" in view, false);
  assert.deepEqual(view.currencies.map(entry => entry.currency), ["CNY", "USD"]);
  const yuan = view.currencies.find(entry => entry.currency === "CNY");
  const dollars = view.currencies.find(entry => entry.currency === "USD");
  assert.equal(yuan.totalCost, 0.2);
  assert.equal(yuan.estimated, false);
  assertClose(dollars.totalCost, 0.4);
  assert.equal(dollars.estimated, true);
  assert.equal(dollars.periods.find(entry => entry.period === "off_peak").estimated, true);
  assert.equal(dollars.periods.find(entry => entry.period === "peak").estimated, false);
});

test("Missing and unavailable costs make known spend partial across every terminal status", () => {
  const view = project([
    attempt("known", { cost: recordedCost() }),
    attempt("old-history"),
    attempt("no-price", { cost: { status: "unavailable", model, estimated: false, reason: "price_unavailable" } }),
    ...["failed", "aborted", "interrupted"].map(status => attempt(status, { status })),
  ]);
  assert.equal(view.coverage, "partial");
  assert.equal(view.settledAttempts, 6);
  assert.equal(view.pricedAttempts, 1);
  assert.equal(view.unavailableAttempts, 5);
  assert.equal(view.currencies[0].totalCost, 0.2);
});

test("A priced terminal failure is still spend while running records remain unfinalized", () => {
  const view = project([
    attempt("failed-priced", { status: "failed", cost: recordedCost() }),
    attempt("running", { status: "running", cost: recordedCost({ totalCost: 1_000 }) }),
  ]);
  assert.equal(view.coverage, "partial");
  assert.equal(view.settledAttempts, 1);
  assert.equal(view.pricedAttempts, 1);
  assert.equal(view.unavailableAttempts, 0);
  assert.equal(view.runningAttempts, 1);
  assert.equal(view.currencies[0].totalCost, 0.2);
});

test("Unknown or running-only history has no fabricated zero-currency amount", () => {
  for (const records of [[], [attempt("legacy")], [attempt("waiting", { status: "running" })]]) {
    const view = project(records);
    assert.equal(view.coverage, "unavailable");
    assert.deepEqual(view.currencies, []);
    assert.equal(view.pricedAttempts, 0);
  }
  const waiting = project([attempt("waiting", { status: "running" })]);
  assert.equal(waiting.settledAttempts, 0);
  assert.equal(waiting.unavailableAttempts, 0);
  assert.equal(waiting.runningAttempts, 1);
});

test("Period grouping uses recorded quote then cost metadata without deriving wall-clock periods", () => {
  const view = project([
    attempt("quote-wins", { quote: { period: "off_peak" }, cost: recordedCost({ pricePeriod: "peak" }) }),
    attempt("cost-period", { cost: recordedCost({ pricePeriod: "peak" }) }),
    attempt("flat", { cost: recordedCost({ pricePeriod: "flat" }) }),
    attempt("legacy", { cost: recordedCost() }),
    attempt("future", { cost: recordedCost({ pricePeriod: "promotion" }) }),
  ]);
  const periods = view.currencies[0].periods;
  assert.deepEqual(periods.map(entry => entry.period), ["flat", "off_peak", "peak", "promotion", "unknown"]);
  for (const entry of periods) assert.deepEqual(entry, {
    period: entry.period, totalCost: 0.2, attempts: 1, estimated: false,
  });
});

test("A recorded free attempt is an available zero amount", () => {
  const view = project([attempt("free", { cost: recordedCost({
    totalCost: 0, uncachedInputCost: 0, cachedInputCost: 0, cacheWriteInputCost: 0, outputCost: 0,
  }) })]);
  assert.equal(view.coverage, "complete");
  assert.equal(view.currencies.length, 1);
  assert.equal(view.currencies[0].totalCost, 0);
});

test("Malformed or unsafe persisted amount evidence fails closed", () => {
  for (const override of [
    { totalCost: NaN }, { totalCost: Infinity }, { totalCost: -1 },
    { cachedInputCost: Infinity }, { outputCost: -0.1 },
    { totalCost: Number.MAX_SAFE_INTEGER + 1 }, { totalCost: 0.5 },
    { currency: "usd" }, { currency: "USD " }, { estimated: "false" },
    { pricePeriod: "" },
  ]) {
    assert.throws(() => project([attempt("invalid", { cost: recordedCost(override) })]),
      error => error instanceof WebUiControlError && error.code === "model_usage_unavailable");
  }
  const huge = recordedCost({ totalCost: Number.MAX_SAFE_INTEGER,
    uncachedInputCost: Number.MAX_SAFE_INTEGER, cachedInputCost: 0, cacheWriteInputCost: 0, outputCost: 0 });
  assert.throws(() => project([attempt("huge", { cost: huge }), attempt("overflow", { cost: huge })]),
    error => error instanceof WebUiControlError && error.code === "model_usage_unavailable");
});

test("Recorded quote and amounts survive Journal reopen without repricing or period reassignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-session-model-cost-"));
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  const quote = Object.freeze({ version: "historical-promo-v1", currency: "CNY",
    inputPerMillionTokens: 2, cachedInputPerMillionTokens: 0.02, outputPerMillionTokens: 8,
    requestedModel: model, billedModel: model, period: "off_peak",
    pricedAt: "2026-09-21T01:00:00.000Z", timeBasis: "request_started" });
  const cost = calculateModelCost({ model, usage, price: quote });
  try {
    const ledger = new JournalModelAttemptLedger(
      backend.journal.open({ namespace: MODEL_ATTEMPT_JOURNAL_NAMESPACE }), backend.id);
    await ledger.start({ attemptId: "persisted", ...scope, requestedModel: model,
      requestedAt: "2026-09-21T01:00:00.000Z" });
    await ledger.finish({ attemptId: "persisted", status: "completed",
      endedAt: "2026-09-21T01:00:01.000Z", usage, quote, cost });
    const before = project(await ledger.list({ sessionId: scope.sessionId }));
    await ledger.close();
    const reopened = new JournalModelAttemptLedger(
      backend.journal.open({ namespace: MODEL_ATTEMPT_JOURNAL_NAMESPACE }), backend.id);
    const after = project(await reopened.list({ sessionId: scope.sessionId }));
    assert.deepEqual(after, before);
    assert.equal(after.currencies[0].currency, "CNY");
    assert.equal(after.currencies[0].totalCost, cost.totalCost);
    assert.equal(after.currencies[0].periods[0].period, "off_peak");
    await reopened.close();
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
