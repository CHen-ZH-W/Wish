import type { CandidateReview, CandidateSource } from "../candidates/types.js";

export type EvolutionTarget = "skill" | "prompt" | "workflow" | "tool" | "plugin" | "kernel";
export type EvolutionState = "waiting-input" | "running" | "awaiting-external-validation" | "awaiting-review" | "completed" | "paused" | "cancelled" | "failed" | "interrupted" | "reconciliation-required";
export type EvolutionStage = "evidence" | "generate" | "candidate" | "evaluate" | "feedback" | "publish";
export interface EvolutionUsage {
  readonly modelCalls: number; readonly tokens: number;
  readonly costByCurrency: Readonly<Record<string, number | null>>;
  readonly complete: boolean;
}
export interface EvolutionBudget {
  readonly modelCalls: number; readonly tokens: number;
  readonly costByCurrency: Readonly<Record<string, number>>; readonly timeoutMs: number;
}
/** Immutable task evidence: adapters must derive outcome from Host records. */
export interface TaskTrace {
  readonly id: string; readonly digest: string;
  readonly sourceKind: "production" | "development" | "regression" | "held-out" | "evolution";
  readonly sessionId?: string; readonly runId: string; readonly terminalStatus: string;
  readonly taskOutcome: "passed" | "failed" | "unknown";
  readonly evidenceRefs: readonly string[]; readonly summary: string;
  readonly profileSnapshotDigest?: string; readonly capturedAt: string;
}
export interface EvolutionTicket {
  readonly id: string; readonly traceIds: readonly string[]; readonly traceDigests: readonly string[];
  readonly failureCategory: "environment" | "authorization" | "project" | "harness" | "unknown";
  readonly evidenceRefs: readonly string[]; readonly summary: string; readonly problem: string;
  readonly hypothesis: string; readonly target: EvolutionTarget; readonly confidence: number;
  readonly pattern?: "failure" | "repeated-tool" | "high-token-use" | "high-cost";
  readonly alternatives?: readonly string[];
}
export interface EvolutionEvidence {
  readonly traces: readonly TaskTrace[]; readonly tickets: readonly EvolutionTicket[];
  readonly usage?: EvolutionUsage;
  readonly experiences?: readonly import("./experience.js").ExperienceEntry[];
  readonly strategies?: readonly import("./strategy.js").StrategyGene[];
}
/** Untrusted generation output. It cannot carry review, verdict or activation. */
export interface EvolutionProposal {
  readonly id: string; readonly ticketIds: readonly string[]; readonly target: EvolutionTarget;
  readonly rationale: string; readonly source: CandidateSource; readonly usage?: EvolutionUsage;
  readonly generation?: { readonly engine: "runtime"; readonly snapshotDigest: string; readonly sessionId: string; readonly runId: string; readonly trajectoryDigest: string };
}
export interface EvolutionCandidateReceipt {
  readonly candidateDigest: string; readonly validationId: string;
  readonly artifactDigest: string; readonly snapshotDigest: string; readonly usage?: EvolutionUsage;
}
/** Only the injected Host evaluator may produce this receipt. */
export interface EvolutionVerdict {
  readonly authority: "host"; readonly experimentId: string; readonly datasetDigest: string;
  readonly candidateDigest: string; readonly decision: "accepted" | "rejected" | "inconclusive";
  readonly baselineScore: number; readonly candidateScore: number; readonly reason: string;
  readonly evidenceDigest: string; readonly review?: CandidateReview; readonly usage?: EvolutionUsage;
}
export interface EvolutionFeedback {
  readonly id: string; readonly summary: string; readonly evidenceRefs: readonly string[];
  readonly usage?: EvolutionUsage;
}
export interface EvolutionPublicationReceipt {
  readonly authority: "host"; readonly approvedDigest: string; readonly promotionId: string;
  readonly status: "active" | "rejected" | "recovery-required" | "interrupted";
}
export type EvolutionStageReceipt = EvolutionEvidence | EvolutionProposal | EvolutionCandidateReceipt | EvolutionVerdict | EvolutionFeedback | EvolutionPublicationReceipt;
export interface EvolutionStageFailure {
  readonly authority: "host"; readonly kind: "stage-failure"; readonly stage: EvolutionStage;
  readonly reason: string; readonly usage: EvolutionUsage;
}
export interface EvolutionOperation {
  readonly id: string; readonly stage: EvolutionStage; readonly status: "pending" | "completed" | "failed";
  readonly startedAt: string; readonly endedAt?: string; readonly receipt?: EvolutionStageReceipt;
  readonly failure?: EvolutionStageFailure;
}
export interface EvolutionAttempt {
  readonly id: string; readonly round: number; readonly startedAt: string;
  readonly endedAt?: string; readonly operations: readonly EvolutionOperation[];
  readonly evidence?: EvolutionEvidence; readonly proposal?: EvolutionProposal;
  readonly candidate?: EvolutionCandidateReceipt; readonly verdict?: EvolutionVerdict;
  readonly feedback?: EvolutionFeedback;
  readonly parentAttemptId?: string; readonly contentDigest?: string; readonly duplicateOf?: string;
}
export interface EvolutionCampaignSpec {
  readonly objective: string; readonly baselineSnapshotDigest: string; readonly datasetDigest?: string;
  readonly evaluationMode?: "deferred" | "external";
  readonly context?: {
    readonly sessionId?: string; readonly workspaceRoot?: string; readonly traceIds?: readonly string[];
    readonly hypothesis?: string; readonly parentId?: string; readonly entryId?: string; readonly generatorId?: string; readonly generatorSnapshotDigest?: string;
  };
  readonly allowedTargets: readonly EvolutionTarget[]; readonly budget: EvolutionBudget;
  readonly maxRounds: number; readonly patience: number;
}
export interface EvolutionCampaign {
  readonly schemaVersion: 1; readonly id: string; readonly requestId: string; readonly specDigest: string;
  readonly spec: EvolutionCampaignSpec; readonly revision: number; readonly state: EvolutionState;
  readonly createdAt: string; readonly updatedAt: string; readonly elapsedMs: number;
  readonly usage: EvolutionUsage; readonly attempts: readonly EvolutionAttempt[];
  readonly nonImprovingRounds: number; readonly bestScore?: number;
  readonly review?: CandidateReview; readonly publication?: EvolutionPublicationReceipt;
  readonly error?: string; readonly stopReason?: string;
  readonly inputs?: readonly { readonly requestId: string; readonly feedback: string; readonly traceIds: readonly string[]; readonly createdAt: string }[];
}
export interface EvolutionStore {
  read(id: string): Promise<EvolutionCampaign | undefined>;
  list(): Promise<readonly EvolutionCampaign[]>;
  create(value: EvolutionCampaign): Promise<EvolutionCampaign>;
  compareAndSwap(id: string, expectedRevision: number, value: EvolutionCampaign): Promise<EvolutionCampaign>;
  close?(): Promise<void>;
}
export interface EvolutionStageContext {
  readonly campaign: EvolutionCampaign; readonly attempt: EvolutionAttempt;
  readonly operationId: string; readonly signal: AbortSignal;
}
/** Host-owned ports. Models are invoked only behind generate/evidence adapters. */
export interface EvolutionPorts {
  evidence(context: EvolutionStageContext): Promise<EvolutionEvidence>;
  generate(context: EvolutionStageContext): Promise<EvolutionProposal>;
  candidate(context: EvolutionStageContext): Promise<EvolutionCandidateReceipt>;
  evaluate?(context: EvolutionStageContext): Promise<EvolutionVerdict>;
  feedback(context: EvolutionStageContext): Promise<EvolutionFeedback>;
  publish?(context: EvolutionStageContext, approvedDigest: string): Promise<EvolutionPublicationReceipt>;
  /** Reconcile persisted intent. undefined means outcome is unknown; never blindly replay. */
  reconcile?(context: EvolutionStageContext, operation: EvolutionOperation): Promise<EvolutionStageReceipt | EvolutionStageFailure | undefined>;
  /** Clean only resources owned by context.attempt.id, after its call has drained. */
  cleanup?(context: EvolutionStageContext): Promise<void>;
}
export interface EvolutionControlOptions { readonly expectedRevision?: number; readonly signal?: AbortSignal }
export interface EvolutionApprovalOptions extends EvolutionControlOptions { readonly expectedRevision: number; readonly approvedDigest: string; readonly requestId: string }
