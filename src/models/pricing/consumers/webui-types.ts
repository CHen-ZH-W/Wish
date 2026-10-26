export type SessionModelUsageCoverage = "complete" | "partial" | "unavailable";

export interface SessionModelCostPeriod {
  /** Persisted quote/cost period; "unknown" means historical metadata is absent. */
  readonly period: string;
  readonly totalCost: number;
  readonly attempts: number;
  readonly estimated: boolean;
}

export interface SessionModelCostCurrency {
  readonly currency: string;
  readonly totalCost: number;
  readonly uncachedInputCost: number;
  readonly cachedInputCost: number;
  readonly cacheWriteInputCost: number;
  readonly outputCost: number;
  /** True if any included attempt used estimated rather than Provider usage. */
  readonly estimated: boolean;
  readonly attempts: number;
  readonly periods: readonly SessionModelCostPeriod[];
}

/** Historical amounts only, kept separate by billing currency without FX conversion. */
export interface SessionModelCostView {
  /** Complete requires all terminal attempts priced and no requests still running. */
  readonly coverage: SessionModelUsageCoverage;
  readonly settledAttempts: number;
  readonly pricedAttempts: number;
  readonly unavailableAttempts: number;
  /** In-flight requests are never interpreted as a settled zero cost. */
  readonly runningAttempts: number;
  readonly currencies: readonly SessionModelCostCurrency[];
}

/** Models-owned, read-only projection exposed through the generic WebUI control transport. */
export interface SessionModelUsageView {
  readonly schemaVersion: 1;
  readonly scope: "session";
  readonly sessionId: string;
  readonly coverage: SessionModelUsageCoverage;
  readonly attempts: {
    readonly completed: number;
    readonly usageReported: number;
    readonly cacheReadReported: number;
    readonly cacheWriteReported: number;
  };
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
    readonly cachedInput?: number;
    readonly cacheWriteInput?: number;
    readonly uncachedInput?: number;
  };
  /** Cached input divided by input for attempts whose cached-input field is known. */
  readonly cacheHitRatio?: number;
  readonly cost: SessionModelCostView;
}
