import type {
  ToolAuthorizationGrant,
  ToolCapabilityRequest,
} from "./authorization.js";

export type ToolName = string;
export type ToolCallId = string;
export type ToolInputSchema = string;
export type ToolExecutionMode = "parallel" | "sequential";

/** Crash recovery is explicit and never inferred from execution mode. */
export type ToolRecoveryPolicy =
  | "retry-safe"
  | "resumable"
  | "needs-reconciliation"
  | "terminal-failed";

export type ToolExecutionPhase =
  | "received"
  | "prepared"
  | "authorized"
  | "dispatched"
  | "completed";

/** Transport-neutral location of one Tool execution inside a Runtime Step. */
export interface ToolExecutionScope {
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
}

/** Immutable authority captured before a model starts one Step. */
export interface ToolExecutionSnapshot {
  readonly schemaVersion: 1;
  readonly registryVersion: number;
  readonly authorityVersion: string;
  readonly availableTools: readonly ToolName[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Public, non-executable description exposed by the Registry. */
export interface ToolDescriptor {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchemaJson: ToolInputSchema;
  readonly executionMode: ToolExecutionMode;
  readonly recoveryPolicy: ToolRecoveryPolicy;
}

export interface ReadyToolCall<Input = unknown> {
  readonly status: "ready";
  readonly id: ToolCallId;
  readonly name: ToolName;
  readonly input: Input;
}

export interface InvalidToolCall {
  readonly status: "invalid";
  readonly id: ToolCallId;
  readonly name: ToolName;
  readonly error: ToolError;
}

/** Parsed call or a stable invalid call that must still receive one result. */
export type ToolCall<Input = unknown> = ReadyToolCall<Input> | InvalidToolCall;

/** Provider-neutral model output before Tool input parsing. */
export interface UnparsedToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly argumentsJson: string;
}

export type ToolErrorCode =
  | "not_found"
  | "permission_denied"
  | "invalid_input"
  | "timeout"
  | "aborted"
  | "conflict"
  | "execution_failed";

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly phase?: ToolExecutionPhase;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Opaque reference created by a Core-external result archive. */
export interface ToolResultArtifact {
  readonly kind: string;
  readonly locator: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ToolResult<Output = unknown> =
  | {
      readonly ok: true;
      readonly callId: ToolCallId;
      readonly toolName: ToolName;
      readonly output: Output;
      readonly phase: "completed";
      readonly artifact?: ToolResultArtifact;
    }
  | {
      readonly ok: false;
      readonly callId: ToolCallId;
      readonly toolName: ToolName;
      readonly error: ToolError;
      readonly phase: Exclude<ToolExecutionPhase, "completed"> | "completed";
      readonly artifact?: ToolResultArtifact;
    };

export type ToolInputParseResult<Input> =
  | { readonly ok: true; readonly input: Input }
  | { readonly ok: false; readonly message: string };

export type ToolCallParseResult<Input = unknown> =
  | { readonly ok: true; readonly call: ReadyToolCall<Input> }
  | { readonly ok: false; readonly call: InvalidToolCall };

/**
 * Concrete Tools live outside Core and register this definition. Core retains
 * parsing, authorization, dispatch, scheduling, and result lifecycle order.
 */
export interface ToolDefinition<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  Context = unknown,
> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchemaJson: ToolInputSchema;
  readonly executionMode: ToolExecutionMode;
  readonly recoveryPolicy?: ToolRecoveryPolicy;

  parse(input: Readonly<Record<string, unknown>>): ToolInputParseResult<Input>;

  resolveCapabilities(
    input: Input,
    context: Context,
    signal?: AbortSignal,
  ): Promise<ToolCapabilityRequest> | ToolCapabilityRequest;

  execute(
    input: Input,
    context: Context,
    grant: ToolAuthorizationGrant,
    signal?: AbortSignal,
  ): Promise<Output> | Output;
}

export function isReadyToolCall<Input = unknown>(
  call: ToolCall<Input>,
): call is ReadyToolCall<Input> {
  return call.status === "ready";
}
