import type { ToolRecoveryPolicy } from "../../tools/scheduler.js";

export const RECOVERY_DISPOSITIONS = Object.freeze([
  "retry-safe",
  "resumable",
  "needs-reconciliation",
  "terminal-failed",
] as const);

export type RecoveryDisposition = typeof RECOVERY_DISPOSITIONS[number];

export type DurableRuntimeLifecycleEventType =
  | "run.opened"
  | "run.completed"
  | "run.failed"
  | "run.aborted"
  | "run.interrupted"
  | "user_turn.opened"
  | "user_turn.completed"
  | "user_turn.failed"
  | "user_turn.aborted"
  | "user_turn.interrupted"
  | "step.opened"
  | "step.completed"
  | "step.failed"
  | "step.aborted"
  | "step.interrupted"
  | "tool.prepared"
  | "tool.dispatched"
  | "tool.completed"
  | "tool.failed"
  | "tool.aborted"
  | "tool.interrupted"
  | "tool.reconciliation_resolved";

export const RUNTIME_RECONCILIATION_OUTCOMES = Object.freeze([
  "confirmed-completed",
  "confirmed-not-completed",
  "accepted-unknown",
] as const);

export type RuntimeReconciliationOutcome =
  typeof RUNTIME_RECONCILIATION_OUTCOMES[number];

/** Persisted metadata only; raw prompts, Tool inputs, and Tool outputs are hashed. */
export interface DurableRuntimeLifecycleEvent {
  readonly schemaVersion: 1;
  readonly type: DurableRuntimeLifecycleEventType;
  readonly occurredAt: string;
  readonly runId: string;
  readonly userTurnId?: string;
  readonly stepId?: string;
  readonly callId?: string;
  readonly agentId?: string;
  readonly scope?: string;
  readonly toolName?: string;
  readonly recoveryPolicy?: ToolRecoveryPolicy;
  readonly callFingerprint?: string;
  readonly snapshotFingerprint?: string;
  readonly grantId?: string;
  readonly resultFingerprint?: string;
  readonly resultStatus?: "completed" | "failed" | "aborted";
  readonly reason?: string;
  readonly interruptedPhase?: "prepared" | "dispatched";
  readonly recoveryDisposition?: RecoveryDisposition;
  readonly resolutionId?: string;
  readonly reconciliationOutcome?: RuntimeReconciliationOutcome;
  readonly actor?: string;
  /** Raw operator evidence is never persisted in the lifecycle Journal. */
  readonly evidenceFingerprint?: string;
}

export interface InterruptedToolExecution {
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly phase: "prepared" | "dispatched";
  readonly recoveryPolicy: ToolRecoveryPolicy;
  readonly disposition: RecoveryDisposition;
}

export interface InterruptedRunExecution {
  readonly runId: string;
  readonly agentId: string;
  readonly scope: string;
  readonly userTurnIds: readonly string[];
  readonly stepIds: readonly string[];
  readonly tools: readonly InterruptedToolExecution[];
  readonly disposition: RecoveryDisposition;
}

export interface RuntimeLifecycleRecoveryReport {
  readonly schemaVersion: 1;
  readonly reason: string;
  readonly recoveredAt: string;
  readonly scannedThroughCursor: number;
  readonly runs: readonly InterruptedRunExecution[];
}

/** Durable projection of one Run previously sealed by startup recovery. */
export interface RecordedInterruptedRunExecution
  extends InterruptedRunExecution {
  readonly interruptedAt: string;
  readonly reason: string;
}

export interface RuntimeReconciliationTarget {
  readonly runId: string;
  readonly agentId: string;
  readonly scope: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryPolicy: ToolRecoveryPolicy;
  readonly interruptedAt: string;
  readonly interruptionReason: string;
}

export interface ResolveRuntimeReconciliationRequest {
  /** Caller-owned idempotency identity; safe to reuse after an uncertain response. */
  readonly resolutionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly outcome: RuntimeReconciliationOutcome;
  readonly actor: string;
  readonly reason: string;
  /** Hashed before persistence; the raw value never enters the Journal. */
  readonly evidence?: string;
  readonly signal?: AbortSignal;
}

export interface RuntimeReconciliationResolution
  extends RuntimeReconciliationTarget {
  readonly schemaVersion: 1;
  readonly resolutionId: string;
  readonly outcome: RuntimeReconciliationOutcome;
  readonly actor: string;
  readonly reason: string;
  readonly evidenceFingerprint?: string;
  readonly resolvedAt: string;
}

export interface RuntimeReconciliationCommit {
  readonly resolution: RuntimeReconciliationResolution;
  readonly replayed: boolean;
}

/**
 * Immutable result published only after the Provider's startup scan succeeds.
 *
 * `recovery.runs` contains work sealed by this Provider generation. The
 * recorded list is rebuilt from the Journal so reconciliation remains visible
 * across later restarts; no entry implies that a Tool was replayed.
 */
export interface RuntimeLifecycleStartupSnapshot {
  readonly schemaVersion: 1;
  readonly status: "ready";
  readonly recovery: RuntimeLifecycleRecoveryReport;
  readonly recordedInterruptedRuns: readonly RecordedInterruptedRunExecution[];
  readonly pendingReconciliations: readonly RuntimeReconciliationTarget[];
  readonly reconciliationResolutions: readonly RuntimeReconciliationResolution[];
  readonly reconciliationRequiredRuns: readonly RecordedInterruptedRunExecution[];
}

export function combineRecoveryDispositions(
  values: readonly RecoveryDisposition[],
): RecoveryDisposition {
  if (values.includes("terminal-failed")) return "terminal-failed";
  if (values.includes("needs-reconciliation")) return "needs-reconciliation";
  if (values.includes("resumable")) return "resumable";
  return "retry-safe";
}
