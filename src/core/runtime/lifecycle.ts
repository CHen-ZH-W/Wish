import type {
  RunSnapshot,
  StepSnapshot,
  UserTurnSnapshot,
} from "./snapshot.js";
import type {
  RuntimeCancellation,
  RuntimeFailure,
} from "./state.js";
import type { RuntimeTransition } from "./transition.js";

export type RunCompletion<Result = unknown, Payload = unknown> =
  | {
      readonly status: "completed";
      readonly result: Result;
      readonly snapshot: RunSnapshot<Payload, Result>;
    }
  | {
      readonly status: "failed";
      readonly error: RuntimeFailure;
      readonly snapshot: RunSnapshot<Payload, Result>;
    }
  | {
      readonly status: "aborted";
      readonly cancellation: RuntimeCancellation;
      readonly snapshot: RunSnapshot<Payload, Result>;
    };

/** Lifecycle persistence Port. Concrete storage belongs outside Core. */
export interface RuntimeLifecycleService<Payload = unknown, Result = unknown> {
  openRun(snapshot: RunSnapshot<Payload, Result>): Promise<void> | void;
  finishRun(input: {
    readonly snapshot: RunSnapshot<Payload, Result>;
    readonly status: "completed" | "failed" | "aborted";
    readonly reason?: string;
  }): Promise<void> | void;
  openUserTurn(input: {
    readonly run: RunSnapshot<Payload, Result>;
    readonly userTurn: UserTurnSnapshot<Payload, Result>;
  }): Promise<void> | void;
  finishUserTurn(input: {
    readonly run: RunSnapshot<Payload, Result>;
    readonly userTurn: UserTurnSnapshot<Payload, Result>;
    readonly status: "completed" | "failed" | "aborted";
    readonly reason?: string;
  }): Promise<void> | void;
  openStep(snapshot: StepSnapshot<Payload>): Promise<void> | void;
  finishStep(input: {
    readonly snapshot: StepSnapshot<Payload>;
    readonly status: "completed" | "failed" | "aborted";
    readonly reason?: string;
  }): Promise<void> | void;
}

export const NOOP_RUNTIME_LIFECYCLE: RuntimeLifecycleService = Object.freeze({
  openRun() {},
  finishRun() {},
  openUserTurn() {},
  finishUserTurn() {},
  openStep() {},
  finishStep() {},
});

/** Diagnostic observers are ordered and fail-open. */
export interface RuntimeTransitionObserver<Payload = unknown, Result = unknown> {
  onTransition(
    transition: RuntimeTransition<Payload, Result>,
  ): Promise<void> | void;
}

export class RuntimeObserverPipeline<Payload, Result> {
  constructor(
    private readonly observers: readonly RuntimeTransitionObserver<
      Payload,
      Result
    >[],
  ) {}

  async emit(transition: RuntimeTransition<Payload, Result>): Promise<void> {
    for (const observer of this.observers) {
      try {
        await observer.onTransition(transition);
      } catch {
        // Observability cannot change a Runtime decision.
      }
    }
  }
}

/** Idempotent Run cancellation that preserves the first accepted cause. */
export class RunCancellation {
  private readonly controller = new AbortController();
  private current: RuntimeCancellation | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get value(): RuntimeCancellation | undefined {
    return this.current;
  }

  get cancelled(): boolean {
    return this.current !== undefined;
  }

  request(input: RuntimeCancellation): RuntimeCancellation {
    if (this.current !== undefined) return this.current;
    this.current = Object.freeze({ ...input });
    this.controller.abort(this.current);
    return this.current;
  }
}

export type StepRuntimeDecision =
  | { readonly type: "continue"; readonly reason: string }
  | { readonly type: "complete" }
  | { readonly type: "abort" }
  | { readonly type: "fail"; readonly error: RuntimeFailure };

export function decideAfterStep(input: {
  readonly outcome: "completed" | "continue" | "failed" | "aborted";
  readonly continuationReason?: string;
  readonly error?: RuntimeFailure;
  readonly pendingSteering: boolean;
  readonly hasRemainingStepBudget: boolean;
  readonly maxSteps: number;
}): StepRuntimeDecision {
  if (input.outcome === "aborted") return { type: "abort" };
  if (input.outcome === "failed") {
    return {
      type: "fail",
      error: input.error ?? runtimeFailure(
        "step_failed",
        "Step failed without an error",
        false,
      ),
    };
  }
  if (input.outcome === "continue") {
    if (!input.hasRemainingStepBudget) {
      return {
        type: "fail",
        error: runtimeFailure(
          "max_steps_exceeded",
          `UserTurn stopped after reaching maxSteps=${input.maxSteps}`,
          false,
        ),
      };
    }
    return {
      type: "continue",
      reason: input.pendingSteering
        ? "steering"
        : input.continuationReason ?? "pipeline",
    };
  }
  if (input.pendingSteering) {
    return input.hasRemainingStepBudget
      ? { type: "continue", reason: "steering" }
      : {
          type: "fail",
          error: runtimeFailure(
            "max_steps_exceeded",
            `UserTurn cannot deliver accepted steering after reaching maxSteps=${input.maxSteps}`,
            false,
          ),
        };
  }
  return { type: "complete" };
}

export type RunRuntimeDecision =
  | { readonly type: "start_next_turn" }
  | { readonly type: "wait" }
  | { readonly type: "complete_run" }
  | { readonly type: "abort_run" }
  | { readonly type: "fail_run"; readonly error: RuntimeFailure };

export function decideAfterUserTurn(input: {
  readonly cancelled: boolean;
  readonly error?: RuntimeFailure;
  readonly hasQueuedFollowUp: boolean;
  readonly hasCompletionHold: boolean;
}): RunRuntimeDecision {
  if (input.cancelled) return { type: "abort_run" };
  if (input.error !== undefined) {
    return { type: "fail_run", error: input.error };
  }
  if (input.hasQueuedFollowUp) return { type: "start_next_turn" };
  if (input.hasCompletionHold) return { type: "wait" };
  return { type: "complete_run" };
}

export function runtimeFailure(
  code: string,
  message: string,
  retryable: boolean,
  details?: Readonly<Record<string, unknown>>,
): RuntimeFailure {
  return Object.freeze({
    code,
    message,
    retryable,
    ...(details === undefined
      ? {}
      : {
          details: cloneAndFreezePlainValue(details) as Readonly<
            Record<string, unknown>
          >,
        }),
  });
}

export function unknownRuntimeFailure(error: unknown): RuntimeFailure {
  if (isRuntimeFailure(error)) {
    return runtimeFailure(
      error.code,
      error.message,
      error.retryable,
      error.details,
    );
  }
  return runtimeFailure(
    "runtime_error",
    error instanceof Error ? error.message : "Unknown Runtime failure",
    false,
  );
}

function isRuntimeFailure(value: unknown): value is RuntimeFailure {
  return value !== null &&
    typeof value === "object" &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean";
}

function cloneAndFreezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezePlainValue));
  }
  if (isPlainRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          cloneAndFreezePlainValue(item),
        ]),
      ),
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
