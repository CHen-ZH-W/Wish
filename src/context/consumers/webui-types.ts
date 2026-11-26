/** Context-owned presentation telemetry. Never used to admit or compact a request. */
export interface SessionContextOccupancyView {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly status: "estimated" | "unknown";
  readonly source: "estimated" | "provider-anchored" | "preflight" | "unknown";
  readonly model?: { readonly provider: string; readonly model: string };
  readonly capturedAt?: string;
  readonly usedTokens?: number;
  readonly contextWindow?: number;
  readonly reservedOutputTokens?: number;
  readonly inputLimitTokens?: number;
  readonly remainingTokens?: number;
  /** Fraction of the full model window; may exceed one. */
  readonly ratio?: number;
  /** Heuristic components, before Provider calibration; not billing categories. */
  readonly breakdown?: {
    readonly systemTokens: number;
    readonly toolsTokens: number;
    readonly messageTokens: number;
  };
  readonly countMethod?: string;
  readonly reason?: string;
}
