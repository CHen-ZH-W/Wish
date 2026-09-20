import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RetryingModel } from "../dist/core/model/model.js";
import { AttemptRecordingModel } from "../dist/models/pricing/attempt-recording-model.js";
import {
  JournalModelAttemptLedger,
  MODEL_ATTEMPT_JOURNAL_NAMESPACE,
  MemoryModelAttemptLedger,
} from "../dist/models/pricing/ledger.js";
import { createDefaultModelPricingResolver } from "../dist/models/pricing.js";
import { StorageCorruptionError } from "../dist/storage/errors.js";
import { JOURNAL_ANY } from "../dist/storage/journal.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";

const scope = Object.freeze({
  sessionId: "session-1",
  runId: "run-1",
  userTurnId: "turn-1",
  stepId: "step-1",
});
const flash = Object.freeze({ provider: "deepseek", model: "deepseek-flash" });

test("attempt recorder persists usage, exact quote, and immutable cost evidence", async () => {
  const ledger = new MemoryModelAttemptLedger();
  const pricing = createDefaultModelPricingResolver();
  const instants = [
    Date.parse("2026-09-21T04:30:00.000Z"),
    Date.parse("2026-09-21T06:15:02.000Z"),
  ];
  const delegate = {
    async *stream() {
      yield { type: "start", model: flash };
      yield {
        type: "done",
        finishReason: "stop",
        providerCreatedAt: Date.parse("2026-09-21T06:15:00.000Z"),
        usage: {
          inputTokens: 1_000,
          cachedInputTokens: 800,
          outputTokens: 100,
          totalTokens: 1_100,
          source: "provider",
        },
      };
    },
  };
  const model = new AttemptRecordingModel(delegate, {
    ledger,
    currency: "USD",
    attemptId: () => "attempt-1",
    now: () => instants.shift(),
    quote: (reference, request) => pricing.resolve({
      requestedModel: reference,
      ...request,
    }),
  });

  await collect(model.stream(request()));
  const record = await ledger.get("attempt-1");
  assert.equal(record.status, "completed");
  assert.deepEqual(record.requestedModel, flash);
  assert.deepEqual(record.billedModel, flash);
  assert.equal(record.requestedAt, "2026-09-21T04:30:00.000Z");
  assert.equal(record.endedAt, "2026-09-21T06:15:02.000Z");
  assert.equal(record.usage.cachedInputTokens, 800);
  assert.equal(record.quote.version, "deepseek-flash:2026-09-10T04:00Z");
  assert.equal(record.quote.period, "peak");
  assert.equal(record.quote.pricedAt, "2026-09-21T06:15:00.000Z");
  assert.equal(record.quote.timeBasis, "provider_created");
  assert.equal(record.cost.priceVersion, record.quote.version);
  assert.equal(record.cost.pricePeriod, "peak");
  assert.equal(record.cost.totalCost, 0.0001848);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.quote), true);
});

test("abort after start still writes a durable terminal record", async () => {
  const ledger = new MemoryModelAttemptLedger();
  const controller = new AbortController();
  const delegate = {
    async *stream() {
      yield { type: "start", model: flash };
      controller.abort(new Error("cancelled"));
    },
  };
  const model = new AttemptRecordingModel(delegate, {
    ledger,
    currency: "USD",
    attemptId: () => "attempt-aborted",
    now: () => Date.parse("2026-09-21T04:00:00.000Z"),
    quote: () => undefined,
  });

  await collect(model.stream(request(), controller.signal));
  const record = await ledger.get("attempt-aborted");
  assert.equal(record.status, "aborted");
  assert.equal(record.error.code, "aborted");
});

test("retrying model creates one durable record per Provider attempt", async () => {
  const ledger = new MemoryModelAttemptLedger();
  let calls = 0;
  let attemptOrdinal = 0;
  let now = Date.parse("2026-09-21T04:00:00.000Z");
  const delegate = {
    async *stream() {
      calls += 1;
      yield { type: "start", model: flash };
      if (calls === 1) {
        yield {
          type: "error",
          error: { code: "network_error", message: "temporary", retryable: true },
        };
        return;
      }
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 2,
          totalTokens: 12,
          source: "provider",
        },
      };
    },
  };
  const attempts = new AttemptRecordingModel(delegate, {
    ledger,
    currency: "USD",
    attemptId: () => `attempt-${++attemptOrdinal}`,
    now: () => now++,
    quote: () => undefined,
  });
  const model = new RetryingModel(attempts, {
    maxRetries: 1,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    random: () => 0,
  });

  const events = await collect(model.stream(request()));
  assert.equal(events.some((event) => event.type === "retry"), true);
  assert.equal(events.at(-1).type, "done");
  const records = await ledger.list({ stepId: scope.stepId });
  assert.equal(records.length, 2);
  assert.equal(records[0].status, "failed");
  assert.equal(records[0].error.code, "network_error");
  assert.equal(records[1].status, "completed");
  assert.equal(records[1].cost.status, "unavailable");
  assert.equal(records[1].cost.reason, "price_unavailable");
});

test("Journal ledger survives reopen and recovers an unterminated attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-attempt-ledger-"));
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  try {
    const first = new JournalModelAttemptLedger(
      backend.journal.open({ namespace: MODEL_ATTEMPT_JOURNAL_NAMESPACE }),
      backend.id,
    );
    await first.start({
      attemptId: "attempt-crashed",
      ...scope,
      requestedAt: "2026-09-21T01:00:00.000Z",
      requestedModel: flash,
    });
    await first.close();

    const reopened = new JournalModelAttemptLedger(
      backend.journal.open({ namespace: MODEL_ATTEMPT_JOURNAL_NAMESPACE }),
      backend.id,
    );
    assert.equal((await reopened.get("attempt-crashed")).status, "running");
    assert.equal(await reopened.recoverInterrupted("2026-09-21T02:00:00.000Z"), 1);
    const recovered = await reopened.get("attempt-crashed");
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.endedAt, "2026-09-21T02:00:00.000Z");
    assert.equal(recovered.error.code, "unknown");
    assert.equal(await reopened.recoverInterrupted("2026-09-21T03:00:00.000Z"), 0);
    await reopened.close();
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Journal ledger rejects malformed immutable billing evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-attempt-corruption-"));
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  try {
    const journal = backend.journal.open({ namespace: MODEL_ATTEMPT_JOURNAL_NAMESPACE });
    const ledger = new JournalModelAttemptLedger(journal, backend.id);
    await ledger.start({
      attemptId: "attempt-corrupt",
      ...scope,
      requestedAt: "2026-09-21T01:00:00.000Z",
      requestedModel: flash,
    });
    await journal.append({
      idempotencyKey: "inject-malformed-finish",
      entries: [new TextEncoder().encode(JSON.stringify({
        schemaVersion: 1,
        kind: "finished",
        attemptId: "attempt-corrupt",
        status: "completed",
        endedAt: "2026-09-21T01:00:01.000Z",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          source: "provider",
        },
        cost: {
          status: "available",
          model: flash,
        },
      }))],
    }, JOURNAL_ANY);

    await assert.rejects(
      ledger.get("attempt-corrupt"),
      (error) => error instanceof StorageCorruptionError,
    );
    await ledger.close();
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function request() {
  return {
    model: flash,
    instructions: [],
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    invocationScope: scope,
  };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
