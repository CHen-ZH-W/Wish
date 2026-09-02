import {
  issueToolAuthorizationGrant,
  withActiveToolAuthorizationGrant,
  type ToolAuthorizationDecision,
  type ToolAuthorizationGrant,
  type ToolAuthorizationInput,
  type ToolAuthorizationService,
  type ToolAuthorizationValidation,
  type ToolCapabilityRequest,
  type ToolClock,
} from "./authorization.js";
import { ToolRegistry } from "./registry.js";
import type {
  ReadyToolCall,
  ToolCall,
  ToolDescriptor,
  ToolError,
  ToolErrorCode,
  ToolExecutionMode,
  ToolExecutionPhase,
  ToolExecutionScope,
  ToolExecutionSnapshot,
  ToolResult,
} from "./tool.js";

export interface ToolExecutionInput<Context = unknown> {
  readonly call: ToolCall;
  readonly context: Context;
  readonly scope: ToolExecutionScope;
  readonly snapshot: ToolExecutionSnapshot;
  readonly signal?: AbortSignal;
  /** Step-local diagnostic sink, normally bound to the owning Runtime Run. */
  readonly events?: ToolEventPublisher;
}

export type ToolExecutionEvent =
  | ToolExecutionEventBase<"tool.queued">
  | ToolExecutionEventBase<"tool.prepared">
  | ToolExecutionEventBase<"tool.authorization_requested"> & {
      readonly capabilities: ToolCapabilityRequest;
    }
  | ToolExecutionEventBase<"tool.authorization_denied"> & {
      readonly reason: string;
    }
  | ToolExecutionEventBase<"tool.dispatched"> & {
      readonly grantId: string;
    }
  | ToolExecutionEventBase<"tool.completed"> & {
      readonly result: Extract<ToolResult, { readonly ok: true }>;
    }
  | ToolExecutionEventBase<"tool.failed"> & {
      readonly result: Extract<ToolResult, { readonly ok: false }>;
    }
  | ToolExecutionEventBase<"tool.aborted"> & {
      readonly result: Extract<ToolResult, { readonly ok: false }>;
    };

interface ToolExecutionEventBase<Type extends string> {
  readonly type: Type;
  readonly occurredAt: string;
  readonly scope: ToolExecutionScope;
  readonly call: ToolCall;
}

/** Diagnostic event Port. Publisher failures never change execution decisions. */
export interface ToolEventPublisher {
  publish(event: ToolExecutionEvent): Promise<void> | void;
}

/** Authoritative lifecycle Port. Failure prevents or fails the call. */
export interface ToolExecutionLifecycle<Context = unknown> {
  prepare(input: {
    readonly call: ToolCall;
    readonly descriptor?: ToolDescriptor;
    readonly context: Context;
    readonly scope: ToolExecutionScope;
    readonly snapshot: ToolExecutionSnapshot;
  }): Promise<void> | void;

  markDispatched(input: {
    readonly call: ReadyToolCall;
    readonly descriptor: ToolDescriptor;
    readonly context: Context;
    readonly scope: ToolExecutionScope;
    readonly snapshot: ToolExecutionSnapshot;
    readonly grant: ToolAuthorizationGrant;
  }): Promise<void> | void;

  finish(input: {
    readonly call: ToolCall;
    readonly descriptor?: ToolDescriptor;
    readonly context: Context;
    readonly scope: ToolExecutionScope;
    readonly snapshot: ToolExecutionSnapshot;
    readonly result: ToolResult;
  }): Promise<void> | void;
}

export const NOOP_TOOL_EXECUTION_LIFECYCLE: ToolExecutionLifecycle = Object.freeze({
  prepare() {},
  markDispatched() {},
  finish() {},
});

export interface ToolExecutorOptions<Context = unknown> {
  readonly registry: ToolRegistry<Context>;
  readonly authorization: ToolAuthorizationService<Context>;
  readonly lifecycle?: ToolExecutionLifecycle<Context>;
  readonly events?: ToolEventPublisher;
  readonly grantTtlMs?: number;
  readonly grantId?: () => string;
  readonly clock?: ToolClock;
}

const SYSTEM_TOOL_CLOCK: ToolClock = Object.freeze({
  now: () => new Date(),
});

/** Error helper for concrete Tools that need a stable operational failure. */
export class ToolExecutionError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

/** Owns the complete lifecycle of one Tool call. */
export class ToolExecutor<Context = unknown> {
  private readonly lifecycle: ToolExecutionLifecycle<Context>;
  private readonly grantTtlMs: number;
  private readonly grantId: () => string;
  private readonly clock: ToolClock;

  constructor(private readonly options: ToolExecutorOptions<Context>) {
    this.lifecycle = options.lifecycle ??
      (NOOP_TOOL_EXECUTION_LIFECYCLE as ToolExecutionLifecycle<Context>);
    this.grantTtlMs = positiveInteger(options.grantTtlMs, 60_000, "grantTtlMs");
    this.grantId = options.grantId ?? randomId;
    this.clock = options.clock ?? SYSTEM_TOOL_CLOCK;
  }

  executionMode(call: ToolCall): ToolExecutionMode {
    return this.options.registry.executionMode(call);
  }

  /** Scheduler-owned intake notification routed through the same Event Port. */
  async recordQueued(
    input: Pick<ToolExecutionInput<Context>, "call" | "scope" | "events">,
  ): Promise<void> {
    await this.emit({
      type: "tool.queued",
      occurredAt: this.timestamp(),
      scope: freezeScope(input.scope),
      call: freezeToolCall(input.call),
    }, input.events);
  }

  async execute(input: ToolExecutionInput<Context>): Promise<ToolResult> {
    const call = freezeToolCall(input.call);
    const scope = freezeScope(input.scope);
    const snapshot = freezeSnapshot(input.snapshot);
    const descriptor = this.options.registry.describe(call.name);
    let phase: ToolExecutionPhase = "received";
    let prepared = false;
    let result: ToolResult;

    try {
      await this.lifecycle.prepare({
        call,
        ...(descriptor === undefined ? {} : { descriptor }),
        context: input.context,
        scope,
        snapshot,
      });
      prepared = true;
      phase = "prepared";
      await this.emit({
        type: "tool.prepared",
        occurredAt: this.timestamp(),
        scope,
        call,
      }, input.events);

      if (isAborted(input.signal)) {
        result = abortedResult(call, phase, input.signal?.reason);
      } else if (call.status === "invalid") {
        result = failedResult(call, call.error, phase);
      } else if (descriptor === undefined) {
        result = failedResult(
          call,
          toolError("not_found", `Tool "${call.name}" is not registered`, false, phase),
          phase,
        );
      } else {
        const snapshotDenial = this.snapshotDenial(call, snapshot);
        result = snapshotDenial === undefined
          ? await this.authorizeAndDispatch({
              call,
              descriptor,
              context: input.context,
              scope,
              snapshot,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              ...(input.events === undefined ? {} : { events: input.events }),
            })
          : failedResult(
              call,
              toolError("permission_denied", snapshotDenial, false, phase),
              phase,
            );
      }
    } catch (error: unknown) {
      result = failedResult(call, errorToToolError(error, phase), phase);
    }

    if (prepared) {
      try {
        await this.lifecycle.finish({
          call,
          ...(descriptor === undefined ? {} : { descriptor }),
          context: input.context,
          scope,
          snapshot,
          result,
        });
      } catch (error: unknown) {
        result = failedResult(
          call,
          toolError(
            "execution_failed",
            error instanceof Error
              ? `Tool lifecycle finish failed: ${error.message}`
              : "Tool lifecycle finish failed",
            false,
            result.phase,
          ),
          result.phase,
        );
      }
    }

    result = freezeToolResult(result);
    await this.emitTerminal(scope, call, result, input.events);
    return result;
  }

  private async authorizeAndDispatch(input: {
    readonly call: ReadyToolCall;
    readonly descriptor: ToolDescriptor;
    readonly context: Context;
    readonly scope: ToolExecutionScope;
    readonly snapshot: ToolExecutionSnapshot;
    readonly signal?: AbortSignal;
    readonly events?: ToolEventPublisher;
  }): Promise<ToolResult> {
    let phase: ToolExecutionPhase = "prepared";
    try {
      const capabilities = this.options.registry.resolveCapabilities(
        input.call,
        input.context,
      );
      const authorizationInput: ToolAuthorizationInput<Context> = Object.freeze({
        call: input.call,
        descriptor: input.descriptor,
        capabilities,
        context: input.context,
        scope: input.scope,
        snapshot: input.snapshot,
      });
      await this.emit({
        type: "tool.authorization_requested",
        occurredAt: this.timestamp(),
        scope: input.scope,
        call: input.call,
        capabilities,
      }, input.events);
      const decision = validateAuthorizationDecision(
        await this.options.authorization.authorize(
          authorizationInput,
          input.signal,
        ),
      );
      if (isAborted(input.signal)) {
        return abortedResult(input.call, phase, input.signal?.reason);
      }
      if (decision.status === "denied") {
        await this.emitAuthorizationDenied(input, decision.reason, input.events);
        return failedResult(
          input.call,
          toolError("permission_denied", decision.reason, false, phase),
          phase,
        );
      }

      phase = "authorized";
      const validation = validateAuthorizationValidation(
        await this.options.authorization.revalidate(
          Object.freeze({ ...authorizationInput, decision }),
          input.signal,
        ),
      );
      if (isAborted(input.signal)) {
        return abortedResult(input.call, phase, input.signal?.reason);
      }
      if (validation.status === "denied") {
        await this.emitAuthorizationDenied(input, validation.reason, input.events);
        return failedResult(
          input.call,
          toolError("permission_denied", validation.reason, false, phase),
          phase,
        );
      }
      if (validation.policyVersion !== decision.policyVersion) {
        const reason = `Tool "${input.call.name}" authorization became stale before dispatch`;
        await this.emitAuthorizationDenied(input, reason, input.events);
        return failedResult(
          input.call,
          toolError("permission_denied", reason, false, phase),
          phase,
        );
      }

      const grantId = requireIdentifier(this.grantId(), "Tool Grant id");
      const issuedAtEpochMs = this.clockEpochMilliseconds();
      const finalSnapshotDenial = this.snapshotDenial(input.call, input.snapshot);
      if (finalSnapshotDenial !== undefined) {
        await this.emitAuthorizationDenied(
          input,
          finalSnapshotDenial,
          input.events,
        );
        return failedResult(
          input.call,
          toolError(
            "permission_denied",
            finalSnapshotDenial,
            false,
            phase,
          ),
          phase,
        );
      }
      const grant = issueToolAuthorizationGrant({
        grantId,
        call: input.call,
        capabilities,
        policyVersion: validation.policyVersion,
        snapshot: input.snapshot,
        clock: this.clock,
        issuedAtEpochMs,
        ttlMs: this.grantTtlMs,
        ...(decision.metadata === undefined ? {} : { metadata: decision.metadata }),
      });

      if (isAborted(input.signal)) {
        return abortedResult(input.call, phase, input.signal?.reason);
      }
      await this.lifecycle.markDispatched({
        call: input.call,
        descriptor: input.descriptor,
        context: input.context,
        scope: input.scope,
        snapshot: input.snapshot,
        grant,
      });
      phase = "dispatched";
      const postLifecycleDenial = this.snapshotDenial(input.call, input.snapshot);
      if (postLifecycleDenial !== undefined) {
        return failedResult(
          input.call,
          toolError(
            "permission_denied",
            postLifecycleDenial,
            false,
            phase,
          ),
          phase,
        );
      }
      if (isAborted(input.signal)) {
        return abortedResult(input.call, phase, input.signal?.reason);
      }
      await this.emit({
        type: "tool.dispatched",
        occurredAt: this.timestamp(),
        scope: input.scope,
        call: input.call,
        grantId: grant.grantId,
      }, input.events);

      const preExecutionDenial = this.snapshotDenial(input.call, input.snapshot);
      if (preExecutionDenial !== undefined) {
        return failedResult(
          input.call,
          toolError(
            "permission_denied",
            preExecutionDenial,
            false,
            phase,
          ),
          phase,
        );
      }
      if (isAborted(input.signal)) {
        return abortedResult(input.call, phase, input.signal?.reason);
      }

      const output = await withActiveToolAuthorizationGrant(
        grant,
        () => this.options.registry.execute(
          input.call,
          input.context,
          grant,
          input.signal,
        ),
      );
      return Object.freeze({
        ok: true as const,
        callId: input.call.id,
        toolName: input.call.name,
        output: deepFreezePlainValue(output),
        phase: "completed" as const,
      });
    } catch (error: unknown) {
      return isAborted(input.signal)
        ? abortedResult(input.call, phase, input.signal?.reason)
        : failedResult(input.call, errorToToolError(error, phase), phase);
    }
  }

  private snapshotDenial(
    call: ReadyToolCall,
    snapshot: ToolExecutionSnapshot,
  ): string | undefined {
    if (snapshot.registryVersion !== this.options.registry.version) {
      return `Tool "${call.name}" registry changed after this Step snapshot`;
    }
    if (!snapshot.availableTools.includes(call.name)) {
      return `Tool "${call.name}" was not available in this Step snapshot`;
    }
    return undefined;
  }

  private async emitAuthorizationDenied(
    input: {
      readonly call: ReadyToolCall;
      readonly scope: ToolExecutionScope;
    },
    reason: string,
    events?: ToolEventPublisher,
  ): Promise<void> {
    await this.emit({
      type: "tool.authorization_denied",
      occurredAt: this.timestamp(),
      scope: input.scope,
      call: input.call,
      reason,
    }, events);
  }

  private async emitTerminal(
    scope: ToolExecutionScope,
    call: ToolCall,
    result: ToolResult,
    events?: ToolEventPublisher,
  ): Promise<void> {
    if (result.ok) {
      await this.emit({
        type: "tool.completed",
        occurredAt: this.timestamp(),
        scope,
        call,
        result,
      }, events);
    } else if (result.error.code === "aborted") {
      await this.emit({
        type: "tool.aborted",
        occurredAt: this.timestamp(),
        scope,
        call,
        result,
      }, events);
    } else {
      await this.emit({
        type: "tool.failed",
        occurredAt: this.timestamp(),
        scope,
        call,
        result,
      }, events);
    }
  }

  private async emit(
    event: ToolExecutionEvent,
    localEvents?: ToolEventPublisher,
  ): Promise<void> {
    const frozen = Object.freeze(event);
    const publishers = this.options.events === localEvents
      ? [localEvents]
      : [localEvents, this.options.events];
    for (const publisher of publishers) {
      if (publisher === undefined) continue;
      try {
        await publisher.publish(frozen);
      } catch {
        // Diagnostic output cannot alter Tool execution state.
      }
    }
  }

  private timestamp(): string {
    return new Date(this.clockEpochMilliseconds()).toISOString();
  }

  private clockEpochMilliseconds(): number {
    const now = this.clock.now();
    if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) {
      throw new Error("Tool clock now() must return a valid Date");
    }
    return now.getTime();
  }
}

function validateAuthorizationDecision(
  decision: ToolAuthorizationDecision,
): ToolAuthorizationDecision {
  if (decision?.status === "denied") {
    return Object.freeze({
      status: "denied" as const,
      reason: requireText(decision.reason, "Authorization denial reason"),
    });
  }
  if (decision?.status === "allowed") {
    return Object.freeze({
      status: "allowed" as const,
      policyVersion: requireIdentifier(decision.policyVersion, "Policy version"),
      ...(decision.metadata === undefined
        ? {}
        : {
            metadata: deepFreezePlainValue({ ...decision.metadata }) as Readonly<
              Record<string, unknown>
            >,
          }),
    });
  }
  throw new Error("Tool authorization returned an unknown decision");
}

function validateAuthorizationValidation(
  validation: ToolAuthorizationValidation,
): ToolAuthorizationValidation {
  if (validation?.status === "denied") {
    return Object.freeze({
      status: "denied" as const,
      reason: requireText(validation.reason, "Authorization denial reason"),
    });
  }
  if (validation?.status === "valid") {
    return Object.freeze({
      status: "valid" as const,
      policyVersion: requireIdentifier(validation.policyVersion, "Policy version"),
    });
  }
  throw new Error("Tool authorization returned an unknown revalidation");
}

function abortedResult(
  call: ToolCall,
  phase: ToolExecutionPhase,
  reason: unknown,
): Extract<ToolResult, { readonly ok: false }> {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason.length > 0
      ? reason
      : "Tool call was aborted";
  return failedResult(call, toolError("aborted", message, false, phase), phase);
}

function failedResult(
  call: ToolCall,
  error: ToolError,
  phase: ToolExecutionPhase,
): Extract<ToolResult, { readonly ok: false }> {
  return Object.freeze({
    ok: false as const,
    callId: call.id,
    toolName: call.name,
    error: Object.freeze({ ...error, phase: error.phase ?? phase }),
    phase,
  });
}

function toolError(
  code: ToolErrorCode,
  message: string,
  retryable: boolean,
  phase: ToolExecutionPhase,
  details?: Readonly<Record<string, unknown>>,
): ToolError {
  return Object.freeze({
    code,
    message,
    retryable,
    phase,
    ...(details === undefined ? {} : { details: Object.freeze({ ...details }) }),
  });
}

function errorToToolError(error: unknown, phase: ToolExecutionPhase): ToolError {
  if (error instanceof ToolExecutionError) {
    return toolError(error.code, error.message, error.retryable, phase, error.details);
  }
  return toolError(
    "execution_failed",
    error instanceof Error ? error.message : "Unknown Tool execution failure",
    false,
    phase,
  );
}

function freezeToolCall(call: ToolCall): ToolCall {
  const id = requireIdentifier(call.id, "Tool call id");
  const name = requireIdentifier(call.name, "Tool name");
  if (call.status === "invalid") {
    return Object.freeze({
      status: "invalid" as const,
      id,
      name,
      error: Object.freeze({ ...call.error }),
    });
  }
  if (call.status !== "ready") throw new Error("Unknown Tool call status");
  return Object.freeze({
    status: "ready" as const,
    id,
    name,
    input: deepFreezePlainValue(call.input),
  });
}

function freezeScope(scope: ToolExecutionScope): ToolExecutionScope {
  return Object.freeze({
    runId: requireIdentifier(scope.runId, "Run id"),
    userTurnId: requireIdentifier(scope.userTurnId, "UserTurn id"),
    stepId: requireIdentifier(scope.stepId, "Step id"),
  });
}

function freezeSnapshot(snapshot: ToolExecutionSnapshot): ToolExecutionSnapshot {
  if (snapshot.schemaVersion !== 1) {
    throw new Error("Unknown Tool execution snapshot schemaVersion");
  }
  if (!Number.isSafeInteger(snapshot.registryVersion) || snapshot.registryVersion < 0) {
    throw new Error("Tool registryVersion must be a non-negative safe integer");
  }
  const availableTools = snapshot.availableTools.map((name) =>
    requireIdentifier(name, "Available Tool name")
  );
  if (new Set(availableTools).size !== availableTools.length) {
    throw new Error("Tool execution snapshot contains duplicate availableTools");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    registryVersion: snapshot.registryVersion,
    authorityVersion: requireIdentifier(
      snapshot.authorityVersion,
      "Authority version",
    ),
    availableTools: Object.freeze(availableTools),
    ...(snapshot.metadata === undefined
      ? {}
      : {
          metadata: deepFreezePlainValue({ ...snapshot.metadata }) as Readonly<
            Record<string, unknown>
          >,
        }),
  });
}

function freezeToolResult(result: ToolResult): ToolResult {
  return deepFreezePlainValue({ ...result }) as ToolResult;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  return value;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

function randomId(): string {
  if (globalThis.crypto?.randomUUID === undefined) {
    throw new Error("ToolExecutor requires an injected Grant id generator");
  }
  return globalThis.crypto.randomUUID();
}

function deepFreezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezePlainValue));
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepFreezePlainValue(item)]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
