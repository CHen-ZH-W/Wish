import type {
  ToolAuthorizationInput,
} from "../core/tools/authorization.js";
import type { PermissionExecutionContext } from "../permissions/types.js";
import type { ShellBackendKind, ShellCommandPreflight } from "../shell/types.js";

export interface SandboxPolicyDescriptor {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly filesystemPolicyVersion: string;
  readonly shellPolicyVersion: string;
  readonly shellBackend: ShellBackendKind;
  readonly filesystem: "workspace-path-scoped";
  readonly network: "none" | "all-or-none";
  readonly web: "grant-scoped-provider";
}

/** Immutable proof that the active providers can enforce one capability set. */
export interface EffectiveSandboxCallPolicy {
  readonly schemaVersion: 1;
  readonly policyVersion: string;
  readonly capabilityDigest: string;
  readonly workspace: {
    readonly fingerprint: string;
    readonly revision: string;
  };
  readonly shellBackend: ShellBackendKind;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly networkEnabled: boolean;
  readonly webSearchProviders: readonly string[];
  readonly webFetchProviders: readonly string[];
  readonly webFetchOrigins: readonly string[];
  readonly commands: readonly ShellCommandPreflight[];
}

export type SandboxPreflightResult =
  | {
      readonly status: "allowed";
      readonly effective: EffectiveSandboxCallPolicy;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
    };

export type SandboxAuthorizationInput = ToolAuthorizationInput<
  PermissionExecutionContext
>;

export interface SandboxPolicy {
  readonly policy: SandboxPolicyDescriptor;

  preflight(
    input: SandboxAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<SandboxPreflightResult> | SandboxPreflightResult;

  revalidate(
    effective: EffectiveSandboxCallPolicy,
    input: SandboxAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<SandboxPreflightResult> | SandboxPreflightResult;
}
