import type { PermissionProfile } from "../types.js";

export const APPROVAL_RULE_SCOPES = Object.freeze([
  "once",
  "run",
  "session",
  "workspace",
] as const);

export type ApprovalRuleScope = typeof APPROVAL_RULE_SCOPES[number];
export type RetainedApprovalRuleScope = Exclude<ApprovalRuleScope, "once">;

export interface ApprovalRuleIdentity {
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceFingerprint: string;
}

/** Exact selector produced from one approved Tool capability request. */
export interface ApprovalRuleMatchRequest {
  readonly profile: PermissionProfile;
  readonly policyVersion: string;
  readonly toolName: string;
  readonly capabilityDigest: string;
  readonly identity: ApprovalRuleIdentity;
  readonly signal?: AbortSignal;
}

export interface ApprovalRuleRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly effect: "allow";
  readonly scope: RetainedApprovalRuleScope;
  readonly profile: PermissionProfile;
  readonly policyVersion: string;
  readonly toolName: string;
  readonly capabilityDigest: string;
  readonly agentId: string;
  readonly workspaceFingerprint: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly createdAt: string;
}

export interface RememberApprovalRuleRequest extends ApprovalRuleMatchRequest {
  readonly scope: RetainedApprovalRuleScope;
}

export interface ApprovalRuleStore {
  /** Store/provider generation included in authorization diagnostics. */
  readonly version: string;

  find(request: ApprovalRuleMatchRequest): Promise<ApprovalRuleRecord | undefined>;
  remember(request: RememberApprovalRuleRequest): Promise<ApprovalRuleRecord>;
  list(signal?: AbortSignal): Promise<readonly ApprovalRuleRecord[]>;
  revoke(id: string, signal?: AbortSignal): Promise<boolean>;
  clearRun(runId: string): boolean;
  close(): Promise<void>;
}
