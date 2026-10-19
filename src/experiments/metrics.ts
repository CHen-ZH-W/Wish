import type { ExperimentCaseResult, ExperimentMetrics, ExperimentPlan } from "./types.js";

/** Includes failed/retried Provider attempts; incomplete usage or prices stay explicitly unknown. */
export function summarize(plan: ExperimentPlan, results: readonly ExperimentCaseResult[]): {
  metrics: Readonly<Record<string, ExperimentMetrics>>;
  comparison: Readonly<Record<string, { baseline: string; successRateDelta: number; meanLatencyMsDelta: number }>>;
} {
  const metrics: Record<string, ExperimentMetrics> = {};
  for (const variant of plan.variants) {
    const cases = results.filter(result => result.label === variant.label);
    const attempts = cases.flatMap(result => result.attempts);
    const complete = cases.every(result => result.attemptsComplete !== false);
    const usage = attempts.flatMap(attempt => attempt.usage ? [attempt.usage] : []);
    const priced = attempts.every(attempt => attempt.cost?.status === "available");
    const costByCurrency: Record<string, number> = {};
    for (const attempt of attempts) if (attempt.cost?.status === "available") costByCurrency[attempt.cost.currency] = (costByCurrency[attempt.cost.currency] ?? 0) + attempt.cost.totalCost;
    metrics[variant.label] = {
      cases: cases.length, successful: cases.filter(result => result.passed).length,
      successRate: cases.length ? cases.filter(result => result.passed).length / cases.length : 0,
      meanLatencyMs: cases.length ? cases.reduce((sum, result) => sum + result.durationMs, 0) / cases.length : 0,
      attempts: complete ? attempts.length : null, knownUsageAttempts: usage.length,
      inputTokens: complete && usage.length === attempts.length && attempts.length ? usage.reduce((sum, item) => sum + item.inputTokens, 0) : null,
      outputTokens: complete && usage.length === attempts.length && attempts.length ? usage.reduce((sum, item) => sum + item.outputTokens, 0) : null,
      costByCurrency: complete && priced && attempts.length ? costByCurrency : null,
    };
  }
  const baseline = metrics[plan.baseline]!;
  const baselineKeys = results.filter(result => result.label === plan.baseline).map(result => `${result.caseId}:${result.repetition}`).sort().join(",");
  const comparison = Object.fromEntries(plan.variants.filter(variant => variant.label !== plan.baseline && baselineKeys && results.filter(result => result.label === variant.label).map(result => `${result.caseId}:${result.repetition}`).sort().join(",") === baselineKeys).map(variant => [variant.label, {
    baseline: plan.baseline, successRateDelta: metrics[variant.label]!.successRate - baseline.successRate,
    meanLatencyMsDelta: metrics[variant.label]!.meanLatencyMs - baseline.meanLatencyMs,
  }]));
  return { metrics, comparison };
}
