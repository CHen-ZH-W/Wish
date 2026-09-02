import type {
  ModelError,
  ModelRef,
  ModelRequest,
  ModelStreamEvent,
} from "./types.js";

export type {
  DeveloperRoleMode,
  ModelError,
  ModelErrorCode,
  ModelMessage,
  ModelMessageContentPart,
  ModelMessageToolCall,
  ModelMetadata,
  ModelOutput,
  ModelRef,
  ModelRequest,
  ModelRole,
  ModelStreamEvent,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  ModelUsageSource,
} from "./types.js";

/** Provider-neutral streaming model Port. */
export interface Model {
  stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>;
}

export interface RetryingModelOptions {
  /** Retries for each model after its initial attempt. */
  readonly maxRetries?: number;
  /** Ordered candidates used only when the current model may safely switch. */
  readonly fallbackModels?: readonly ModelRef[];
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** Injectable source used to make jitter deterministic in tests. */
  readonly random?: () => number;
}

/**
 * Provider-neutral resilience decorator.
 *
 * It may retry or switch only before any reasoning, text, or tool call has
 * escaped. This prevents replaying a partially observed response.
 */
export class RetryingModel implements Model {
  private readonly maxRetries: number;
  private readonly fallbackModels: readonly ModelRef[];
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly random: () => number;

  constructor(
    private readonly delegate: Model,
    options: RetryingModelOptions = {},
  ) {
    this.maxRetries = nonNegativeInteger(options.maxRetries, 2, "maxRetries");
    this.fallbackModels = options.fallbackModels ?? [];
    this.baseRetryDelayMs = positiveInteger(
      options.baseRetryDelayMs,
      500,
      "baseRetryDelayMs",
    );
    this.maxRetryDelayMs = positiveInteger(
      options.maxRetryDelayMs,
      8_000,
      "maxRetryDelayMs",
    );
    this.random = options.random ?? Math.random;
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const models = distinctModels(request.model, this.fallbackModels);
    let retryCount = 0;

    if (signal?.aborted === true) {
      yield { type: "error", error: abortedModelError(signal.reason) };
      return;
    }

    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const requestedModel = models[modelIndex];
      if (requestedModel === undefined) {
        continue;
      }

      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        let emittedContent = false;
        let activeModel = requestedModel;
        let failure: ModelError | undefined;

        for await (const event of this.delegate.stream(
          { ...request, model: requestedModel },
          signal,
        )) {
          if (event.type === "error") {
            failure = event.error;
            break;
          }
          if (event.type === "start") {
            activeModel = event.model;
          } else if (isContentEvent(event)) {
            emittedContent = true;
          }
          yield event;
        }

        if (failure === undefined) {
          return;
        }
        if (isAborted(signal) || failure.code === "aborted") {
          yield { type: "error", error: failure };
          return;
        }

        const canRetry =
          !emittedContent &&
          failure.retryable &&
          failure.code !== "context_overflow" &&
          attempt < this.maxRetries;
        const nextModel = models[modelIndex + 1];
        const canFallback =
          !emittedContent &&
          nextModel !== undefined &&
          (failure.retryable || failure.code === "context_overflow");

        if (!canRetry && !canFallback) {
          yield { type: "error", error: failure };
          return;
        }

        retryCount += 1;
        const delayMs = backoffDelay(
          this.baseRetryDelayMs,
          this.maxRetryDelayMs,
          retryCount,
          this.random,
        );
        yield {
          type: "retry",
          error: failure,
          retryCount,
          delayMs,
          fromModel: activeModel,
          ...(canRetry || nextModel === undefined ? {} : { toModel: nextModel }),
        };

        const completedBackoff = await waitForBackoff(delayMs, signal);
        if (!completedBackoff) {
          yield { type: "error", error: abortedModelError(signal?.reason) };
          return;
        }
        if (!canRetry) {
          break;
        }
      }
    }
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isContentEvent(
  event: ModelStreamEvent,
): event is Extract<
  ModelStreamEvent,
  { readonly type: "reasoning_delta" | "text_delta" | "tool_call" }
> {
  return event.type === "reasoning_delta" ||
    event.type === "text_delta" ||
    event.type === "tool_call";
}

function distinctModels(
  primary: ModelRef,
  fallbackModels: readonly ModelRef[],
): readonly ModelRef[] {
  const result: ModelRef[] = [primary];
  for (const fallback of fallbackModels) {
    if (!result.some((candidate) => modelRefEquals(candidate, fallback))) {
      result.push(fallback);
    }
  }
  return result;
}

function modelRefEquals(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function backoffDelay(
  baseMs: number,
  maxMs: number,
  retryCount: number,
  random: () => number,
): number {
  const exponential = Math.min(maxMs, baseMs * (2 ** (retryCount - 1)));
  return Math.max(1, Math.round(exponential * (0.75 + random() * 0.5)));
}

function waitForBackoff(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }

    const abort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortedModelError(reason: unknown): ModelError {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason.length > 0
      ? reason
      : "Model request was aborted";
  return {
    code: "aborted",
    message,
    retryable: false,
  };
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return resolved;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}
