import type { PlanArtifactRef } from "../plan/types.js";

export type DevelopmentLevel = "light" | "standard" | "careful";
export type DevelopmentPhase = "exploring" | "ready" | "running" | "stopping" | "paused" | "verifying" | "review" | "accepted" | "interrupted";
export type DevelopmentGate = "confirmation" | "execution" | "verification" | "user-acceptance" | "recovery" | "none";
export interface DevelopmentCriterion { readonly id: string; readonly text: string; readonly kind: "technical" | "user" }
export interface DevelopmentAssessment { readonly complexity: "low" | "medium" | "high"; readonly uncertainty: "low" | "medium" | "high"; readonly risk: "low" | "medium" | "high"; readonly recommendedLevel: DevelopmentLevel; readonly reason: string }
export interface DevelopmentSpecInput {
  readonly objective: string;
  readonly scope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly constraints: readonly string[];
  readonly criteria: readonly DevelopmentCriterion[];
  readonly questions: readonly string[];
  readonly assumptions: readonly string[];
  readonly decisions: readonly string[];
  readonly planMarkdown: string;
  readonly assessment: DevelopmentAssessment;
  readonly artifacts?: readonly PlanArtifactRef[];
}
export interface DevelopmentSpec extends DevelopmentSpecInput { readonly version: number; readonly digest: string; readonly createdAt: string; readonly code: WorkspaceSnapshot }
export interface WorkspaceSnapshotFile { readonly path: string; readonly bytes: number; readonly digest: string }
export interface WorkspaceSnapshot { readonly schemaVersion: 1; readonly workspaceRoot: string; readonly digest: string; readonly files: readonly WorkspaceSnapshotFile[]; readonly totalBytes: number; readonly excluded: readonly string[] }
export interface DevelopmentPlanApproval { readonly sessionId: string; readonly reviewId: string; readonly stateVersion: number; readonly documentVersion: number; readonly digest: string; readonly markdown: string; readonly artifacts?: readonly PlanArtifactRef[] }
export interface DevelopmentConfirmation { readonly id: string; readonly digest: string; readonly specVersion: number; readonly specDigest: string; readonly executionEpoch: number; readonly code: WorkspaceSnapshot; readonly actor: string; readonly confirmedAt: string; readonly planApproval?: DevelopmentPlanApproval }
export interface DevelopmentStartRequest {
  readonly id: string;
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly confirmationDigest: string;
  readonly specVersion: number;
  readonly executionEpoch: number;
  readonly status: "dispatching" | "running" | "completed" | "failed" | "aborted" | "interrupted";
  readonly createdAt: string;
  readonly endedAt?: string;
}
/** Only the host command runner may submit this receipt; no model-controlled passed field. */
export interface DevelopmentVerificationInput { readonly id: string; readonly criterionIds: readonly string[]; readonly command: string; readonly exitCode: number | null; readonly timedOut: boolean; readonly outputDigest: string; readonly output: string; readonly code: WorkspaceSnapshot; readonly startedAt: string; readonly endedAt: string; readonly runId?: string; readonly toolCallId?: string }
export interface DevelopmentVerification extends DevelopmentVerificationInput { readonly specVersion: number; readonly specDigest: string; readonly executionEpoch: number; readonly digest: string }
export interface DevelopmentCriterionResult { readonly criterionId: string; readonly status: "verified" | "failed" | "unverified" | "waiting-user"; readonly evidenceIds: readonly string[] }
export interface DevelopmentReport { readonly id: string; readonly digest: string; readonly specVersion: number; readonly specDigest: string; readonly executionEpoch: number; readonly code: WorkspaceSnapshot; readonly evidenceDigests: readonly string[]; readonly criteria: readonly DevelopmentCriterionResult[]; readonly summary: string; readonly limitations: readonly string[]; readonly nextSteps: readonly string[]; readonly createdAt: string; readonly acceptedAt?: string; readonly acceptedBy?: string }
export interface DevelopmentChange { readonly id: string; readonly sessionId: string; readonly rawWish: string; readonly originRequestId?: string; readonly originFingerprint?: string; readonly wishUpdates: readonly string[]; readonly specs: readonly DevelopmentSpec[]; readonly phase: DevelopmentPhase; readonly gate: DevelopmentGate; readonly executionEpoch: number; readonly confirmations: readonly DevelopmentConfirmation[]; readonly starts: readonly DevelopmentStartRequest[]; readonly verifications: readonly DevelopmentVerification[]; readonly reports: readonly DevelopmentReport[]; readonly createdAt: string; readonly updatedAt: string }
export interface DevelopmentProject { readonly schemaVersion: 1; readonly id: string; readonly workspaceRoot: string; readonly title: string; readonly sessionIds: readonly string[]; readonly revision: number; readonly changes: readonly DevelopmentChange[]; readonly activeChangeId?: string; readonly createdAt: string; readonly updatedAt: string }
export interface DevelopmentStore { list(): Promise<readonly DevelopmentProject[]>; get(id: string): Promise<DevelopmentProject | undefined>; put(project: DevelopmentProject, expectedRevision: number): Promise<void>; close(): Promise<void> }
export interface DevelopmentChangeRequest { readonly projectId: string; readonly changeId: string; readonly sessionId: string; readonly expectedRevision: number }
export interface Development {
  list(): Promise<readonly DevelopmentProject[]>;
  get(projectId: string): Promise<DevelopmentProject | undefined>;
  forSession(sessionId: string): Promise<DevelopmentProject | undefined>;
  open(input: { readonly sessionId: string; readonly workspaceRoot: string; readonly rawWish: string; readonly title?: string; readonly projectId?: string; readonly expectedRevision?: number; readonly requestId?: string }): Promise<DevelopmentProject>;
  propose(input: DevelopmentChangeRequest & { readonly spec: DevelopmentSpecInput }): Promise<DevelopmentProject>;
  confirm(input: DevelopmentChangeRequest & { readonly specVersion: number; readonly specDigest: string; readonly actor: string; readonly planApproval?: DevelopmentPlanApproval }): Promise<DevelopmentProject>;
  reserveStart(input: DevelopmentChangeRequest & { readonly requestId: string; readonly confirmationDigest: string }): Promise<DevelopmentProject>;
  bindStart(input: { readonly projectId: string; readonly requestId: string; readonly runId: string }): Promise<DevelopmentProject>;
  finishRun(input: { readonly projectId: string; readonly runId: string; readonly status: "completed" | "failed" | "aborted" | "interrupted" }): Promise<DevelopmentProject>;
  requestPause(input: DevelopmentChangeRequest): Promise<DevelopmentProject>;
  settlePause(input: { readonly projectId: string; readonly changeId: string }): Promise<DevelopmentProject>;
  revise(input: DevelopmentChangeRequest & { readonly rawWish?: string }): Promise<DevelopmentProject>;
  recordVerification(input: DevelopmentChangeRequest & { readonly receipt: DevelopmentVerificationInput }): Promise<DevelopmentProject>;
  report(input: DevelopmentChangeRequest & { readonly summary: string; readonly limitations?: readonly string[]; readonly nextSteps?: readonly string[]; readonly runId?: string }): Promise<DevelopmentProject>;
  accept(input: DevelopmentChangeRequest & { readonly reportId: string; readonly reportDigest: string; readonly actor: string }): Promise<DevelopmentProject>;
  detachSession(sessionId: string): Promise<void>;
  recover(): Promise<void>;
  close(): Promise<void>;
}
