import {
  ToolExecutor,
  type ToolEventPublisher,
} from "./executor.js";
import type {
  InvalidToolCall,
  ToolCall,
  ToolExecutionScope,
  ToolExecutionSnapshot,
  ToolResult,
} from "./tool.js";

export { ToolRegistry } from "./registry.js";
export type {
  CaptureToolExecutionSnapshotInput,
  ToolRegistration,
} from "./registry.js";
export {
  assertActiveToolAuthorizationGrant,
  normalizeToolCapabilityRequest,
  toolCapabilityRequestDigest,
} from "./authorization.js";
export type {
  ToolAuthorizationDecision,
  ToolAuthorizationGrant,
  ToolAuthorizationGrantExpectation,
  ToolAuthorizationInput,
  ToolAuthorizationService,
  ToolAuthorizationValidation,
  ToolCapabilityKind,
  ToolCapabilityRequest,
  ToolCapabilityRequirement,
  ToolClock,
} from "./authorization.js";
export {
  NOOP_TOOL_EXECUTION_LIFECYCLE,
  ToolExecutionError,
  ToolExecutor,
} from "./executor.js";
export type {
  ToolEventPublisher,
  ToolExecutionEvent,
  ToolExecutionInput,
  ToolExecutionLifecycle,
  ToolExecutorOptions,
} from "./executor.js";
export { isReadyToolCall } from "./tool.js";
export type {
  InvalidToolCall,
  ReadyToolCall,
  ToolCall,
  ToolCallId,
  ToolCallParseResult,
  ToolDefinition,
  ToolDescriptor,
  ToolError,
  ToolErrorCode,
  ToolExecutionMode,
  ToolExecutionPhase,
  ToolExecutionScope,
  ToolExecutionSnapshot,
  ToolInputParseResult,
  ToolInputSchema,
  ToolName,
  ToolRecoveryPolicy,
  ToolResult,
  ToolResultArtifact,
  UnparsedToolCall,
} from "./tool.js";

export interface ToolScheduleInput<Context = unknown> {
  readonly context: Context;
  readonly scope: ToolExecutionScope;
  readonly snapshot: ToolExecutionSnapshot;
  readonly signal?: AbortSignal;
  /** Step-local diagnostic sink forwarded to every submitted call. */
  readonly events?: ToolEventPublisher;
}

export interface ToolBatchScheduleInput<Context = unknown>
  extends ToolScheduleInput<Context> {
  readonly calls: readonly ToolCall[];
}

export interface ToolScheduleSession {
  /** Accepts complete calls while a model stream is still arriving. */
  submit(call: ToolCall): Promise<ToolResult>;
  /** Seals intake and resolves every result in original submission order. */
  close(): Promise<readonly ToolResult[]>;
}

export interface ToolScheduler<Context = unknown> {
  begin(input: ToolScheduleInput<Context>): ToolScheduleSession;
  schedule(input: ToolBatchScheduleInput<Context>): Promise<readonly ToolResult[]>;
}

export interface BoundedToolSchedulerOptions<Context = unknown> {
  readonly executor: ToolExecutor<Context>;
  readonly maxParallelCalls?: number;
}

/**
 * Step-local scheduler with bounded parallelism and strict sequential barriers.
 * No submitted call is omitted, and result order never follows completion time.
 */
export class BoundedToolScheduler<Context = unknown>
  implements ToolScheduler<Context> {
  readonly parallelLimit: number;

  constructor(private readonly options: BoundedToolSchedulerOptions<Context>) {
    this.parallelLimit = positiveInteger(
      options.maxParallelCalls,
      8,
      "maxParallelCalls",
    );
  }

  begin(input: ToolScheduleInput<Context>): ToolScheduleSession {
    return new BoundedToolScheduleSession(this, input);
  }

  async schedule(
    input: ToolBatchScheduleInput<Context>,
  ): Promise<readonly ToolResult[]> {
    const session = this.begin(input);
    for (const call of input.calls) void session.submit(call);
    return session.close();
  }

  executionMode(call: ToolCall): "parallel" | "sequential" {
    return this.options.executor.executionMode(call);
  }

  execute(call: ToolCall, input: ToolScheduleInput<Context>): Promise<ToolResult> {
    return this.options.executor.execute({
      call,
      context: input.context,
      scope: input.scope,
      snapshot: input.snapshot,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.events === undefined ? {} : { events: input.events }),
    });
  }

  publishQueued(
    call: ToolCall,
    scope: ToolExecutionScope,
    events?: ToolEventPublisher,
  ): Promise<void> {
    return this.options.executor.recordQueued({
      scope,
      call,
      ...(events === undefined ? {} : { events }),
    });
  }
}

interface PendingToolCall {
  readonly index: number;
  readonly call: ToolCall;
  readonly parallel: boolean;
  readonly queued: Promise<void>;
  readonly resolve: (result: ToolResult) => void;
}

class BoundedToolScheduleSession<Context> implements ToolScheduleSession {
  private readonly pending: PendingToolCall[] = [];
  private readonly results: ToolResult[] = [];
  private readonly callIds = new Set<string>();
  private active = 0;
  private nextIndex = 0;
  private sequentialActive = false;
  private sealed = false;
  private settled = false;
  private readonly completion: Promise<readonly ToolResult[]>;
  private resolveCompletion: (results: readonly ToolResult[]) => void = () => {};
  private readonly onAbort = (): void => this.pump();

  constructor(
    private readonly scheduler: BoundedToolScheduler<Context>,
    private readonly input: ToolScheduleInput<Context>,
  ) {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
    input.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  submit(originalCall: ToolCall): Promise<ToolResult> {
    if (this.sealed) throw new Error("Tool schedule session is already sealed");
    const call = this.normalizeCall(originalCall);
    let resolveResult: (result: ToolResult) => void = () => {};
    const result = new Promise<ToolResult>((resolve) => {
      resolveResult = resolve;
    });
    const queued = this.scheduler.publishQueued(
      call,
      this.input.scope,
      this.input.events,
    );
    this.pending.push({
      index: this.nextIndex,
      call,
      parallel: this.scheduler.executionMode(call) === "parallel",
      queued,
      resolve: resolveResult,
    });
    this.nextIndex += 1;
    this.pump();
    return result;
  }

  close(): Promise<readonly ToolResult[]> {
    if (!this.sealed) {
      this.sealed = true;
      this.pump();
      this.finishIfReady();
    }
    return this.completion;
  }

  private normalizeCall(call: ToolCall): ToolCall {
    if (!this.callIds.has(call.id)) {
      this.callIds.add(call.id);
      return call;
    }
    const duplicate: InvalidToolCall = Object.freeze({
      status: "invalid" as const,
      id: call.id,
      name: call.name,
      error: Object.freeze({
        code: "invalid_input" as const,
        message: `Tool call id "${call.id}" is duplicated in one Step`,
        retryable: false,
        phase: "received" as const,
      }),
    });
    return duplicate;
  }

  private pump(): void {
    if (this.settled || this.sequentialActive) return;
    while (this.active < this.scheduler.parallelLimit) {
      const next = this.pending[0];
      if (next === undefined) {
        this.finishIfReady();
        return;
      }
      if (!next.parallel) {
        if (this.active > 0) return;
        this.pending.shift();
        this.sequentialActive = true;
        this.launch(next);
        return;
      }
      this.pending.shift();
      this.launch(next);
    }
  }

  private launch(entry: PendingToolCall): void {
    this.active += 1;
    void entry.queued
      .then(() => this.scheduler.execute(entry.call, this.input))
      .catch((error: unknown) => unexpectedFailure(entry.call, error))
      .then((result) => {
        this.results[entry.index] = result;
        entry.resolve(result);
      })
      .finally(() => {
        this.active -= 1;
        if (!entry.parallel) this.sequentialActive = false;
        this.pump();
        this.finishIfReady();
      });
  }

  private finishIfReady(): void {
    if (
      this.settled ||
      !this.sealed ||
      this.pending.length > 0 ||
      this.active > 0
    ) {
      return;
    }
    this.settled = true;
    this.input.signal?.removeEventListener("abort", this.onAbort);
    this.resolveCompletion(Object.freeze([...this.results]));
  }
}

function unexpectedFailure(call: ToolCall, error: unknown): ToolResult {
  return Object.freeze({
    ok: false as const,
    callId: call.id,
    toolName: call.name,
    phase: "received" as const,
    error: Object.freeze({
      code: "execution_failed" as const,
      message: error instanceof Error ? error.message : "Tool scheduler failed",
      retryable: false,
      phase: "received" as const,
    }),
  });
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
