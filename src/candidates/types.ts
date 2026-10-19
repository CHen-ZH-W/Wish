import type { AgentProfileDefinition, AgentProfileSnapshot, ProfileCodeFile } from "../agent-profiles/types.js";
import type { ProcessOwner } from "../agent-profiles/process-owner.js";
import type { WishPluginManifest } from "../boot/plugin-control/manifest.js";
import type { ExperimentExecutionInput, ExperimentExecutionResult, ExperimentRun } from "../experiments/types.js";

/** Source is data until the confined Provider builds it. No npm scripts run in the Host. */
export interface CandidateSource {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
  readonly tests: readonly string[];
  readonly manifest: WishPluginManifest;
  readonly config: Readonly<Record<string, unknown>>;
  readonly provenance: { readonly author: string; readonly purpose: string; readonly sessionId?: string; readonly runId?: string };
}
export interface CandidateArtifact {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly sourceDigest: string;
  readonly files: Readonly<Record<string, string>>;
  /** Exact installed Wish release and dependency lock used by the compiler. */
  readonly hostCode: readonly ProfileCodeFile[];
  readonly imports: readonly string[];
}
export interface CandidateValidation {
  readonly admissionDigest?: string;
  readonly checks?: CandidateChecks;
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateDigest: string;
  readonly owner: ProcessOwner;
  readonly status: "running" | "passed" | "failed" | "cancelled" | "interrupted";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly baseSnapshotDigest: string;
  readonly target: { readonly parentId: string; readonly entryId: string };
  readonly profile: AgentProfileDefinition;
  readonly artifactDigest?: string;
  readonly snapshotDigest?: string;
  readonly error?: string;
}
/** Successful isolated checks; failures retain diagnostics on CandidateValidation. */
export interface CandidateChecks {
  readonly typecheck: "passed";
  readonly build: "passed";
  readonly tests: { readonly passed: number; readonly failed: 0 };
  readonly activation: "passed";
  readonly interfaces: "passed";
  readonly ownership: "passed";
  readonly unload: "passed";
}
export interface CandidateEvaluation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly validationId: string;
  readonly experimentId: string;
  readonly datasetDigest: string;
  readonly repetitions: number;
  readonly gate: import("../plugin-admission/quality.js").CandidateQualityGate;
}
export interface CandidateReview {
  readonly admissionDigest?: string;
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly validationId: string;
  readonly evaluationId: string;
  readonly artifactDigest: string;
  readonly candidateDigest: string;
  readonly snapshotDigest: string;
  readonly evidenceDigest: string;
  readonly deploymentDigest: string;
  readonly managementRevision: string;
  readonly overlayDigest: string;
  readonly previousOverlay: readonly import("../boot/plugin-control/deployment-overlay.js").DeploymentOverlayEntry[];
  readonly target: CandidateValidation["target"];
  readonly previousEntry: Readonly<Record<string, unknown>> | null;
  readonly reviewer: string;
  readonly reason: string;
  readonly trust: "trusted-in-process";
}
export interface CandidatePromotion {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly review: CandidateReview;
  readonly status: "applying" | "active" | "rejected" | "recovery-required" | "rolling-back" | "rolled-back" | "interrupted";
  readonly owner: ProcessOwner;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly appliedOverlayDigest?: string;
  readonly error?: string;
}
/** Implementations own confinement, cancellation, output limits and the entire child process tree. */
export interface CandidateRunner {
  build(source: CandidateSource, directory: string, signal: AbortSignal): Promise<{ files: Readonly<Record<string, string>>; imports: readonly string[] }>;
  check(input: { source: CandidateSource; artifact: CandidateArtifact; base: AgentProfileSnapshot; validation: CandidateValidation; directory: string }, signal: AbortSignal): Promise<{ snapshot: AgentProfileSnapshot; checks: CandidateChecks }>;
  execute(input: ExperimentExecutionInput, signal: AbortSignal): Promise<ExperimentExecutionResult>;
}
export interface CandidateEvaluationResult { readonly evaluation: CandidateEvaluation; readonly experiment: ExperimentRun }
