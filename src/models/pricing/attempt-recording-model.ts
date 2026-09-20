import { randomUUID } from "node:crypto";

import type {
  Model,
  ModelError,
  ModelRef,
  ModelRequest,
  ModelStreamEvent,
} from "../../core/model/model.js";
import type { ModelPriceQuote, ModelPriceQuoteRequest } from "../pricing.js";
import { calculateModelCost } from "../usage.js";
import type { ModelAttemptLedger, ModelAttemptStatus } from "./attempts.js";

export interface ModelAttemptRecordingOptions {
  readonly ledger: ModelAttemptLedger;
  readonly currency: string;
  readonly quote: (
    model: ModelRef,
    request: ModelPriceQuoteRequest,
  ) => ModelPriceQuote | undefined;
  readonly now?: () => number;
  readonly attemptId?: () => string;
}

/** Records one durable entry for every delegate call made by RetryingModel. */
export class AttemptRecordingModel implements Model {
  private readonly currency: string;
  private readonly now: () => number;
  private readonly attemptId: () => string;

  constructor(
    private readonly delegate: Model,
    private readonly options: ModelAttemptRecordingOptions,
  ) {
    this.currency = requireCurrency(options.currency);
    this.now = options.now ?? Date.now;
    this.attemptId = options.attemptId ?? randomUUID;
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const scope = request.invocationScope;
    if (scope === undefined) {
      yield* this.delegate.stream(request, signal);
      return;
    }

    const attemptId = requireIdentifier(this.attemptId(), "Model attempt id");
    const requestedAt = epochMilliseconds(this.now(), "Model attempt requestedAt");
    await this.options.ledger.start({
      attemptId,
      ...scope,
      requestedAt: new Date(requestedAt).toISOString(),
      requestedModel: request.model,
    }, signal);

    let billedModel: ModelRef | undefined;
    let terminalWriteStarted = false;
    try {
      for await (const event of this.delegate.stream(request, signal)) {
        if (event.type === "start") billedModel = event.model;
        if (event.type === "done") {
          const quote = this.options.quote(request.model, {
            requestedAt,
            currency: this.currency,
            ...(billedModel === undefined ? {} : { billedModel }),
            ...(event.providerCreatedAt === undefined
              ? {}
              : { providerCreatedAt: event.providerCreatedAt }),
          });
          const cost = event.usage === undefined
            ? undefined
            : calculateModelCost({
                model: request.model,
                usage: event.usage,
                ...(quote === undefined ? {} : { price: quote }),
              });
          terminalWriteStarted = true;
          await this.options.ledger.finish({
            attemptId,
            status: "completed",
            endedAt: new Date(epochMilliseconds(this.now(), "Model attempt endedAt")).toISOString(),
            ...(billedModel === undefined ? {} : { billedModel }),
            ...(event.usage === undefined ? {} : { usage: event.usage }),
            ...(quote === undefined ? {} : { quote }),
            ...(cost === undefined ? {} : { cost }),
          });
          yield event;
          return;
        }
        if (event.type === "error") {
          terminalWriteStarted = true;
          await this.finishFailure(
            attemptId,
            signal?.aborted === true || event.error.code === "aborted"
              ? "aborted"
              : "failed",
            event.error,
            billedModel,
            undefined,
          );
          yield event;
          return;
        }
        yield event;
      }

      terminalWriteStarted = true;
      await this.finishFailure(
        attemptId,
        signal?.aborted === true ? "aborted" : "failed",
        operationalError(
          new Error("Model attempt ended without a terminal event"),
          signal,
        ),
        billedModel,
        undefined,
      );
    } catch (error: unknown) {
      if (!terminalWriteStarted) {
        terminalWriteStarted = true;
        await this.finishFailure(
          attemptId,
          signal?.aborted === true ? "aborted" : "failed",
          operationalError(error, signal),
          billedModel,
          undefined,
        );
      }
      throw error;
    } finally {
      if (!terminalWriteStarted) {
        terminalWriteStarted = true;
        await this.finishFailure(attemptId, "interrupted", {
          code: "unknown",
          message: "Model attempt consumer stopped before a terminal event",
          retryable: false,
        }, billedModel, undefined);
      }
    }
  }

  private async finishFailure(
    attemptId: string,
    status: Exclude<ModelAttemptStatus, "running" | "completed">,
    error: ModelError,
    billedModel: ModelRef | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.options.ledger.finish({
      attemptId,
      status,
      endedAt: new Date(epochMilliseconds(this.now(), "Model attempt endedAt")).toISOString(),
      ...(billedModel === undefined ? {} : { billedModel }),
      error,
    }, signal);
  }
}

function operationalError(
  error: unknown,
  signal: AbortSignal | undefined,
): ModelError {
  if (signal?.aborted === true) {
    return Object.freeze({
      code: "aborted",
      message: signal.reason instanceof Error
        ? signal.reason.message
        : "Model attempt was aborted",
      retryable: false,
    });
  }
  return Object.freeze({
    code: "unknown",
    message: error instanceof Error ? error.message : "Model attempt failed",
    retryable: false,
  });
}

function requireCurrency(value: string): string {
  if (!/^[A-Z]{3}$/u.test(value)) {
    throw new TypeError("Model attempt currency must be a three-letter uppercase code");
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function epochMilliseconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be non-negative epoch milliseconds`);
  }
  return value;
}
