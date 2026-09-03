import type {
  ContextBudgetAssessment,
  ContextBudgetEvaluationInput,
  ContextBudgetEvaluator,
} from "../../core/context/projector.js";
import type {
  ModelContextWindowSource,
  ModelInputTokenCount,
  ModelInputTokenCounter,
} from "../types.js";

export type ContextBudgetUnknownReason =
  | "context_window_unavailable"
  | "input_token_count_unavailable";

export interface ModelContextBudgetEvaluatorOptions {
  readonly models: ModelContextWindowSource;
  readonly counter: ModelInputTokenCounter;
  readonly reservedOutputTokens: number;
}

/** Evaluates only the final projected request and never mutates or compacts it. */
export class ModelContextBudgetEvaluator implements ContextBudgetEvaluator {
  readonly reservedOutputTokens: number;

  constructor(private readonly options: ModelContextBudgetEvaluatorOptions) {
    this.reservedOutputTokens = nonNegativeSafeInteger(
      options.reservedOutputTokens,
      "Context reservedOutputTokens",
    );
  }

  async assess(
    input: ContextBudgetEvaluationInput,
  ): Promise<ContextBudgetAssessment> {
    throwIfAborted(input.signal);
    const contextWindowTokens = await this.options.models.getContextWindowTokens(
      input.request.model,
      input.signal,
    );
    throwIfAborted(input.signal);
    if (contextWindowTokens === undefined) {
      return unknownAssessment(
        "context_window_unavailable",
        this.reservedOutputTokens,
      );
    }
    positiveSafeInteger(contextWindowTokens, "Model contextWindowTokens");
    if (this.reservedOutputTokens >= contextWindowTokens) {
      throw new Error(
        "Context reservedOutputTokens must be less than contextWindowTokens",
      );
    }
    const inputLimitTokens = contextWindowTokens - this.reservedOutputTokens;
    const count = await this.options.counter.count({
      request: input.request,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    throwIfAborted(input.signal);
    if (count === undefined) {
      return unknownAssessment(
        "input_token_count_unavailable",
        this.reservedOutputTokens,
        contextWindowTokens,
        inputLimitTokens,
      );
    }
    const normalized = validateCount(count);
    const remainingInputTokens = inputLimitTokens - normalized.inputTokens;
    return Object.freeze({
      status: remainingInputTokens < 0
        ? "over_budget" as const
        : "within_budget" as const,
      estimatedInputTokens: normalized.inputTokens,
      inputLimitTokens,
      details: Object.freeze({
        contextWindowTokens,
        reservedOutputTokens: this.reservedOutputTokens,
        remainingInputTokens,
        countMethod: normalized.method,
      }),
    });
  }
}

function unknownAssessment(
  reason: ContextBudgetUnknownReason,
  reservedOutputTokens: number,
  contextWindowTokens?: number,
  inputLimitTokens?: number,
): ContextBudgetAssessment {
  return Object.freeze({
    status: "unknown" as const,
    ...(inputLimitTokens === undefined ? {} : { inputLimitTokens }),
    details: Object.freeze({
      reason,
      reservedOutputTokens,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    }),
  });
}

function validateCount(count: ModelInputTokenCount): ModelInputTokenCount {
  if (count === null || typeof count !== "object") {
    throw new Error("ModelInputTokenCounter must return a token count");
  }
  const inputTokens = nonNegativeSafeInteger(
    count.inputTokens,
    "Model inputTokens",
  );
  const method = requireIdentifier(count.method, "Model token count method");
  return Object.freeze({ inputTokens, method });
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Context budget evaluation was aborted", {
    cause: signal.reason,
  });
}
