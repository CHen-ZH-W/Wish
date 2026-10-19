import type { ExperimentMetrics } from "../experiments/types.js";
import { deny } from "./contracts.js";

export interface CandidateQualityGate {
  readonly minimumSuccessRate: number;
  readonly maximumSuccessRateRegression: number;
  readonly maximumMeanLatencyMs?: number;
  readonly maximumLatencyRatio?: number;
  readonly maximumTotalTokens?: number;
  readonly maximumTokenRatio?: number;
  readonly maximumAttempts?: number;
  readonly maximumCostByCurrency?: Readonly<Record<string, number>>;
}
export function qualityGate(value: unknown): CandidateQualityGate {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("candidate_gate_invalid");
  const input = value as Record<string, unknown>, ratios = ["minimumSuccessRate", "maximumSuccessRateRegression"];
  if (Object.keys(input).some(key => ![...ratios, "maximumMeanLatencyMs", "maximumLatencyRatio", "maximumTotalTokens", "maximumTokenRatio", "maximumAttempts", "maximumCostByCurrency"].includes(key))) deny("candidate_gate_invalid");
  for (const name of ratios) if (typeof input[name] !== "number" || !Number.isFinite(input[name]) || input[name] < 0 || input[name] > 1) deny("candidate_gate_invalid");
  for (const [name, limit] of Object.entries(input)) if (!ratios.includes(name) && name !== "maximumCostByCurrency" && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) deny("candidate_gate_invalid");
  if (input.maximumCostByCurrency !== undefined) {
    const budgets = input.maximumCostByCurrency;
    if (!budgets || typeof budgets !== "object" || Array.isArray(budgets) || !Object.keys(budgets).length || Object.keys(budgets).length > 16 ||
      Object.entries(budgets).some(([currency, amount]) => !/^[A-Z]{3}$/.test(currency) || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) deny("candidate_gate_invalid");
  }
  return JSON.parse(JSON.stringify(input)) as CandidateQualityGate;
}
/** Unknown usage/cost cannot pass an explicitly requested resource budget. */
export function checkQualityGate(gate: CandidateQualityGate, candidate: ExperimentMetrics, baseline: ExperimentMetrics): void {
  if (candidate.successRate < gate.minimumSuccessRate || baseline.successRate - candidate.successRate > gate.maximumSuccessRateRegression) deny("candidate_quality_gate_failed");
  const check = (value: number | null, maximum: number | undefined, name: string) => {
    if (maximum === undefined) return;
    if (value === null || !Number.isFinite(value)) deny("candidate_metrics_incomplete", name);
    if (value > maximum) deny("candidate_performance_gate_failed", name);
  };
  check(candidate.meanLatencyMs, gate.maximumMeanLatencyMs, "meanLatencyMs");
  check(baseline.meanLatencyMs > 0 ? candidate.meanLatencyMs / baseline.meanLatencyMs : candidate.meanLatencyMs === 0 ? 1 : null, gate.maximumLatencyRatio, "latencyRatio");
  const total = (metrics: ExperimentMetrics) => metrics.inputTokens === null || metrics.outputTokens === null ? null : metrics.inputTokens + metrics.outputTokens;
  const tokens = total(candidate), baseTokens = total(baseline);
  check(tokens, gate.maximumTotalTokens, "totalTokens");
  check(tokens === null || baseTokens === null ? null : baseTokens > 0 ? tokens / baseTokens : tokens === 0 ? 1 : null, gate.maximumTokenRatio, "tokenRatio");
  check(candidate.attempts, gate.maximumAttempts, "attempts");
  if (gate.maximumCostByCurrency) {
    if (candidate.costByCurrency === null) deny("candidate_metrics_incomplete", "cost");
    for (const [currency, amount] of Object.entries(candidate.costByCurrency)) {
      if (!Object.hasOwn(gate.maximumCostByCurrency, currency)) deny("candidate_metrics_incomplete", `currency:${currency}`);
      check(amount, gate.maximumCostByCurrency[currency], `cost:${currency}`);
    }
  }
}
