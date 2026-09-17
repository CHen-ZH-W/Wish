import type { ToolRecoveryPolicy } from "../core/tools/tool.js";
import type { TaskGraphRef, TaskSpec } from "../tasks/types.js";
import type { SubagentOwner } from "../subagents/types.js";
import type { PermissionProfile } from "../permissions/types.js";
import type { ModelsConfiguration } from "../models/types.js";
import type { CapabilityKind } from "../permissions/authorization.js";

export interface WorkflowBudget {
  readonly maxTotalAttempts: number;
  readonly maxAttemptsPerStep: number;
  readonly maxCallsPerEdge: number;
  readonly circuitThreshold: number;
}
export type WorkflowStatus = "running" | "completed" | "failed" | "blocked" | "cancelled" | "interrupted";
export interface WorkflowAttempt {
  readonly id: string;
  readonly ordinal: number;
  readonly status: "prepared" | "dispatched" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly idempotencyKey: string;
  readonly strategy: string;
  readonly edge: string;
  readonly recoveryPolicy: ToolRecoveryPolicy;
  readonly disposition?: ToolRecoveryPolicy;
  readonly childId?: string;
  readonly startedAt: string;
  readonly deadline: string;
  readonly endedAt?: string;
  readonly result?: string;
  readonly errorFingerprint?: string;
}
export interface WorkflowStep {
  readonly task: TaskSpec;
  readonly status: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled" | "interrupted";
  readonly attempts: readonly WorkflowAttempt[];
}
export interface WorkflowEvent {
  readonly sequence: number;
  readonly type: string;
  readonly at: string;
  readonly stepId?: string;
  readonly attemptId?: string;
  readonly reason?: string;
}
export interface WorkflowRun {
  readonly allowedCapabilities: readonly CapabilityKind[];
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly key: string;
  readonly kind: "task-graph" | "subagent";
  readonly owner: SubagentOwner;
  readonly graph?: TaskGraphRef;
  readonly approvedPlanDigest?: string;
  readonly model?: string;
  readonly modelsConfiguration?: ModelsConfiguration;
  readonly permissionProfile: PermissionProfile;
  readonly availableTools: readonly string[];
  readonly status: WorkflowStatus;
  readonly budget: WorkflowBudget;
  readonly steps: readonly WorkflowStep[];
  readonly events: readonly WorkflowEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureDigest?: string;
  readonly circuitFailures: number;
}
export interface CreateWorkflowRequest {
  readonly allowedCapabilities?: readonly CapabilityKind[];
  readonly key: string;
  readonly kind: WorkflowRun["kind"];
  readonly owner: SubagentOwner;
  readonly tasks: readonly TaskSpec[];
  readonly graph?: TaskGraphRef;
  readonly approvedPlanDigest?: string;
  readonly model?: string;
  readonly modelsConfiguration?: ModelsConfiguration;
  readonly permissionProfile: PermissionProfile;
  readonly availableTools: readonly string[];
  readonly budget?: Partial<WorkflowBudget>;
}
export interface WorkflowStore {
  list(): Promise<readonly WorkflowRun[]>;
  get(id: string): Promise<WorkflowRun | undefined>;
  put(run: WorkflowRun, expectedRevision: number): Promise<void>;
  close(): Promise<void>;
}
export interface BeginAttemptRequest { readonly runId: string; readonly stepId: string; readonly strategy: string; readonly edge?: string; readonly recoveryPolicy?: ToolRecoveryPolicy }
export interface AttemptTarget { readonly runId: string; readonly stepId: string; readonly attemptId: string }
export interface Workflow {
  create(request: CreateWorkflowRequest): Promise<WorkflowRun>;
  get(id: string): Promise<WorkflowRun | undefined>;
  list(): Promise<readonly WorkflowRun[]>;
  beginAttempt(request: BeginAttemptRequest): Promise<WorkflowAttempt>;
  markDispatched(target: AttemptTarget): Promise<void>;
  bindChild(target: AttemptTarget, childId: string): Promise<void>;
  recoverChild(target: AttemptTarget, childId: string): Promise<void>;
  finishAttempt(target: AttemptTarget, status: "completed" | "failed" | "cancelled", result: string): Promise<void>;
  resumeAttempt(target: AttemptTarget): Promise<WorkflowAttempt>;
  reconcile(target: AttemptTarget, outcome: "completed" | "not-completed" | "unknown", actor: string, evidence: string): Promise<void>;
  recoverInterrupted(): Promise<readonly WorkflowRun[]>;
  interruptAttempt(target: AttemptTarget, reason: string): Promise<void>;
  block(id: string, reason: string): Promise<void>;
  cancel(id: string, reason: string): Promise<void>;
  close(): Promise<void>;
}
