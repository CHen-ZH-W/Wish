import type { CapabilityKind } from "./authorization.js";
import type {
  ToolAuthorizationInput,
  ToolAuthorizationService,
} from "../core/tools/authorization.js";
import type { WorkspaceSnapshot } from "../workspace/index.js";

export const PERMISSION_PROFILES = Object.freeze([
  "read-only",
  "workspace-write",
  "approval-required",
  "full-access",
] as const);

export type PermissionProfile = typeof PERMISSION_PROFILES[number];

export const TOOL_CAPABILITY_KINDS = Object.freeze([
  "filesystem.read",
  "filesystem.write",
  "process.exec",
  "network.connect",
  "web.search",
  "web.fetch",
  "external.side_effect",
  "runtime.read",
  "runtime.control",
] as const satisfies readonly CapabilityKind[]);

/** Per-Agent input. Defaults are resolved only when a Step is prepared. */
export interface AgentPermissionConfiguration {
  readonly profile?: PermissionProfile;
  readonly availableTools?: readonly string[];
  readonly allowedCapabilities?: readonly CapabilityKind[];
}

export interface PermissionSubject {
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
}

export interface PermissionCapabilityCeiling {
  readonly allowedCapabilities: readonly CapabilityKind[];
}

/** A Host-derived delegation scope, independent of a mode's direct-work controls. */
export interface DelegationPermissionScope {
  readonly availableTools: readonly string[];
  readonly allowedCapabilities: readonly CapabilityKind[];
}

/** Immutable projection contributed by one optional hard-policy module. */
export interface PermissionPolicySnapshot {
  /** Defaults to this policy's direct restrictions; may only narrow the Host base. */
  readonly delegation?: DelegationPermissionScope;
  readonly id: string;
  /** Domain revision used for diagnostics and deterministic Step authority. */
  readonly revision: string;
  /** Optional Tool ceiling. It may only remove names from the base set. */
  readonly availableTools?: readonly string[];
  /** Optional capability ceiling. It may only remove base capabilities. */
  readonly allowedCapabilities?: readonly CapabilityKind[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Complete immutable authority facts fixed exactly once for one Step. */
export interface PermissionSnapshot {
  readonly delegation?: DelegationPermissionScope;
  readonly schemaVersion: 1;
  readonly subject: PermissionSubject;
  readonly profile: PermissionProfile;
  readonly availableTools: readonly string[];
  readonly ceiling: PermissionCapabilityCeiling;
  readonly workspace: {
    readonly fingerprint: string;
    readonly revision: string;
  };
  /** Filesystem enforcement generation included in this Step authority. */
  readonly filesystemPolicyVersion: string;
  /** Shell/sandbox enforcement generation included in this Step authority. */
  readonly shellPolicyVersion: string;
  /** Composite approval-time SandboxPolicy generation for this Step. */
  readonly sandboxPolicyVersion: string;
  readonly policyVersion: string;
  /** Registration generation of the monotonic policy-contribution set. */
  readonly policySetVersion?: number;
  readonly policies?: readonly PermissionPolicySnapshot[];
  readonly authorityVersion: string;
}

export interface ResolvePermissionRequest {
  readonly agent?: AgentPermissionConfiguration;
  readonly subject: PermissionSubject;
  readonly workspace: WorkspaceSnapshot;
  readonly registeredTools: readonly string[];
  readonly signal?: AbortSignal;
}

/** Minimum Tool context required by the permission evaluator. */
export interface PermissionExecutionContext {
  readonly workspace: WorkspaceSnapshot;
  readonly permissions: PermissionSnapshot;
}

export interface PermissionPolicyProjectionInput {
  readonly request: ResolvePermissionRequest;
  readonly availableTools: readonly string[];
  readonly allowedCapabilities: readonly CapabilityKind[];
}

export type PermissionPolicyDecision =
  | { readonly status: "allowed" }
  | { readonly status: "denied"; readonly reason: string };

/**
 * Optional hard-policy contribution. Contributions are monotonic: projection
 * can only narrow a Step snapshot, and execution can only deny a call.
 */
export interface PermissionPolicyContribution {
  readonly id: string;
  project(
    input: PermissionPolicyProjectionInput,
    signal?: AbortSignal,
  ):
    | Promise<PermissionPolicySnapshot>
    | PermissionPolicySnapshot;
  authorize(
    input: ToolAuthorizationInput<PermissionExecutionContext>,
    snapshot: PermissionPolicySnapshot,
    signal?: AbortSignal,
  ): Promise<PermissionPolicyDecision> | PermissionPolicyDecision;
}

export interface PermissionPolicyRegistration {
  readonly id: string;
  unregister(): boolean;
}

export interface PermissionResolver {
  resolve(
    request: ResolvePermissionRequest,
  ): Promise<PermissionSnapshot> | PermissionSnapshot;
}

/** Complete policy capability consumed by the AgentLoop composition. */
export interface PermissionAuthority extends PermissionResolver,
  ToolAuthorizationService<PermissionExecutionContext> {
  registerPolicy(
    contribution: PermissionPolicyContribution,
  ): PermissionPolicyRegistration;
}
