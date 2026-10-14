export type SessionModelUsageCoverage = "complete" | "partial" | "unavailable";

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
}
