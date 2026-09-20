import type { ModelRef } from "../core/model/model.js";
import type { ModelPrice } from "./types.js";

export type ModelPriceTimeBasis = "provider_created" | "request_started";

/** Immutable rates selected for one exact model request attempt. */
export interface ModelPriceQuote extends ModelPrice {
  readonly requestedModel: ModelRef;
  readonly billedModel: ModelRef;
  readonly period: string;
  readonly pricedAt: string;
  readonly timeBasis: ModelPriceTimeBasis;
  readonly effectiveTo?: string;
}

export interface ModelPriceQuoteRequest {
  /** Host timestamp captured immediately before the Provider request, in epoch milliseconds. */
  readonly requestedAt: number;
  /** Provider response creation timestamp, in epoch milliseconds, when available. */
  readonly providerCreatedAt?: number;
  /** Explicit billing currency. Pricing never performs implicit FX conversion. */
  readonly currency: string;
  /** Actual billed route when it differs from the requested compatibility name. */
  readonly billedModel?: ModelRef;
}

export interface ModelPricingPolicyInput extends ModelPriceQuoteRequest {
  readonly requestedModel: ModelRef;
}

/** Provider-owned dynamic price selection. Token multiplication remains separate. */
export interface ModelPricingPolicy {
  readonly provider: string;
  quote(input: ModelPricingPolicyInput): ModelPriceQuote | undefined;
}

export interface ResolveModelPriceQuoteInput extends ModelPricingPolicyInput {
  /** Static configured price used only when no dynamic Provider quote is available. */
  readonly configuredPrice?: ModelPrice;
}

/** Exact ownership handle for one Provider pricing contribution. */
export interface ModelPricingPolicyRegistration {
  readonly provider: string;
  unregister(): boolean;
}

/** Resolves dynamic Provider policies before falling back to one static model price. */
export class ModelPricingResolver {
  private readonly policies = new Map<string, ModelPricingPolicy>();

  register(policy: ModelPricingPolicy): ModelPricingPolicyRegistration {
    if (policy === null || typeof policy !== "object" || typeof policy.quote !== "function") {
      throw new Error("Model Pricing policy must provide quote()");
    }
    const provider = requireIdentifier(policy.provider, "Model Pricing Provider");
    if (this.policies.has(provider)) {
      throw new Error(`Model Pricing Provider "${provider}" is already registered`);
    }
    this.policies.set(provider, policy);

    let active = true;
    return Object.freeze({
      provider,
      unregister: () => {
        if (!active) return false;
        active = false;
        if (this.policies.get(provider) !== policy) return false;
        this.policies.delete(provider);
        return true;
      },
    });
  }

  resolve(input: ResolveModelPriceQuoteInput): ModelPriceQuote | undefined {
    const stable = snapshotPricingInput(input);
    const policy = this.policies.get(stable.requestedModel.provider);
    const dynamic = policy?.quote(stable);
    if (dynamic !== undefined) return snapshotQuote(dynamic, stable);
    if (stable.configuredPrice === undefined) return undefined;
    return staticQuote(stable, stable.configuredPrice);
  }
}

const DEEPSEEK_PROVIDER = "deepseek";
const DEEPSEEK_FLASH = "deepseek-flash";
const DEEPSEEK_PRO = "deepseek-v4-pro";
/** Reviewed against DeepSeek Pricing and release notices on 2026-09-19. */
const DEEPSEEK_FLASH_PRICE_VERSION = "deepseek-flash:2026-09-10T04:00Z";
const DEEPSEEK_FLASH_EFFECTIVE_FROM = "2026-09-10T04:00:00.000Z";
const DEEPSEEK_PRO_PRICE_VERSION = "deepseek-v4-pro:2026-08-16T16:00Z";
const DEEPSEEK_PRO_EFFECTIVE_FROM = "2026-08-16T16:00:00.000Z";
const LEGACY_DEEPSEEK_FLASH = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

type DeepSeekPeriod = "peak" | "off_peak";
type DeepSeekCurrency = "USD" | "CNY";
type DeepSeekBilledModel = typeof DEEPSEEK_FLASH | typeof DEEPSEEK_PRO;

const DEEPSEEK_RATES: Readonly<
  Record<DeepSeekCurrency, Readonly<Record<DeepSeekBilledModel, Readonly<Record<DeepSeekPeriod, ModelPrice>>>>>
> = Object.freeze({
  USD: Object.freeze({
    [DEEPSEEK_FLASH]: Object.freeze({
      peak: price(
        DEEPSEEK_FLASH_PRICE_VERSION, DEEPSEEK_FLASH_EFFECTIVE_FROM,
        "USD", 0.3, 0.006, 1.2,
      ),
      off_peak: price(
        DEEPSEEK_FLASH_PRICE_VERSION, DEEPSEEK_FLASH_EFFECTIVE_FROM,
        "USD", 0.15, 0.003, 0.6,
      ),
    }),
    [DEEPSEEK_PRO]: Object.freeze({
      peak: price(
        DEEPSEEK_PRO_PRICE_VERSION, DEEPSEEK_PRO_EFFECTIVE_FROM,
        "USD", 1.32, 0.044, 3.96,
      ),
      off_peak: price(
        DEEPSEEK_PRO_PRICE_VERSION, DEEPSEEK_PRO_EFFECTIVE_FROM,
        "USD", 0.66, 0.022, 1.98,
      ),
    }),
  }),
  CNY: Object.freeze({
    [DEEPSEEK_FLASH]: Object.freeze({
      peak: price(
        DEEPSEEK_FLASH_PRICE_VERSION, DEEPSEEK_FLASH_EFFECTIVE_FROM,
        "CNY", 2, 0.04, 8,
      ),
      off_peak: price(
        DEEPSEEK_FLASH_PRICE_VERSION, DEEPSEEK_FLASH_EFFECTIVE_FROM,
        "CNY", 1, 0.02, 4,
      ),
    }),
    [DEEPSEEK_PRO]: Object.freeze({
      peak: price(
        DEEPSEEK_PRO_PRICE_VERSION, DEEPSEEK_PRO_EFFECTIVE_FROM,
        "CNY", 9, 0.3, 27,
      ),
      off_peak: price(
        DEEPSEEK_PRO_PRICE_VERSION, DEEPSEEK_PRO_EFFECTIVE_FROM,
        "CNY", 4.5, 0.15, 13.5,
      ),
    }),
  }),
});

/** Current official DeepSeek schedule: shared UTC windows with per-model rates. */
export class DeepSeekPricingPolicy implements ModelPricingPolicy {
  readonly provider = DEEPSEEK_PROVIDER;

  quote(input: ModelPricingPolicyInput): ModelPriceQuote | undefined {
    if (input.requestedModel.provider !== this.provider) return undefined;
    const instant = pricingInstant(input);
    const currency = deepSeekCurrency(input.currency);
    if (currency === undefined) return undefined;

    const billedReference = input.billedModel ?? input.requestedModel;
    if (billedReference.provider !== this.provider) return undefined;
    const billedModel = canonicalDeepSeekModel(billedReference.model);
    if (billedModel === undefined) return undefined;
    const period = deepSeekPeriod(instant.millis);
    const rates = DEEPSEEK_RATES[currency][billedModel][period];
    if (
      rates.effectiveFrom !== undefined &&
      instant.millis < Date.parse(rates.effectiveFrom)
    ) {
      return undefined;
    }
    return Object.freeze({
      ...rates,
      requestedModel: freezeModelRef(input.requestedModel),
      billedModel: Object.freeze({ provider: this.provider, model: billedModel }),
      period,
      pricedAt: new Date(instant.millis).toISOString(),
      timeBasis: instant.basis,
    });
  }
}

export function createDefaultModelPricingResolver(): ModelPricingResolver {
  const resolver = new ModelPricingResolver();
  resolver.register(new DeepSeekPricingPolicy());
  return resolver;
}

function price(
  version: string,
  effectiveFrom: string,
  currency: DeepSeekCurrency,
  inputPerMillionTokens: number,
  cachedInputPerMillionTokens: number,
  outputPerMillionTokens: number,
): ModelPrice {
  return Object.freeze({
    version,
    currency,
    effectiveFrom,
    inputPerMillionTokens,
    cachedInputPerMillionTokens,
    outputPerMillionTokens,
  });
}

function deepSeekCurrency(value: string): DeepSeekCurrency | undefined {
  return value === "USD" || value === "CNY" ? value : undefined;
}

function canonicalDeepSeekModel(model: string): DeepSeekBilledModel | undefined {
  if (model === DEEPSEEK_FLASH || LEGACY_DEEPSEEK_FLASH.has(model)) return DEEPSEEK_FLASH;
  return model === DEEPSEEK_PRO ? DEEPSEEK_PRO : undefined;
}

function deepSeekPeriod(millis: number): DeepSeekPeriod {
  const time = new Date(millis);
  const weekday = time.getUTCDay();
  if (weekday === 0 || weekday === 6) return "off_peak";
  const hour = time.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
    ? "peak"
    : "off_peak";
}

function staticQuote(
  input: ResolveModelPriceQuoteInput,
  configuredPrice: ModelPrice,
): ModelPriceQuote | undefined {
  const instant = pricingInstant(input);
  if (configuredPrice.currency !== input.currency) return undefined;
  if (
    input.billedModel !== undefined &&
    !sameModel(input.billedModel, input.requestedModel)
  ) {
    return undefined;
  }
  if (
    configuredPrice.effectiveFrom !== undefined &&
    instant.millis < timestamp(configuredPrice.effectiveFrom, "Configured price effectiveFrom")
  ) {
    return undefined;
  }
  return snapshotQuote({
    ...configuredPrice,
    requestedModel: input.requestedModel,
    billedModel: input.requestedModel,
    period: "flat",
    pricedAt: new Date(instant.millis).toISOString(),
    timeBasis: instant.basis,
  }, input);
}

function snapshotPricingInput(input: ResolveModelPriceQuoteInput): ResolveModelPriceQuoteInput {
  const requestedAt = epochMilliseconds(input.requestedAt, "Pricing requestedAt");
  const providerCreatedAt = input.providerCreatedAt === undefined
    ? undefined
    : epochMilliseconds(input.providerCreatedAt, "Pricing providerCreatedAt");
  const currency = requireCurrency(input.currency);
  return Object.freeze({
    requestedModel: freezeModelRef(input.requestedModel),
    requestedAt,
    ...(providerCreatedAt === undefined ? {} : { providerCreatedAt }),
    currency,
    ...(input.billedModel === undefined
      ? {}
      : { billedModel: freezeModelRef(input.billedModel) }),
    ...(input.configuredPrice === undefined
      ? {}
      : { configuredPrice: Object.freeze({ ...input.configuredPrice }) }),
  });
}

function snapshotQuote(
  quote: ModelPriceQuote,
  input: ModelPricingPolicyInput,
): ModelPriceQuote {
  if (!sameModel(quote.requestedModel, input.requestedModel)) {
    throw new Error("Model Pricing quote must retain the requested model");
  }
  const currency = requireCurrency(quote.currency);
  if (currency !== input.currency) {
    throw new Error("Model Pricing quote currency must match the request");
  }
  const effectiveFrom = quote.effectiveFrom === undefined
    ? undefined
    : new Date(timestamp(quote.effectiveFrom, "Model Pricing quote effectiveFrom")).toISOString();
  const effectiveTo = quote.effectiveTo === undefined
    ? undefined
    : new Date(timestamp(quote.effectiveTo, "Model Pricing quote effectiveTo")).toISOString();
  if (
    effectiveFrom !== undefined && effectiveTo !== undefined &&
    Date.parse(effectiveTo) <= Date.parse(effectiveFrom)
  ) {
    throw new Error("Model Pricing quote effectiveTo must be after effectiveFrom");
  }
  const pricedAt = new Date(timestamp(quote.pricedAt, "Model Pricing quote pricedAt")).toISOString();
  if (effectiveFrom !== undefined && Date.parse(pricedAt) < Date.parse(effectiveFrom)) {
    throw new Error("Model Pricing quote pricedAt must not precede effectiveFrom");
  }
  if (effectiveTo !== undefined && Date.parse(pricedAt) >= Date.parse(effectiveTo)) {
    throw new Error("Model Pricing quote pricedAt must precede effectiveTo");
  }
  if (quote.timeBasis !== "provider_created" && quote.timeBasis !== "request_started") {
    throw new Error("Model Pricing quote timeBasis is unsupported");
  }
  return Object.freeze({
    version: requireIdentifier(quote.version, "Model Pricing quote version"),
    currency,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveTo === undefined ? {} : { effectiveTo }),
    inputPerMillionTokens: nonNegativePrice(
      quote.inputPerMillionTokens,
      "Model Pricing quote input price",
    ),
    ...(quote.cachedInputPerMillionTokens === undefined
      ? {}
      : { cachedInputPerMillionTokens: nonNegativePrice(
        quote.cachedInputPerMillionTokens,
        "Model Pricing quote cached input price",
      ) }),
    ...(quote.cacheWriteInputPerMillionTokens === undefined
      ? {}
      : { cacheWriteInputPerMillionTokens: nonNegativePrice(
        quote.cacheWriteInputPerMillionTokens,
        "Model Pricing quote cache write price",
      ) }),
    outputPerMillionTokens: nonNegativePrice(
      quote.outputPerMillionTokens,
      "Model Pricing quote output price",
    ),
    requestedModel: freezeModelRef(quote.requestedModel),
    billedModel: freezeModelRef(quote.billedModel),
    period: requireIdentifier(quote.period, "Model Pricing quote period"),
    pricedAt,
    timeBasis: quote.timeBasis,
  });
}

function pricingInstant(input: ModelPriceQuoteRequest): {
  readonly millis: number;
  readonly basis: ModelPriceTimeBasis;
} {
  epochMilliseconds(input.requestedAt, "Pricing requestedAt");
  if (input.providerCreatedAt !== undefined) {
    return Object.freeze({
      millis: epochMilliseconds(input.providerCreatedAt, "Pricing providerCreatedAt"),
      basis: "provider_created" as const,
    });
  }
  return Object.freeze({ millis: input.requestedAt, basis: "request_started" as const });
}

function freezeModelRef(reference: ModelRef): ModelRef {
  return Object.freeze({
    provider: requireIdentifier(reference.provider, "Model Pricing Provider"),
    model: requireIdentifier(reference.model, "Model Pricing model"),
  });
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function requireCurrency(value: string): string {
  if (!/^[A-Z]{3}$/u.test(value)) {
    throw new Error("Model Pricing currency must be a three-letter uppercase code");
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function epochMilliseconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be non-negative epoch milliseconds`);
  }
  return value;
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

function nonNegativePrice(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}
