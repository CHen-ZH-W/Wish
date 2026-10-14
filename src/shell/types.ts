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
  /** Native profiles use a clean environment; full-access inherits the Host environment. */
  readonly environment: "clean" | "inherit" | "profile-scoped";
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

/**
 * Exact argv that may be handed to a trusted persistent-terminal Provider.
 * The originating Shell Provider has already consumed and validated the
 * one-shot command Spec; Consumers must not rewrite this launch description.
 */
export interface PreparedShellCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  /** Private scratch directory retained until the terminal is explicitly removed. */
  readonly runtimeDirectory?: string;
}

export interface PrepareShellCommandRequest {
  readonly spec: ShellCommandSpec;
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

  prepare(
    request: PrepareShellCommandRequest,
  ): Promise<PreparedShellCommand>;

  run(request: RunShellCommandRequest): Promise<ShellExecutionResult>;
}
