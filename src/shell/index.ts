export {
  ShellError,
  ShellExecutionFailedError,
  ShellInvalidInputError,
  ShellPermissionDeniedError,
  ShellPolicyMismatchError,
  ShellUnavailableError,
} from "./errors.js";
export type { ShellErrorCode } from "./errors.js";
export { ShellService } from "./service.js";
export { createUnavailableShell } from "./unavailable.js";
export type {
  ResolveShellCommandRequest,
  RunShellCommandRequest,
  Shell,
  ShellCommandPreflight,
  ShellBackendKind,
  ShellCommandSpec,
  ShellExecutionContext,
  ShellExecutionResult,
  ShellPolicy,
  ShellResourceLimits,
  PreflightShellCommandRequest,
} from "./types.js";
