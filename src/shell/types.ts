import type {
  CapabilityAuthorizationGrant,
  CapabilityRequest,
} from "../permissions/authorization.js";
import type { PermissionProfile, PermissionSnapshot } from
  "../permissions/types.js";
import type { WorkspaceSnapshot } from "../workspace/types.js";

export type ShellBackendKind = "unavailable" | "linux-native" | "host";

export interface ShellResourceLimits {
  readonly maxProcesses: number;
  readonly maxOpenFiles: number;
  readonly maxFileSizeBytes: number;
  readonly maxMemoryBytes: number;
  readonly maxTimeoutSeconds: number;
}

/** Immutable enforcement facts owned by one Shell Provider generation. */
export interface ShellPolicy {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly backend: ShellBackendKind;
  readonly filesystem: "none" | "path-scoped";
  readonly network: "none" | "per-call";
  readonly environment: "clean" | "inherit";
  /** Profiles that may automatically dispatch process calls on this backend. */
  readonly automaticPermissionProfiles: readonly PermissionProfile[];
  readonly resourceLimits: ShellResourceLimits;
  readonly filesystemPolicyVersion: string;
}

export interface ShellExecutionContext {
  readonly workspace: WorkspaceSnapshot;
  readonly permissions: PermissionSnapshot;
}

/** Provider-neutral input. Defaults and exact authority are resolved before run(). */
export interface ResolveShellCommandRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
  readonly context: ShellExecutionContext;
  readonly grant: CapabilityAuthorizationGrant;
  readonly signal?: AbortSignal;
}

/** Approval-time command check. It fixes enforceable facts without authority. */
export interface PreflightShellCommandRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
  readonly capabilities: CapabilityRequest;
  readonly context: ShellExecutionContext;
  readonly signal?: AbortSignal;
}

export interface ShellCommandPreflight {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly networkEnabled: boolean;
  readonly policyVersion: string;
}

/** Complete immutable command facts fixed before a child process is started. */
export interface ShellCommandSpec {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly networkEnabled: boolean;
  readonly policyVersion: string;
  readonly context: ShellExecutionContext;
  readonly grant: CapabilityAuthorizationGrant;
}

export interface RunShellCommandRequest {
  readonly spec: ShellCommandSpec;
  readonly onData: (data: Uint8Array) => void;
  readonly signal?: AbortSignal;
}

export interface ShellExecutionResult {
  readonly exitCode: number | null;
  readonly termination?: "timeout" | "aborted";
}

/** Provider-neutral process execution capability. */
export interface Shell {
  readonly policy: ShellPolicy;

  preflight(
    request: PreflightShellCommandRequest,
  ): Promise<ShellCommandPreflight>;

  resolve(request: ResolveShellCommandRequest): Promise<ShellCommandSpec>;

  run(request: RunShellCommandRequest): Promise<ShellExecutionResult>;
}
