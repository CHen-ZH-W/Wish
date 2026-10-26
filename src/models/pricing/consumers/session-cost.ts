import { WebUiControlError } from "../../../apps/webui/controls.js";
import type { AvailableModelCost } from "../../usage.js";
import type { ModelAttemptRecord } from "../attempts.js";
import type {
  SessionModelCostCurrency,
  SessionModelCostPeriod,
  SessionModelCostView,
} from "./webui-types.js";

interface CurrencyAccumulator {
  currency: string;
  totalCost: number;
  uncachedInputCost: number;
  cachedInputCost: number;
  cacheWriteInputCost: number;
  outputCost: number;
  estimated: boolean;
  attempts: number;
  periods: Map<string, PeriodAccumulator>;
}

interface PeriodAccumulator {
  period: string;
  totalCost: number;
  attempts: number;
  estimated: boolean;
}

/** Read immutable terminal evidence, never recalculate historical charges at today's rates. */
export function projectSessionModelCost(
  sessionId: string,
  records: readonly ModelAttemptRecord[],
): SessionModelCostView {
  const currencies = new Map<string, CurrencyAccumulator>();
  let settledAttempts = 0;
  let pricedAttempts = 0;
  let runningAttempts = 0;
  for (const record of records) {
    if (record.sessionId !== sessionId) continue;
    if (record.status === "running") {
      runningAttempts += 1;
      continue;
    }
    settledAttempts += 1;
    const cost = record.cost;
    if (cost?.status !== "available") continue;
    validateCost(cost);
    pricedAttempts += 1;
    let currency = currencies.get(cost.currency);
    if (currency === undefined) {
      currency = {
        currency: cost.currency,
        totalCost: 0,
        uncachedInputCost: 0,
        cachedInputCost: 0,
        cacheWriteInputCost: 0,
        outputCost: 0,
        estimated: false,
        attempts: 0,
        periods: new Map(),
      };
      currencies.set(cost.currency, currency);
    }
    currency.totalCost = addCost(currency.totalCost, cost.totalCost);
    currency.uncachedInputCost = addCost(currency.uncachedInputCost, cost.uncachedInputCost);
    currency.cachedInputCost = addCost(currency.cachedInputCost, cost.cachedInputCost);
    currency.cacheWriteInputCost = addCost(currency.cacheWriteInputCost, cost.cacheWriteInputCost);
    currency.outputCost = addCost(currency.outputCost, cost.outputCost);
    currency.estimated ||= cost.estimated;
    currency.attempts += 1;

    const period = record.quote?.period ?? cost.pricePeriod ?? "unknown";
    if (typeof period !== "string" || period.length === 0 || period !== period.trim()) {
      throw costUnavailable("Model cost period is invalid");
    }
    const periodTotal = currency.periods.get(period) ?? {
      period, totalCost: 0, attempts: 0, estimated: false,
    };
    periodTotal.totalCost = addCost(periodTotal.totalCost, cost.totalCost);
    periodTotal.attempts += 1;
    periodTotal.estimated ||= cost.estimated;
    currency.periods.set(period, periodTotal);
  }

  const unavailableAttempts = settledAttempts - pricedAttempts;
  return Object.freeze({
    coverage: pricedAttempts === 0
      ? "unavailable"
      : unavailableAttempts === 0 && runningAttempts === 0 ? "complete" : "partial",
    settledAttempts,
    pricedAttempts,
    unavailableAttempts,
    runningAttempts,
    currencies: Object.freeze([...currencies.values()]
      .sort((left, right) => left.currency.localeCompare(right.currency))
      .map(freezeCurrency)),
  });
}

function freezeCurrency(currency: CurrencyAccumulator): SessionModelCostCurrency {
  const periods: readonly SessionModelCostPeriod[] = Object.freeze([...currency.periods.values()]
    .sort((left, right) => left.period.localeCompare(right.period))
    .map(period => Object.freeze({ ...period })));
  return Object.freeze({ ...currency, periods });
}

function validateCost(cost: AvailableModelCost): void {
  if (!/^[A-Z]{3}$/u.test(cost.currency) || typeof cost.estimated !== "boolean") {
    throw costUnavailable("Model cost currency or estimation metadata is invalid");
  }
  const parts = [cost.uncachedInputCost, cost.cachedInputCost, cost.cacheWriteInputCost, cost.outputCost];
  const sum = parts.reduce(addCost, 0);
  requireCost(cost.totalCost);
  const tolerance = Math.max(sum, cost.totalCost, Number.MIN_VALUE) * Number.EPSILON * 8;
  if (Math.abs(sum - cost.totalCost) > tolerance) {
    throw costUnavailable("Model cost categories do not match the recorded total");
  }
}

function addCost(left: number, right: number): number {
  requireCost(left);
  requireCost(right);
  const total = left + right;
  requireCost(total);
  return total;
}

function requireCost(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw costUnavailable("Model cost totals cannot be represented safely");
  }
}

function costUnavailable(message: string): WebUiControlError {
  return new WebUiControlError(503, "model_usage_unavailable", message);
}
