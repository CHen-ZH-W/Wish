import type { Context } from "@deepseek-ai/cordis";

import {
  registerManagedWebUiControl,
  WebUiControlError,
} from "../../../apps/webui/controls.js";
import type { ModelAttemptRecord } from "../attempts.js";
import type { SessionModelUsageView } from "./webui-types.js";

export const MODEL_USAGE_WEBUI_CONTROL = "model-usage";

/** Project durable Provider attempts without teaching WebUI Core the Models protocol. */
export function projectSessionModelUsage(
  sessionId: string,
  records: readonly ModelAttemptRecord[],
): SessionModelUsageView {
  const completed = records.filter(record => record.status === "completed");
  const reported = completed.filter(record => record.usage !== undefined);
  const cacheReads = reported.filter(record => record.usage!.cachedInputTokens !== undefined);
  const cacheWrites = reported.filter(record => record.usage!.cacheWriteInputTokens !== undefined);
  const input = sum(reported.map(record => record.usage!.inputTokens));
  const output = sum(reported.map(record => record.usage!.outputTokens));
  const total = sum(reported.map(record => record.usage!.totalTokens));
  const knownInput = sum(cacheReads.map(record => record.usage!.inputTokens));
  const cachedInput = sum(cacheReads.map(record => record.usage!.cachedInputTokens!));
  if (cachedInput > knownInput) {
    throw new WebUiControlError(503, "model_usage_unavailable", "Model usage cached input exceeds total input");
  }
  const cacheHitRatio = knownInput > 0 ? cachedInput / knownInput : undefined;
  const coverage = cacheHitRatio === undefined
    ? "unavailable"
    : reported.length === completed.length && cacheReads.length === reported.length
      ? "complete"
      : "partial";
  const allCacheCategoriesKnown = reported.length > 0 &&
    cacheReads.length === reported.length && cacheWrites.length === reported.length;
  const cacheWriteInput = allCacheCategoriesKnown
    ? sum(reported.map(record => record.usage!.cacheWriteInputTokens!))
    : undefined;
  const uncachedInput = allCacheCategoriesKnown
    ? subtractCategories(input, cachedInput, cacheWriteInput!)
    : undefined;

  return Object.freeze({
    schemaVersion: 1,
    scope: "session",
    sessionId,
    coverage,
    attempts: Object.freeze({
      completed: completed.length,
      usageReported: reported.length,
      cacheReadReported: cacheReads.length,
      cacheWriteReported: cacheWrites.length,
    }),
    tokens: Object.freeze({
      input,
      output,
      total,
      ...(cacheReads.length ? { cachedInput } : {}),
      ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
      ...(uncachedInput === undefined ? {} : { uncachedInput }),
    }),
    ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
  });
}

function sum(values: readonly number[]): number {
  let result = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(result + value)) {
      throw new WebUiControlError(503, "model_usage_unavailable", "Model usage totals cannot be represented safely");
    }
    result += value;
  }
  return result;
}

function subtractCategories(input: number, cached: number, written: number): number {
  const value = input - cached - written;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WebUiControlError(503, "model_usage_unavailable", "Model usage cache categories are inconsistent");
  }
  return value;
}

export default {
  name: "model-usage-webui-control",
  inject: ["modelAttemptLedger", "webUiControls"],
  apply(ctx: Context): void {
    registerManagedWebUiControl(ctx, MODEL_USAGE_WEBUI_CONTROL, {
      async inspectSession(_application, sessionId, signal) {
        return projectSessionModelUsage(
          sessionId,
          await ctx.modelAttemptLedger.list({ sessionId }, signal),
        );
      },
    });
  },
};
