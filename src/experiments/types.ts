import type { AgentProfileSnapshot } from "../agent-profiles/types.js";
import type { ModelAttemptRecord } from "../models/pricing/attempts.js";
import type { ProcessOwner } from "../agent-profiles/process-owner.js";

export interface ExperimentCase {
  readonly id: string;
  readonly prompt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly assertion: { readonly kind: "exact" | "contains"; readonly expected: string } | { readonly kind: "file-equals"; readonly path: string; readonly expected: string };
}
export interface ExperimentDataset {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly cases: readonly ExperimentCase[];
}
export interface ExperimentPlan {
  readonly datasetDigest: string;
  readonly variants: readonly { readonly label: string; readonly snapshotDigest: string }[];
  readonly baseline: string;
  readonly repetitions: number;
  readonly timeoutMs: number;
  readonly maxSteps: number;
}
export interface ExperimentMetrics {
  readonly cases: number;
  readonly successful: number;
  readonly successRate: number;
  readonly meanLatencyMs: number;
  readonly attempts: number | null;
  readonly knownUsageAttempts: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costByCurrency: Readonly<Record<string, number>> | null;
}
export interface ExperimentCaseResult {
  readonly key: string;
  readonly label: string;
  readonly snapshotDigest: string;
  readonly caseId: string;
  readonly repetition: number;
  readonly status: "completed" | "failed" | "aborted" | "timed-out";
  readonly passed: boolean;
  readonly output: string;
  readonly durationMs: number;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly attempts: readonly ModelAttemptRecord[];
  /** False when a killed/unavailable worker could not return its complete ledger. */
  readonly attemptsComplete?: boolean;
  readonly error?: string;
}
export interface ExperimentRun {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly instanceId: string;
  readonly owner: ProcessOwner;
  readonly plan: ExperimentPlan;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly results: readonly ExperimentCaseResult[];
  readonly metrics: Readonly<Record<string, ExperimentMetrics>>;
  readonly comparison: Readonly<Record<string, { readonly baseline: string; readonly successRateDelta: number; readonly meanLatencyMsDelta: number }>>;
  readonly error?: string;
}
export interface ExperimentExecutionInput {
  readonly snapshot: AgentProfileSnapshot;
  readonly testCase: ExperimentCase;
  readonly directory: string;
  readonly timeoutMs: number;
  readonly maxSteps: number;
}
export interface ExperimentExecutionResult {
  readonly status: ExperimentCaseResult["status"];
  readonly output: string;
  readonly durationMs: number;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly attempts: readonly ModelAttemptRecord[];
  readonly attemptsComplete?: boolean;
  readonly assertionPassed?: boolean;
  readonly error?: string;
}
/** Provider owns a complete isolated invocation, including cancellation and process cleanup. */
export interface ExperimentExecutor {
  execute(input: ExperimentExecutionInput, signal: AbortSignal): Promise<ExperimentExecutionResult>;
}
