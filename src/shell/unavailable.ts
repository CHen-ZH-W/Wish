import { ShellUnavailableError } from "./errors.js";
import type {
  ResolveShellCommandRequest,
  RunShellCommandRequest,
  Shell,
  ShellCommandPreflight,
  ShellCommandSpec,
  ShellExecutionResult,
  PreflightShellCommandRequest,
} from "./types.js";

/** Fail-closed placeholder used only by explicit standalone compositions. */
export function createUnavailableShell(
  reason = "No Shell Provider was supplied",
): Shell {
  const unavailable = (): ShellUnavailableError =>
    new ShellUnavailableError(reason);
  return Object.freeze({
    policy: Object.freeze({
      schemaVersion: 1 as const,
      version: "shell-unavailable-v1",
      backend: "unavailable" as const,
      filesystem: "none" as const,
      network: "none" as const,
      environment: "clean" as const,
      automaticPermissionProfiles: Object.freeze([]),
      resourceLimits: Object.freeze({
        maxProcesses: 1,
        maxOpenFiles: 1,
        maxFileSizeBytes: 1,
        maxMemoryBytes: 1,
        maxTimeoutSeconds: 1,
      }),
      filesystemPolicyVersion: "filesystem-unavailable-v1",
    }),
    preflight(
      _request: PreflightShellCommandRequest,
    ): Promise<ShellCommandPreflight> {
      return Promise.reject(unavailable());
    },
    resolve(_request: ResolveShellCommandRequest): Promise<ShellCommandSpec> {
      return Promise.reject(unavailable());
    },
    run(_request: RunShellCommandRequest): Promise<ShellExecutionResult> {
      return Promise.reject(unavailable());
    },
  });
}
