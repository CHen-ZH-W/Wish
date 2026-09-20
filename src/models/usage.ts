import type {
  Model,
  ModelOutput,
  ModelRef,
  ModelRequest,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
} from "../core/model/model.js";
import type { ModelPrice } from "./types.js";
import type { ModelPriceQuote, ModelPriceTimeBasis } from "./pricing.js";

export interface ModelTokenizerInput {
  readonly request: ModelRequest;
  readonly output: ModelOutput;
}

export interface ModelTokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A tokenizer is registered for one exact provider/model identity. */
export interface ModelTokenizer {
  readonly method: string;
  count(
    input: ModelTokenizerInput,
  ): Promise<ModelTokenCounts> | ModelTokenCounts;
}

export interface UsageEstimationInput {
  readonly request: ModelRequest;
  readonly output: ModelOutput;
  readonly signal?: AbortSignal;
}

export interface UsageEstimator {
  estimate(
    input: UsageEstimationInput,
  ): Promise<ModelUsage | undefined> | ModelUsage | undefined;
}

export class TokenizerUsageEstimator implements UsageEstimator {
  private readonly tokenizers = new Map<string, ModelTokenizer>();

  register(model: ModelRef, tokenizer: ModelTokenizer): void {
    const key = modelKey(model);
    if (
      typeof tokenizer.method !== "string" || tokenizer.method.length === 0 ||
      tokenizer.method !== tokenizer.method.trim()
    ) {
      throw new Error("Model tokenizer method must be a non-empty trimmed string");
    }
    if (typeof tokenizer.count !== "function") {
      throw new Error("Model tokenizer count must be a function");
    }
    if (this.tokenizers.has(key)) {
      throw new Error(`Tokenizer for ${displayModel(model)} is already registered`);
    }
    this.tokenizers.set(key, tokenizer);
  }

  has(model: ModelRef): boolean {
    return this.tokenizers.has(modelKey(model));
  }

  async estimate(input: UsageEstimationInput): Promise<ModelUsage | undefined> {
    const tokenizer = this.tokenizers.get(modelKey(input.output.model)) ??
      this.tokenizers.get(modelKey(input.request.model));
    if (tokenizer === undefined || input.signal?.aborted === true) return undefined;
    const counts = await tokenizer.count(Object.freeze({
      request: input.request,
      output: input.output,
    }));
    requireTokenCount(counts.inputTokens, "estimated inputTokens");
    requireTokenCount(counts.outputTokens, "estimated outputTokens");
    return Object.freeze({
      inputTokens: counts.inputTokens,
      outputTokens: counts.outputTokens,
      totalTokens: counts.inputTokens + counts.outputTokens,
      source: "estimated" as const,
      estimationMethod: tokenizer.method,
    });
  }
}

/** Adds usage only to successful done events that do not already contain it. */
export class UsageResolvingModel implements Model {
  constructor(
    private readonly delegate: Model,
    private readonly estimator: UsageEstimator,
  ) {}

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const stableRequest = snapshotRequest(request);
    let actualModel: ModelRef | undefined;
    let reasoning = "";
    let text = "";
    let toolCalls: ModelToolCall[] = [];
    let developerRoleMode: ModelOutput["developerRoleMode"];
    let authorityDegraded: boolean | undefined;
    for await (const event of this.delegate.stream(stableRequest, signal)) {
      switch (event.type) {
        case "start":
          actualModel = freezeModelRef(event.model);
          developerRoleMode = event.developerRoleMode;
          authorityDegraded = event.authorityDegraded;
          reasoning = "";
          text = "";
          toolCalls = [];
          yield event;
          break;
        case "retry":
          actualModel = undefined;
          developerRoleMode = undefined;
          authorityDegraded = undefined;
          reasoning = "";
          text = "";
          toolCalls = [];
          yield event;
          break;
        case "reasoning_delta":
          reasoning += event.text;
          yield event;
          break;
        case "text_delta":
          text += event.text;
          yield event;
          break;
        case "tool_call":
          toolCalls.push(freezeToolCall(event.call));
          yield event;
          break;
        case "done": {
          if (event.usage !== undefined || actualModel === undefined) {
            yield event;
            break;
          }
          let usage: ModelUsage | undefined;
          try {
            usage = await this.estimator.estimate(Object.freeze({
              request: stableRequest,
              output: Object.freeze({
                model: actualModel,
                reasoning,
                text,
                toolCalls: Object.freeze(toolCalls),
                ...(event.finishReason === undefined
                  ? {}
                  : { finishReason: event.finishReason }),
                ...(developerRoleMode === undefined
                  ? {}
                  : { developerRoleMode }),
                ...(authorityDegraded === undefined
                  ? {}
                  : { authorityDegraded }),
              }),
              ...(signal === undefined ? {} : { signal }),
            }));
            if (usage !== undefined) usage = snapshotUsage(usage);
          } catch {
            usage = undefined;
          }
          yield Object.freeze({
            type: "done" as const,
            ...(event.finishReason === undefined
              ? {}
              : { finishReason: event.finishReason }),
            ...(usage === undefined ? {} : { usage }),
            ...(event.providerCreatedAt === undefined
              ? {}
              : { providerCreatedAt: event.providerCreatedAt }),
          });
          break;
        }
        case "error":
          yield event;
          break;
      }
    }
  }
}

export type ModelCostUnavailableReason =
  | "price_unavailable"
  | "price_model_mismatch"
  | "cached_usage_unknown"
  | "cache_write_usage_unknown"
  | "cached_price_unavailable"
  | "cache_write_price_unavailable"
  | "inconsistent_usage";

export interface AvailableModelCost {
  readonly status: "available";
  readonly model: ModelRef;
  readonly currency: string;
  readonly priceVersion: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string;
  readonly billedModel?: ModelRef;
  readonly pricePeriod?: string;
  readonly pricedAt?: string;
  readonly priceTimeBasis?: ModelPriceTimeBasis;
  readonly uncachedInputCost: number;
  readonly cachedInputCost: number;
  readonly cacheWriteInputCost: number;
  readonly outputCost: number;
  readonly totalCost: number;
  readonly cacheSavings: number;
  readonly estimated: boolean;
}

export interface UnavailableModelCost {
  readonly status: "unavailable";
  readonly model: ModelRef;
  readonly reason: ModelCostUnavailableReason;
  readonly estimated: boolean;
}

export type ModelCost = AvailableModelCost | UnavailableModelCost;

export function calculateModelCost(input: {
  readonly model: ModelRef;
  readonly usage: ModelUsage;
  readonly price?: ModelPrice | ModelPriceQuote;
}): ModelCost {
  const model = freezeModelRef(input.model);
  const estimated = input.usage.source !== "provider";
  const price = input.price;
  if (price === undefined) return unavailableCost(model, estimated, "price_unavailable");
  if (
    isPriceQuote(price) &&
    (price.requestedModel.provider !== model.provider || price.requestedModel.model !== model.model)
  ) {
    return unavailableCost(model, estimated, "price_model_mismatch");
  }

  const cached = input.usage.cachedInputTokens;
  if (cached === undefined && price.cachedInputPerMillionTokens !== undefined) {
    return unavailableCost(model, estimated, "cached_usage_unknown");
  }
  if (
    cached !== undefined && cached > 0 &&
    price.cachedInputPerMillionTokens === undefined
  ) {
    return unavailableCost(model, estimated, "cached_price_unavailable");
  }
  const cacheWrite = input.usage.cacheWriteInputTokens;
  if (cacheWrite === undefined && price.cacheWriteInputPerMillionTokens !== undefined) {
    return unavailableCost(model, estimated, "cache_write_usage_unknown");
  }
  if (
    cacheWrite !== undefined && cacheWrite > 0 &&
    price.cacheWriteInputPerMillionTokens === undefined
  ) {
    return unavailableCost(model, estimated, "cache_write_price_unavailable");
  }
  const categorizedInput = (cached ?? 0) + (cacheWrite ?? 0);
  if (categorizedInput > input.usage.inputTokens) {
    return unavailableCost(model, estimated, "inconsistent_usage");
  }

  const uncachedInputTokens = input.usage.inputTokens - categorizedInput;
  const uncachedInputCost = tokenCost(
    uncachedInputTokens,
    price.inputPerMillionTokens,
  );
  const cachedInputCost = tokenCost(
    cached ?? 0,
    price.cachedInputPerMillionTokens ?? price.inputPerMillionTokens,
  );
  const cacheWriteInputCost = tokenCost(
    cacheWrite ?? 0,
    price.cacheWriteInputPerMillionTokens ?? price.inputPerMillionTokens,
  );
  const outputCost = tokenCost(
    input.usage.outputTokens,
    price.outputPerMillionTokens,
  );
  const totalCost = uncachedInputCost + cachedInputCost +
    cacheWriteInputCost + outputCost;
  const cacheSavings = cached === undefined
    ? 0
    : tokenCost(
      cached,
      price.inputPerMillionTokens -
        (price.cachedInputPerMillionTokens ?? price.inputPerMillionTokens),
    );
  return Object.freeze({
    status: "available" as const,
    model,
    currency: price.currency,
    priceVersion: price.version,
    ...(price.effectiveFrom === undefined
      ? {}
      : { effectiveFrom: price.effectiveFrom }),
    ...(!isPriceQuote(price) || price.effectiveTo === undefined
      ? {}
      : { effectiveTo: price.effectiveTo }),
    ...(!isPriceQuote(price)
      ? {}
      : {
        billedModel: freezeModelRef(price.billedModel),
        pricePeriod: price.period,
        pricedAt: price.pricedAt,
        priceTimeBasis: price.timeBasis,
      }),
    uncachedInputCost,
    cachedInputCost,
    cacheWriteInputCost,
    outputCost,
    totalCost,
    cacheSavings,
    estimated,
  });
}

function isPriceQuote(price: ModelPrice | ModelPriceQuote): price is ModelPriceQuote {
  return "requestedModel" in price && "billedModel" in price &&
    "period" in price && "pricedAt" in price && "timeBasis" in price;
}

function unavailableCost(
  model: ModelRef,
  estimated: boolean,
  reason: ModelCostUnavailableReason,
): UnavailableModelCost {
  return Object.freeze({ status: "unavailable" as const, model, reason, estimated });
}

function tokenCost(tokens: number, pricePerMillion: number): number {
  return (tokens * pricePerMillion) / 1_000_000;
}

function snapshotRequest(request: ModelRequest): ModelRequest {
  return Object.freeze({
    model: freezeModelRef(request.model),
    instructions: Object.freeze(request.instructions.map((instruction) =>
      Object.freeze({ role: instruction.role, content: instruction.content })
    )),
    messages: Object.freeze(request.messages.map((message) => Object.freeze({
      role: message.role,
      content: message.content,
      ...(message.contentParts === undefined
        ? {}
        : {
          contentParts: Object.freeze(message.contentParts.map((part) =>
            part.type === "text"
              ? Object.freeze({ type: "text" as const, text: part.text })
              : Object.freeze({
                type: "image_url" as const,
                imageUrl: Object.freeze({ ...part.imageUrl }),
              })
          )),
        }),
      ...(message.toolCallId === undefined
        ? {}
        : { toolCallId: message.toolCallId }),
      ...(message.toolCalls === undefined
        ? {}
        : {
          toolCalls: Object.freeze(message.toolCalls.map((call) =>
            Object.freeze({ ...call })
          )),
        }),
      ...(message.reasoningContent === undefined
        ? {}
        : { reasoningContent: message.reasoningContent }),
    }))),
    tools: Object.freeze(request.tools.map((tool) => Object.freeze({ ...tool }))),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.metadata === undefined
      ? {}
      : { metadata: snapshotPlainRecord(request.metadata) }),
    ...(request.invocationScope === undefined
      ? {}
      : { invocationScope: Object.freeze({ ...request.invocationScope }) }),
  });
}

function snapshotUsage(usage: ModelUsage): ModelUsage {
  requireTokenCount(usage.inputTokens, "usage inputTokens");
  if (usage.cachedInputTokens !== undefined) {
    requireTokenCount(usage.cachedInputTokens, "usage cachedInputTokens");
  }
  if (usage.cacheWriteInputTokens !== undefined) {
    requireTokenCount(usage.cacheWriteInputTokens, "usage cacheWriteInputTokens");
  }
  requireTokenCount(usage.outputTokens, "usage outputTokens");
  requireTokenCount(usage.totalTokens, "usage totalTokens");
  if (
    usage.source !== "provider" && usage.source !== "estimated" &&
    usage.source !== "mixed"
  ) throw new Error("Usage source is invalid");
  return Object.freeze({ ...usage });
}

function snapshotPlainRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, snapshotPlainValue(item)]),
  ));
}

function snapshotPlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotPlainValue));
  if (isPlainRecord(value)) return snapshotPlainRecord(value);
  return value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeToolCall(call: ModelToolCall): ModelToolCall {
  return Object.freeze({ ...call });
}

function freezeModelRef(model: ModelRef): ModelRef {
  return Object.freeze({ provider: model.provider, model: model.model });
}

function modelKey(model: ModelRef): string {
  return `${model.provider}\u0000${model.model}`;
}

function displayModel(model: ModelRef): string {
  return `${model.provider}/${model.model}`;
}

function requireTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}
