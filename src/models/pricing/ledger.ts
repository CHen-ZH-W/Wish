import type { ModelError, ModelRef, ModelUsage } from "../../core/model/model.js";
import { StorageCorruptionError } from "../../storage/errors.js";
import { JOURNAL_ANY, type Journal } from "../../storage/journal.js";
import type { ModelPriceQuote } from "../pricing.js";
import {
  calculateModelCost,
  type ModelCost,
  type ModelCostUnavailableReason,
} from "../usage.js";
import type {
  ListModelAttemptsInput,
  ModelAttemptFinish,
  ModelAttemptLedger,
  ModelAttemptRecord,
  ModelAttemptStart,
  ModelAttemptStatus,
} from "./attempts.js";

export const MODEL_ATTEMPT_JOURNAL_NAMESPACE = "models/pricing/attempts/v1";

interface StartedEvent extends ModelAttemptStart {
  readonly schemaVersion: 1;
  readonly kind: "started";
}

interface FinishedEvent extends ModelAttemptFinish {
  readonly schemaVersion: 1;
  readonly kind: "finished";
}

type AttemptEvent = StartedEvent | FinishedEvent;

/** Append-only Pricing ledger backed by the generic Storage Journal facet. */
export class JournalModelAttemptLedger implements ModelAttemptLedger {
  private closing: Promise<void> | undefined;

  constructor(
    private readonly journal: Journal,
    private readonly backendId: string,
  ) {}

  async start(input: ModelAttemptStart, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const event: StartedEvent = Object.freeze({
      schemaVersion: 1,
      kind: "started",
      ...snapshotStart(input),
    });
    await this.append(event, `${event.attemptId}:started`, signal);
  }

  async finish(input: ModelAttemptFinish, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const event: FinishedEvent = Object.freeze({
      schemaVersion: 1,
      kind: "finished",
      ...snapshotFinish(input),
    });
    await this.append(event, `${event.attemptId}:finished`, signal);
  }

  async get(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<ModelAttemptRecord | undefined> {
    const id = identifier(attemptId, "Model attempt id");
    return (await this.readRecords(signal)).find((record) => record.attemptId === id);
  }

  async list(
    input: ListModelAttemptsInput = {},
    signal?: AbortSignal,
  ): Promise<readonly ModelAttemptRecord[]> {
    const filter = snapshotFilter(input);
    return Object.freeze((await this.readRecords(signal)).filter((record) =>
      (filter.sessionId === undefined || record.sessionId === filter.sessionId) &&
      (filter.runId === undefined || record.runId === filter.runId) &&
      (filter.userTurnId === undefined || record.userTurnId === filter.userTurnId) &&
      (filter.stepId === undefined || record.stepId === filter.stepId) &&
      (filter.status === undefined || record.status === filter.status)
    ));
  }

  async recoverInterrupted(
    endedAt: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const timestamp = isoTimestamp(endedAt, "Model attempt recovery time");
    const running = (await this.readRecords(signal)).filter(
      (record) => record.status === "running",
    );
    for (const record of running) {
      await this.finish({
        attemptId: record.attemptId,
        status: "interrupted",
        endedAt: timestamp,
        error: {
          code: "unknown",
          message: "Model attempt was interrupted before a terminal record",
          retryable: false,
        },
      }, signal);
    }
    return running.length;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.journal.flush();
      await this.journal.close();
    })();
  }

  private async append(
    event: AttemptEvent,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.journal.append({
      idempotencyKey: `model-attempt:${idempotencyKey}`,
      entries: [new TextEncoder().encode(JSON.stringify(event))],
    }, JOURNAL_ANY, signal);
  }

  private async readRecords(
    signal?: AbortSignal,
  ): Promise<readonly ModelAttemptRecord[]> {
    throwIfAborted(signal);
    const records = new Map<string, ModelAttemptRecord>();
    try {
      for await (const entry of this.journal.read({
        ...(signal === undefined ? {} : { signal }),
      })) {
        const event = decodeEvent(entry.value);
        if (event.kind === "started") {
          if (records.has(event.attemptId)) {
            throw this.corruption(`Duplicate start for Model attempt ${event.attemptId}`);
          }
          records.set(event.attemptId, Object.freeze({
            schemaVersion: 1,
            status: "running",
            ...snapshotStart(event),
          }));
          continue;
        }
        const started = records.get(event.attemptId);
        if (started === undefined) {
          throw this.corruption(`Terminal Model attempt ${event.attemptId} has no start`);
        }
        if (started.status !== "running") {
          throw this.corruption(`Duplicate terminal record for Model attempt ${event.attemptId}`);
        }
        records.set(event.attemptId, validateTerminalRecord(Object.freeze({
          ...started,
          ...snapshotFinish(event),
        })));
      }
    } catch (error: unknown) {
      if (error instanceof StorageCorruptionError) throw error;
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw this.corruption("Model attempt Journal contains invalid data", error);
      }
      throw error;
    }
    return Object.freeze([...records.values()]);
  }

  private corruption(message: string, cause?: unknown): StorageCorruptionError {
    return corruption(message, cause, this.backendId);
  }
}

/** Deterministic standalone ledger for focused compositions and tests. */
export class MemoryModelAttemptLedger implements ModelAttemptLedger {
  private readonly records = new Map<string, ModelAttemptRecord>();
  private closed = false;

  async start(input: ModelAttemptStart, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    throwIfAborted(signal);
    const start = snapshotStart(input);
    const existing = this.records.get(start.attemptId);
    if (existing !== undefined) {
      if (JSON.stringify(snapshotStart(existing)) === JSON.stringify(start)) return;
      throw new Error(`Conflicting Model attempt start: ${start.attemptId}`);
    }
    this.records.set(start.attemptId, Object.freeze({
      schemaVersion: 1,
      status: "running",
      ...start,
    }));
  }

  async finish(input: ModelAttemptFinish, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    throwIfAborted(signal);
    const finish = snapshotFinish(input);
    const started = this.records.get(finish.attemptId);
    if (started === undefined) throw new Error(`Unknown Model attempt: ${finish.attemptId}`);
    if (started.status !== "running") {
      const previous = snapshotFinish(started as ModelAttemptRecord & ModelAttemptFinish);
      if (JSON.stringify(previous) === JSON.stringify(finish)) return;
      throw new Error(`Conflicting Model attempt finish: ${finish.attemptId}`);
    }
    this.records.set(
      finish.attemptId,
      validateTerminalRecord(Object.freeze({ ...started, ...finish })),
    );
  }

  async get(attemptId: string, signal?: AbortSignal): Promise<ModelAttemptRecord | undefined> {
    this.assertOpen();
    throwIfAborted(signal);
    return this.records.get(identifier(attemptId, "Model attempt id"));
  }

  async list(
    input: ListModelAttemptsInput = {},
    signal?: AbortSignal,
  ): Promise<readonly ModelAttemptRecord[]> {
    this.assertOpen();
    throwIfAborted(signal);
    const filter = snapshotFilter(input);
    return Object.freeze([...this.records.values()].filter((record) =>
      (filter.sessionId === undefined || record.sessionId === filter.sessionId) &&
      (filter.runId === undefined || record.runId === filter.runId) &&
      (filter.userTurnId === undefined || record.userTurnId === filter.userTurnId) &&
      (filter.stepId === undefined || record.stepId === filter.stepId) &&
      (filter.status === undefined || record.status === filter.status)
    ));
  }

  async recoverInterrupted(endedAt: string, signal?: AbortSignal): Promise<number> {
    const running = await this.list({ status: "running" }, signal);
    for (const record of running) {
      await this.finish({
        attemptId: record.attemptId,
        status: "interrupted",
        endedAt,
        error: { code: "unknown", message: "Model attempt was interrupted", retryable: false },
      }, signal);
    }
    return running.length;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Model attempt ledger is closed");
  }
}

function decodeEvent(bytes: Uint8Array): AttemptEvent {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new TypeError("Model attempt event schemaVersion is invalid");
  }
  if (value.kind === "started") {
    return Object.freeze({ schemaVersion: 1, kind: "started", ...snapshotStart(value as unknown as ModelAttemptStart) });
  }
  if (value.kind === "finished") {
    return Object.freeze({ schemaVersion: 1, kind: "finished", ...snapshotFinish(value as unknown as ModelAttemptFinish) });
  }
  throw new TypeError("Model attempt event kind is invalid");
}

function snapshotStart(input: ModelAttemptStart): ModelAttemptStart {
  if (!isRecord(input)) throw new TypeError("Model attempt start must be an object");
  return Object.freeze({
    attemptId: identifier(input.attemptId, "Model attempt id"),
    sessionId: identifier(input.sessionId, "Model attempt Session id"),
    runId: identifier(input.runId, "Model attempt Run id"),
    userTurnId: identifier(input.userTurnId, "Model attempt UserTurn id"),
    stepId: identifier(input.stepId, "Model attempt Step id"),
    requestedAt: isoTimestamp(input.requestedAt, "Model attempt requestedAt"),
    requestedModel: modelRef(input.requestedModel, "requested Model"),
  });
}

function snapshotFinish(input: ModelAttemptFinish): ModelAttemptFinish {
  if (!isRecord(input)) throw new TypeError("Model attempt finish must be an object");
  const status = terminalStatus(input.status);
  const billedModel = input.billedModel === undefined
    ? undefined
    : modelRef(input.billedModel, "billed Model");
  const usage = input.usage === undefined ? undefined : modelUsage(input.usage);
  const quote = input.quote === undefined ? undefined : priceQuote(input.quote);
  const cost = input.cost === undefined ? undefined : modelCost(input.cost);
  const error = input.error === undefined ? undefined : modelError(input.error);
  if (status === "completed" && error !== undefined) {
    throw new TypeError("Completed Model attempt cannot contain an error");
  }
  if (status !== "completed" && error === undefined) {
    throw new TypeError("Non-completed Model attempt requires an error");
  }
  return Object.freeze({
    attemptId: identifier(input.attemptId, "Model attempt id"),
    status,
    endedAt: isoTimestamp(input.endedAt, "Model attempt endedAt"),
    ...(billedModel === undefined ? {} : { billedModel }),
    ...(usage === undefined ? {} : { usage }),
    ...(quote === undefined ? {} : { quote }),
    ...(cost === undefined ? {} : { cost }),
    ...(error === undefined ? {} : { error }),
  });
}

function snapshotFilter(input: ListModelAttemptsInput): ListModelAttemptsInput {
  if (!isRecord(input)) throw new TypeError("Model attempt filter must be an object");
  return Object.freeze({
    ...(input.sessionId === undefined ? {} : { sessionId: identifier(input.sessionId, "Session id") }),
    ...(input.runId === undefined ? {} : { runId: identifier(input.runId, "Run id") }),
    ...(input.userTurnId === undefined ? {} : { userTurnId: identifier(input.userTurnId, "UserTurn id") }),
    ...(input.stepId === undefined ? {} : { stepId: identifier(input.stepId, "Step id") }),
    ...(input.status === undefined ? {} : { status: attemptStatus(input.status) }),
  });
}

function modelRef(value: unknown, label: string): ModelRef {
  if (!isRecord(value)) throw new TypeError(`Model attempt ${label} is invalid`);
  return Object.freeze({
    provider: identifier(value.provider, `${label} Provider`),
    model: identifier(value.model, `${label} name`),
  });
}

function modelUsage(value: unknown): ModelUsage {
  if (!isRecord(value)) throw new TypeError("Model attempt usage is invalid");
  const source = value.source;
  if (source !== "provider" && source !== "estimated" && source !== "mixed") {
    throw new TypeError("Model attempt usage source is invalid");
  }
  return Object.freeze({
    inputTokens: tokenCount(value.inputTokens, "inputTokens"),
    ...(value.cachedInputTokens === undefined ? {} : { cachedInputTokens: tokenCount(value.cachedInputTokens, "cachedInputTokens") }),
    ...(value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: tokenCount(value.cacheWriteInputTokens, "cacheWriteInputTokens") }),
    outputTokens: tokenCount(value.outputTokens, "outputTokens"),
    totalTokens: tokenCount(value.totalTokens, "totalTokens"),
    source,
    ...(value.estimationMethod === undefined ? {} : { estimationMethod: identifier(value.estimationMethod, "usage estimation method") }),
  });
}

function priceQuote(value: unknown): ModelPriceQuote {
  if (!isRecord(value)) throw new TypeError("Model attempt price quote is invalid");
  const timeBasis = value.timeBasis;
  if (timeBasis !== "provider_created" && timeBasis !== "request_started") {
    throw new TypeError("Model attempt price time basis is invalid");
  }
  const effectiveFrom = value.effectiveFrom === undefined
    ? undefined
    : isoTimestamp(value.effectiveFrom, "price effectiveFrom");
  const effectiveTo = value.effectiveTo === undefined
    ? undefined
    : isoTimestamp(value.effectiveTo, "price effectiveTo");
  const pricedAt = isoTimestamp(value.pricedAt, "price pricedAt");
  if (
    effectiveFrom !== undefined && effectiveTo !== undefined &&
    Date.parse(effectiveTo) <= Date.parse(effectiveFrom)
  ) {
    throw new TypeError("Model attempt price effectiveTo must be after effectiveFrom");
  }
  if (effectiveFrom !== undefined && Date.parse(pricedAt) < Date.parse(effectiveFrom)) {
    throw new TypeError("Model attempt price pricedAt must not precede effectiveFrom");
  }
  if (effectiveTo !== undefined && Date.parse(pricedAt) >= Date.parse(effectiveTo)) {
    throw new TypeError("Model attempt price pricedAt must precede effectiveTo");
  }
  return Object.freeze({
    version: identifier(value.version, "price version"),
    currency: currency(value.currency),
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveTo === undefined ? {} : { effectiveTo }),
    inputPerMillionTokens: nonNegativeNumber(value.inputPerMillionTokens, "input price"),
    ...(value.cachedInputPerMillionTokens === undefined ? {} : { cachedInputPerMillionTokens: nonNegativeNumber(value.cachedInputPerMillionTokens, "cached input price") }),
    ...(value.cacheWriteInputPerMillionTokens === undefined ? {} : { cacheWriteInputPerMillionTokens: nonNegativeNumber(value.cacheWriteInputPerMillionTokens, "cache write price") }),
    outputPerMillionTokens: nonNegativeNumber(value.outputPerMillionTokens, "output price"),
    requestedModel: modelRef(value.requestedModel, "quote requested Model"),
    billedModel: modelRef(value.billedModel, "quote billed Model"),
    period: identifier(value.period, "price period"),
    pricedAt,
    timeBasis,
  });
}

function modelCost(value: unknown): ModelCost {
  if (!isRecord(value)) throw new TypeError("Model attempt cost is invalid");
  const model = modelRef(value.model, "cost Model");
  if (value.status === "unavailable") {
    return Object.freeze({
      status: "unavailable" as const,
      model,
      reason: unavailableReason(value.reason),
      estimated: boolean(value.estimated, "cost estimated"),
    });
  }
  if (value.status !== "available") {
    throw new TypeError("Model attempt cost status is invalid");
  }
  const priceTimeBasis = value.priceTimeBasis === undefined
    ? undefined
    : modelPriceTimeBasis(value.priceTimeBasis, "cost priceTimeBasis");
  return Object.freeze({
    status: "available" as const,
    model,
    currency: currency(value.currency),
    priceVersion: identifier(value.priceVersion, "cost priceVersion"),
    ...(value.effectiveFrom === undefined ? {} : {
      effectiveFrom: isoTimestamp(value.effectiveFrom, "cost effectiveFrom"),
    }),
    ...(value.effectiveTo === undefined ? {} : {
      effectiveTo: isoTimestamp(value.effectiveTo, "cost effectiveTo"),
    }),
    ...(value.billedModel === undefined ? {} : {
      billedModel: modelRef(value.billedModel, "cost billed Model"),
    }),
    ...(value.pricePeriod === undefined ? {} : {
      pricePeriod: identifier(value.pricePeriod, "cost pricePeriod"),
    }),
    ...(value.pricedAt === undefined ? {} : {
      pricedAt: isoTimestamp(value.pricedAt, "cost pricedAt"),
    }),
    ...(priceTimeBasis === undefined ? {} : { priceTimeBasis }),
    uncachedInputCost: nonNegativeNumber(value.uncachedInputCost, "uncached input cost"),
    cachedInputCost: nonNegativeNumber(value.cachedInputCost, "cached input cost"),
    cacheWriteInputCost: nonNegativeNumber(value.cacheWriteInputCost, "cache write input cost"),
    outputCost: nonNegativeNumber(value.outputCost, "output cost"),
    totalCost: nonNegativeNumber(value.totalCost, "total cost"),
    cacheSavings: finiteNumber(value.cacheSavings, "cache savings"),
    estimated: boolean(value.estimated, "cost estimated"),
  });
}

function modelError(value: unknown): ModelError {
  if (!isRecord(value)) throw new TypeError("Model attempt error is invalid");
  if (typeof value.message !== "string" || typeof value.retryable !== "boolean") {
    throw new TypeError("Model attempt error fields are invalid");
  }
  return Object.freeze({
    code: modelErrorCode(value.code),
    message: value.message,
    retryable: value.retryable,
    ...(value.status === undefined ? {} : { status: tokenCount(value.status, "error status") }),
  });
}

function validateTerminalRecord(record: ModelAttemptRecord): ModelAttemptRecord {
  if (record.status === "running") return record;
  if (
    record.quote !== undefined &&
    !sameModel(record.quote.requestedModel, record.requestedModel)
  ) {
    throw new TypeError("Model attempt quote requested Model does not match the attempt");
  }
  if (record.cost !== undefined && record.usage === undefined) {
    throw new TypeError("Model attempt cost requires usage");
  }
  if (record.usage !== undefined) {
    if (record.cost === undefined) {
      throw new TypeError("Model attempt usage requires a cost result");
    }
    const expected = calculateModelCost({
      model: record.requestedModel,
      usage: record.usage,
      ...(record.quote === undefined ? {} : { price: record.quote }),
    });
    if (JSON.stringify(expected) !== JSON.stringify(record.cost)) {
      throw new TypeError("Model attempt cost does not match usage and quote");
    }
  }
  return record;
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function modelErrorCode(value: unknown): ModelError["code"] {
  if (
    value === "missing_api_key" || value === "invalid_request" ||
    value === "http_error" || value === "provider_error" ||
    value === "stream_parse_error" || value === "context_overflow" ||
    value === "aborted" || value === "network_error" || value === "unknown"
  ) return value;
  throw new TypeError("Model attempt error code is invalid");
}

function unavailableReason(value: unknown): ModelCostUnavailableReason {
  if (
    value === "price_unavailable" || value === "price_model_mismatch" ||
    value === "cached_usage_unknown" || value === "cache_write_usage_unknown" ||
    value === "cached_price_unavailable" || value === "cache_write_price_unavailable" ||
    value === "inconsistent_usage"
  ) return value;
  throw new TypeError("Model attempt cost unavailable reason is invalid");
}

function modelPriceTimeBasis(
  value: unknown,
  label: string,
): "provider_created" | "request_started" {
  if (value === "provider_created" || value === "request_started") return value;
  throw new TypeError(`Model attempt ${label} is invalid`);
}

function terminalStatus(value: unknown): Exclude<ModelAttemptStatus, "running"> {
  if (value === "completed" || value === "failed" || value === "aborted" || value === "interrupted") return value;
  throw new TypeError("Model attempt terminal status is invalid");
}

function attemptStatus(value: unknown): ModelAttemptStatus {
  return value === "running" ? value : terminalStatus(value);
}

function tokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Model attempt ${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Model attempt ${label} must be a non-negative number`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Model attempt ${label} must be a finite number`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`Model attempt ${label} must be boolean`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function currency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)) {
    throw new TypeError("Model attempt currency is invalid");
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error("Model attempt operation aborted");
}

function corruption(
  message: string,
  cause?: unknown,
  backendId?: string,
): StorageCorruptionError {
  return new StorageCorruptionError(message, {
    ...(backendId === undefined ? {} : { backendId }),
    facet: "journal",
    namespace: MODEL_ATTEMPT_JOURNAL_NAMESPACE,
  }, cause === undefined ? undefined : { cause });
}
