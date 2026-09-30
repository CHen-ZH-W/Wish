import type {
  AgentDefinition,
  AgentProtocol,
  AgentRunId,
  ObserveOptions,
  RunHandle,
  RunInput,
  UserTurnId,
} from "../agent/types.js";
import {
  RuntimeEventStream,
  type OutputEvent,
  type StepOutputPublisher,
} from "../events/event.js";
import {
  createRuntimeControlMessage,
  DEFAULT_STEP_INBOX_LIMITS,
  DEFAULT_TURN_QUEUE_LIMITS,
  NextStepInbox,
  NextTurnQueue,
  type RuntimeControl,
  type RuntimeControlKind,
  type RuntimeControlReceipt,
  type RuntimeControlReceiptReason,
  type RuntimeMailboxLimits,
} from "./control.js";
import {
  decideAfterStep,
  decideAfterUserTurn,
  NOOP_RUNTIME_LIFECYCLE,
  RunCancellation,
  RuntimeObserverPipeline,
  runtimeFailure,
  unknownRuntimeFailure,
  type RunCompletion,
  type RuntimeLifecycleService,
  type RuntimeTransitionObserver,
} from "./lifecycle.js";
import {
  captureStepSnapshot,
  snapshotRun,
  snapshotUserTurn,
  type RunSnapshot,
  type RuntimeEnvironment,
  type StepSnapshot,
  type UserTurnSnapshot,
} from "./snapshot.js";
import {
  createRunState,
  currentStep,
  currentUserTurn,
  isRunTerminal,
  type RunState,
  type RuntimeCancellation,
  type RuntimeFailure,
  type UserTurnProvenance,
} from "./state.js";
import {
  applyRuntimeTransition,
  freezeRuntimeTransition,
  type RuntimeTransition,
} from "./transition.js";

export {
  createRuntimeControlMessage,
  DEFAULT_STEP_INBOX_LIMITS,
  DEFAULT_TURN_QUEUE_LIMITS,
  NextStepInbox,
  NextTurnQueue,
} from "./control.js";
export type {
  AbortControl,
  FollowUpControl,
  RuntimeControl,
  RuntimeControlDisposition,
  RuntimeControlKind,
  RuntimeControlMessage,
  RuntimeControlReceipt,
  RuntimeControlReceiptReason,
  RuntimeControlRecord,
  RuntimeMailboxLimits,
  SteerControl,
} from "./control.js";
export {
  decideAfterStep,
  decideAfterUserTurn,
  NOOP_RUNTIME_LIFECYCLE,
  RunCancellation,
  runtimeFailure,
  unknownRuntimeFailure,
} from "./lifecycle.js";
export type {
  RunCompletion,
  RunRuntimeDecision,
  RuntimeLifecycleService,
  RuntimeTransitionObserver,
  StepRuntimeDecision,
} from "./lifecycle.js";
export {
  captureStepSnapshot,
  snapshotRun,
  snapshotUserTurn,
} from "./snapshot.js";
export type {
  RunSnapshot,
  RuntimeEnvironment,
  StepSnapshot,
  UserTurnSnapshot,
} from "./snapshot.js";
export {
  createRunState,
  currentStep,
  currentUserTurn,
  isRunTerminal,
  isStepTerminal,
  isUserTurnTerminal,
} from "./state.js";
export type {
  AgentStepId,
  RunState,
  RunStatus,
  RuntimeCancellation,
  RuntimeFailure,
  StepState,
  StepStatus,
  UserTurnState,
  UserTurnStatus,
  UserTurnProvenance,
} from "./state.js";
export {
  applyRuntimeTransition,
  freezeRuntimeTransition,
} from "./transition.js";
export type { RuntimeTransition } from "./transition.js";

export interface RuntimeAgentProtocol<
  Configuration = unknown,
  Payload = unknown,
  Result = unknown,
> extends AgentProtocol {
  readonly definitionConfiguration: Configuration;
  readonly runPayload: Payload;
  readonly control: RuntimeControl<Payload>;
  readonly controlReceipt: RuntimeControlReceipt;
  readonly outputEvent: OutputEvent<RuntimeTransition<Payload, Result>>;
  readonly completion: RunCompletion<Result, Payload>;
}

export interface StepPipelineInput<Configuration, Payload, StepMemory> {
  readonly definition: AgentDefinition<Configuration>;
  readonly snapshot: StepSnapshot<Payload>;
  readonly memory: StepMemory | undefined;
  readonly signal: AbortSignal;
  /** Runtime-bound channel for this Step's model and Tool output. */
  readonly output: StepOutputPublisher;
}

export type StepPipelineResult<StepMemory, Result> =
  | {
      readonly status: "continue";
      readonly reason: string;
      readonly memory: StepMemory;
    }
  | {
      readonly status: "completed";
      readonly result: Result;
      readonly memory?: StepMemory;
    }
  | {
      readonly status: "failed";
      readonly error: RuntimeFailure;
    }
  | {
      readonly status: "aborted";
      readonly reason?: string;
    };

/** One inner-loop iteration. Model, Context, and Tool composition plugs in here. */
export interface StepPipeline<Configuration, Payload, StepMemory, Result> {
  execute(
    input: StepPipelineInput<Configuration, Payload, StepMemory>,
  ): Promise<StepPipelineResult<StepMemory, Result>>;
}

/** Execution resources pinned from before Step capture through durable Step finish. */
export interface StepPipelineLease<Configuration, Payload, StepMemory, Result> {
  readonly pipeline: StepPipeline<Configuration, Payload, StepMemory, Result>;
  /** Synchronous, idempotent release; no background work may outlive this lease. */
  release(): void;
}

/** Optional dynamic composition seam. The source never owns Run state or queues. */
export interface StepPipelineSource<Configuration, Payload, StepMemory, Result> {
  acquire(input: { readonly signal: AbortSignal }):
    | StepPipelineLease<Configuration, Payload, StepMemory, Result>
    | Promise<StepPipelineLease<Configuration, Payload, StepMemory, Result>>;
}

export interface StepSnapshotProvider<Configuration, Payload, Result> {
  capture(input: {
    readonly definition: AgentDefinition<Configuration>;
    readonly run: RunSnapshot<Payload, Result>;
    readonly userTurn: UserTurnSnapshot<Payload, Result>;
    readonly step: { readonly stepId: string; readonly ordinal: number };
    readonly signal: AbortSignal;
  }): Promise<RuntimeEnvironment> | RuntimeEnvironment;
}

/** Ordered post-Step processing for a completed UserTurn result. */
export interface UserTurnResultPipeline<Configuration, Payload, Result> {
  process(input: {
    readonly definition: AgentDefinition<Configuration>;
    readonly run: RunSnapshot<Payload, Result>;
    readonly userTurn: UserTurnSnapshot<Payload, Result>;
    readonly result: Result;
    readonly signal: AbortSignal;
  }): Promise<Result>;
}

export type UserTurnContinuationDecision<Payload> =
  | { readonly type: "none" }
  | {
      readonly type: "follow_up";
      readonly payload: Payload;
      readonly text: string;
      readonly source: string;
      readonly reserveCapacity?: boolean;
      readonly preemptible?: boolean;
    };

/**
 * Narrow policy seam at UserTurn boundaries. It cannot mutate Runtime state or
 * queues directly; the Runtime validates and applies the returned decision.
 */
export interface UserTurnContinuationPolicy<Configuration, Payload, Result> {
  openUserTurn?(input: {
    readonly definition: AgentDefinition<Configuration>;
    readonly run: RunSnapshot<Payload, Result>;
    readonly userTurn: UserTurnSnapshot<Payload, Result>;
    readonly signal: AbortSignal;
  }): Promise<void> | void;
  afterUserTurn?(input: {
    readonly definition: AgentDefinition<Configuration>;
    readonly run: RunSnapshot<Payload, Result>;
    readonly userTurn: UserTurnSnapshot<Payload, Result>;
    readonly result: Result;
    readonly pending: {
      readonly queuedFollowUps: number;
      readonly completionHolds: readonly string[];
    };
    readonly completion: {
      defer(reason: string): RunCompletionHold | undefined;
    };
    readonly signal: AbortSignal;
  }): Promise<UserTurnContinuationDecision<Payload>> | UserTurnContinuationDecision<Payload>;
  finishRun?(input: {
    readonly definition: AgentDefinition<Configuration>;
    readonly run: RunSnapshot<Payload, Result>;
    readonly status: "completed" | "failed" | "aborted";
    readonly reason?: string;
  }): Promise<void> | void;
}

export interface RuntimeIdGenerator {
  runId(): AgentRunId;
  userTurnId(): UserTurnId;
  controlId(): string;
  eventId(): string;
}

export interface RuntimeOptions<Configuration, Payload, StepMemory, Result> {
  readonly stepPipeline: StepPipeline<Configuration, Payload, StepMemory, Result>
    | StepPipelineSource<Configuration, Payload, StepMemory, Result>;
  readonly snapshotProvider?: StepSnapshotProvider<Configuration, Payload, Result>;
  readonly userTurnPipeline?: UserTurnResultPipeline<Configuration, Payload, Result>;
  readonly continuationPolicy?: UserTurnContinuationPolicy<Configuration, Payload, Result>;
  readonly lifecycle?: RuntimeLifecycleService<Payload, Result>;
  readonly observers?: readonly RuntimeTransitionObserver<Payload, Result>[];
  readonly maxSteps?: number;
  readonly stepInboxLimits?: RuntimeMailboxLimits;
  readonly followUpQueueLimits?: RuntimeMailboxLimits;
  readonly maxRetainedRuns?: number;
  readonly maxEventsPerRun?: number;
  readonly ids?: RuntimeIdGenerator;
  readonly now?: () => string;
}

export interface ActiveRun<Payload = unknown, Result = unknown> {
  readonly snapshot: RunSnapshot<Payload, Result>;
  readonly cancelled: boolean;
  readonly awaitingFollowUp: boolean;
}

export interface RunCompletionHold {
  readonly reason: string;
  release(): void;
}

type TurnOutcome<Result> =
  | { readonly status: "completed"; readonly result: Result }
  | { readonly status: "failed"; readonly error: RuntimeFailure }
  | { readonly status: "aborted"; readonly cancellation: RuntimeCancellation };

interface ManagedRun<Configuration, Payload, StepMemory, Result> {
  readonly definition: AgentDefinition<Configuration>;
  state: RunState<Payload, Result>;
  readonly initialUserTurnId: UserTurnId;
  controlUserTurnId: UserTurnId;
  readonly stepInbox: NextStepInbox;
  readonly followUps: NextTurnQueue<Payload>;
  readonly cancellation: RunCancellation;
  readonly events: RuntimeEventStream<RuntimeTransition<Payload, Result>>;
  readonly completion: Promise<RunCompletion<Result, Payload>>;
  readonly resolveCompletion: (completion: RunCompletion<Result, Payload>) => void;
  readonly holds: Map<symbol, string>;
  decisionSignal: DecisionSignal;
  observerWork: Promise<void>;
  stepMemory: StepMemory | undefined;
  activeStepSnapshot: StepSnapshot<Payload> | undefined;
  stepOutputOpen: boolean;
  active: boolean;
  finalized: boolean;
}

interface DecisionSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/**
 * Process-local owner of Runs.
 *
 * Outer loop: Run -> UserTurn -> queued follow-up UserTurn.
 * Inner loop: UserTurn -> Step -> Step until completion or a terminal decision.
 */
export class Runtime<
  Configuration = unknown,
  Payload = unknown,
  StepMemory = unknown,
  Result = unknown,
> {
  private readonly runs = new Map<
    AgentRunId,
    ManagedRun<Configuration, Payload, StepMemory, Result>
  >();
  private readonly activeRunIdByScope = new Map<string, AgentRunId>();
  private readonly retainedTerminalRuns: AgentRunId[] = [];
  private readonly lifecycle: RuntimeLifecycleService<Payload, Result>;
  private readonly observers: RuntimeObserverPipeline<Payload, Result>;
  private readonly maxSteps: number;
  private readonly maxRetainedRuns: number;
  private readonly maxEventsPerRun: number;
  private readonly ids: RuntimeIdGenerator;
  private readonly now: () => string;

  constructor(
    private readonly options: RuntimeOptions<
      Configuration,
      Payload,
      StepMemory,
      Result
    >,
  ) {
    this.maxSteps = positiveInteger(options.maxSteps, 32, "maxSteps");
    this.maxRetainedRuns = nonNegativeInteger(
      options.maxRetainedRuns,
      100,
      "maxRetainedRuns",
    );
    this.maxEventsPerRun = positiveInteger(
      options.maxEventsPerRun,
      10_000,
      "maxEventsPerRun",
    );
    this.lifecycle = options.lifecycle ??
      (NOOP_RUNTIME_LIFECYCLE as RuntimeLifecycleService<Payload, Result>);
    this.observers = new RuntimeObserverPipeline(options.observers ?? []);
    this.ids = options.ids ?? defaultRuntimeIds();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  startRun(
    definition: AgentDefinition<Configuration>,
    input: RunInput<Payload>,
  ): RunHandle<RunCompletion<Result, Payload>> {
    const agentId = requireIdentifier(definition.id, "Agent id");
    const scope = normalizeScope(input.scope);
    if (this.activeRunIdByScope.has(scope)) {
      throw new Error(`Runtime scope "${scope}" already has an active Run`);
    }
    const runId = requireIdentifier(
      input.runId ?? this.ids.runId(),
      "Run id",
    );
    if (this.runs.has(runId)) {
      throw new Error(`Run ${runId} is already registered`);
    }
    const initialUserTurnId = requireIdentifier(
      this.ids.userTurnId(),
      "UserTurn id",
    );
    let resolveCompletion = (_completion: RunCompletion<Result, Payload>) => {};
    const completion = new Promise<RunCompletion<Result, Payload>>((resolve) => {
      resolveCompletion = resolve;
    });
    const at = this.timestamp();
    const stableDefinition = snapshotAgentDefinition(definition, agentId);
    const record: ManagedRun<Configuration, Payload, StepMemory, Result> = {
      definition: stableDefinition,
      state: createRunState({
        runId,
        agentId,
        scope,
        ...(input.parentRunId === undefined
          ? {}
          : {
              parentRunId: requireIdentifier(
                input.parentRunId,
                "Parent Run id",
              ),
            }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        createdAt: at,
      }),
      initialUserTurnId,
      controlUserTurnId: initialUserTurnId,
      stepInbox: new NextStepInbox(
        this.options.stepInboxLimits ?? DEFAULT_STEP_INBOX_LIMITS,
      ),
      followUps: new NextTurnQueue(
        this.options.followUpQueueLimits ?? DEFAULT_TURN_QUEUE_LIMITS,
      ),
      cancellation: new RunCancellation(),
      events: new RuntimeEventStream(runId, this.maxEventsPerRun),
      completion,
      resolveCompletion,
      holds: new Map(),
      decisionSignal: createDecisionSignal(),
      observerWork: Promise.resolve(),
      stepMemory: undefined,
      activeStepSnapshot: undefined,
      stepOutputOpen: false,
      active: true,
      finalized: false,
    };
    this.runs.set(runId, record);
    this.activeRunIdByScope.set(scope, runId);
    try {
      record.stepInbox.openUserTurn(initialUserTurnId);
      this.recordTransition(record, { type: "run.started", at });
      const userTurnAt = this.timestamp();
      this.recordTransition(record, {
        type: "user_turn.started",
        userTurnId: initialUserTurnId,
        ordinal: 1,
        input: input.payload,
        ...(input.inputSource === undefined ? {} : { inputSource: input.inputSource }),
        provenance: initialUserTurnProvenance(
          input.inputSource ?? "unknown",
          userTurnAt,
        ),
        at: userTurnAt,
      });
    } catch (error: unknown) {
      record.active = false;
      record.stepInbox.close("run_failed", "expired");
      record.followUps.close("run_failed", "expired");
      record.events.close();
      this.runs.delete(runId);
      if (this.activeRunIdByScope.get(scope) === runId) {
        this.activeRunIdByScope.delete(scope);
      }
      throw error;
    }
    queueMicrotask(() => {
      void this.driveRun(record);
    });
    return Object.freeze({
      agentId,
      runId,
      initialUserTurnId,
      scope,
      completion,
    });
  }

  control(
    agentId: string,
    runId: AgentRunId,
    control: RuntimeControl<Payload>,
  ): RuntimeControlReceipt {
    const controlId = requireIdentifier(
      control.id ?? this.ids.controlId(),
      "Control id",
    );
    const record = this.runs.get(runId);
    if (record === undefined) {
      return rejectedReceipt(runId, control.type, controlId, "unknown_run");
    }
    if (record.definition.id !== agentId) {
      return rejectedReceipt(runId, control.type, controlId, "agent_mismatch");
    }
    if (!record.active || isRunTerminal(record.state.status)) {
      return rejectedReceipt(
        runId,
        control.type,
        controlId,
        "run_already_terminal",
      );
    }

    if (control.type === "abort") {
      return this.abortControl(record, controlId, control);
    }

    const source = normalizeSource(control.source);
    const receivedAt = control.receivedAt ?? this.timestamp();
    if (control.type === "steer") {
      const message = createRuntimeControlMessage({
        id: controlId,
        kind: "steer",
        runId,
        userTurnId: record.controlUserTurnId,
        text: control.text,
        source,
        receivedAt,
      });
      const receipt = record.stepInbox.enqueue(message);
      this.recordControlReceipt(record, "steer", receipt);
      return queueReceipt(runId, "steer", receipt);
    }

    const message = createRuntimeControlMessage({
      id: controlId,
      kind: "follow_up",
      runId,
      userTurnId: record.controlUserTurnId,
      text: control.text ?? describePayload(control.payload),
      source,
      receivedAt,
    });
    const receipt = record.followUps.enqueue(control.payload, message, {
      reserveCapacity: control.reserveCapacity === true,
      preemptible: control.preemptible === true,
      front: isTrustedHumanSource(source),
    });
    this.recordControlReceipt(record, "follow_up", receipt);
    if (receipt.accepted) {
      if (isTrustedHumanSource(source)) {
        const controlIds = record.followUps.cancelPreemptible();
        if (controlIds.length > 0) {
          this.recordTransition(record, {
            type: "control.follow_ups_preempted",
            controlIds,
            at: this.timestamp(),
          });
        }
      }
      this.wakeRun(record);
    }
    return queueReceipt(runId, "follow_up", receipt);
  }

  observe(
    agentId: string,
    runId: AgentRunId,
    options?: ObserveOptions,
  ): AsyncIterable<OutputEvent<RuntimeTransition<Payload, Result>>> {
    const record = this.requireRun(runId);
    if (record.definition.id !== agentId) {
      throw new Error(`Run ${runId} does not belong to Agent ${agentId}`);
    }
    return record.events.observe(options);
  }

  run(runId: AgentRunId): RunSnapshot<Payload, Result> | undefined {
    const record = this.runs.get(runId);
    return record === undefined ? undefined : snapshotRun(record.state);
  }

  runForScope(scope: string): RunSnapshot<Payload, Result> | undefined {
    const runId = this.activeRunIdByScope.get(normalizeScope(scope));
    return runId === undefined ? undefined : this.run(runId);
  }

  activeRuns(): readonly ActiveRun<Payload, Result>[] {
    return Object.freeze(
      [...this.runs.values()]
        .filter((record) => record.active)
        .map((record) => Object.freeze({
          snapshot: snapshotRun(record.state),
          cancelled: record.cancellation.cancelled,
          awaitingFollowUp: record.state.currentUserTurnId === undefined &&
            record.followUps.size === 0 &&
            record.holds.size > 0,
        })),
    );
  }

  deferRunCompletion(
    runId: AgentRunId,
    reason: string,
  ): RunCompletionHold | undefined {
    const record = this.runs.get(runId);
    const normalizedReason = reason.trim();
    if (
      record === undefined ||
      !record.active ||
      record.cancellation.cancelled ||
      normalizedReason.length === 0
    ) {
      return undefined;
    }
    const id = Symbol(normalizedReason);
    record.holds.set(id, normalizedReason);
    this.recordTransition(record, {
      type: "run.completion_deferred",
      reason: normalizedReason,
      at: this.timestamp(),
    });
    let released = false;
    return Object.freeze({
      reason: normalizedReason,
      release: () => {
        if (released) return;
        released = true;
        if (!record.holds.delete(id) || !record.active) return;
        this.recordTransition(record, {
          type: "run.completion_released",
          reason: normalizedReason,
          at: this.timestamp(),
        });
        this.wakeRun(record);
      },
    });
  }

  /** Outer loop: serializes the initial UserTurn and all accepted follow-ups. */
  private async driveRun(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
  ): Promise<void> {
    try {
      await this.lifecycle.openRun(snapshotRun(record.state));
      await this.openCurrentUserTurn(record);

      while (record.active) {
        const outcome = await this.processUserTurnResult(
          record,
          await this.driveUserTurn(record),
        );
        await this.applyContinuationPolicy(record, outcome);
        await this.finishCurrentUserTurn(record, outcome);

        while (record.active) {
          const decision = decideAfterUserTurn({
            cancelled: record.cancellation.cancelled,
            ...(outcome.status === "failed" ? { error: outcome.error } : {}),
            hasQueuedFollowUp: record.followUps.size > 0,
            hasCompletionHold: record.holds.size > 0,
          });
          if (decision.type === "abort_run") {
            await this.abortRun(record, this.requireCancellation(record));
            return;
          }
          if (decision.type === "fail_run") {
            await this.failRun(record, decision.error);
            return;
          }
          if (decision.type === "complete_run") {
            if (outcome.status !== "completed") {
              await this.failRun(record, runtimeFailure(
                "invalid_terminal_state",
                "Run completion requires a completed UserTurn",
                false,
              ));
              return;
            }
            await this.completeRun(record, outcome.result);
            return;
          }
          if (decision.type === "wait") {
            await this.waitForRunDecision(record);
            continue;
          }

          const next = record.followUps.dequeue();
          if (next === undefined) continue;
          this.recordTransition(record, {
            type: "control.follow_up_dequeued",
            controlId: next.message.id,
            at: this.timestamp(),
          });
          const userTurnId = requireIdentifier(
            this.ids.userTurnId(),
            "UserTurn id",
          );
          record.controlUserTurnId = userTurnId;
          record.stepMemory = undefined;
          record.stepInbox.openUserTurn(userTurnId);
          this.recordTransition(record, {
            type: "user_turn.started",
            userTurnId,
            ordinal: record.state.userTurns.length + 1,
            input: next.payload,
            inputSource: "follow_up",
            provenance: followUpUserTurnProvenance(next.message),
            at: this.timestamp(),
          });
          await this.openCurrentUserTurn(record);
          break;
        }
      }
    } catch (error: unknown) {
      await this.failRun(record, unknownRuntimeFailure(error));
    }
  }

  /** Inner loop: executes bounded Steps for exactly one active UserTurn. */
  private async driveUserTurn(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
  ): Promise<TurnOutcome<Result>> {
    const turn = currentUserTurn(record.state);
    if (turn === undefined) {
      return {
        status: "failed",
        error: runtimeFailure(
          "missing_user_turn",
          "Runtime has no active UserTurn",
          false,
        ),
      };
    }

    for (let ordinal = 1; ordinal <= this.maxSteps; ordinal += 1) {
      if (record.cancellation.cancelled) {
        return { status: "aborted", cancellation: this.requireCancellation(record) };
      }
      const source = this.options.stepPipeline;
      let lease: StepPipelineLease<Configuration, Payload, StepMemory, Result> | undefined;
      try {
        if ("acquire" in source) lease = await source.acquire({ signal: record.cancellation.signal });
      } catch (error: unknown) {
        return record.cancellation.cancelled
          ? { status: "aborted", cancellation: this.requireCancellation(record) }
          : { status: "failed", error: unknownRuntimeFailure(error) };
      }
      try {
        // Waiting for an implementation must not consume steering or start a phantom Step.
        if (record.cancellation.cancelled) {
          return { status: "aborted", cancellation: this.requireCancellation(record) };
        }
        const stepId = `${turn.id}:${ordinal}`;
        this.recordTransition(record, {
          type: "step.started",
          userTurnId: turn.id,
          stepId,
          ordinal,
          at: this.timestamp(),
        });
        const steering = record.stepInbox.drain(turn.id, stepId);
        if (steering.length > 0) {
          this.recordTransition(record, {
            type: "control.steering_delivered",
            controlIds: steering.map((message) => message.id),
            stepId,
            at: this.timestamp(),
          });
        }

        const step = currentStep(record.state);
        if (step === undefined) {
          return {
            status: "failed",
            error: runtimeFailure("missing_step", "Runtime did not start a Step", false),
          };
        }

        let snapshot: StepSnapshot<Payload>;
        try {
          const activeTurn = currentUserTurn(record.state);
          if (activeTurn === undefined) throw new Error("Active UserTurn disappeared");
          const environment = await this.captureEnvironment(
            record,
            snapshotUserTurn(activeTurn),
            stepId,
            ordinal,
          );
          if (record.cancellation.cancelled) {
            const cancellation = this.requireCancellation(record);
            this.recordTransition(record, {
              type: "step.aborted",
              userTurnId: turn.id,
              stepId,
              reason: cancellation.reason,
              at: this.timestamp(),
            });
            return { status: "aborted", cancellation };
          }
          snapshot = captureStepSnapshot({
            state: record.state,
            step,
            steering,
            environment,
            capturedAt: this.timestamp(),
          });
          record.activeStepSnapshot = snapshot;
          await this.lifecycle.openStep(snapshot);
        } catch (error: unknown) {
          if (record.cancellation.cancelled) {
            const cancellation = this.requireCancellation(record);
            this.recordTransition(record, {
              type: "step.aborted",
              userTurnId: turn.id,
              stepId,
              reason: cancellation.reason,
              at: this.timestamp(),
            });
            record.activeStepSnapshot = undefined;
            return { status: "aborted", cancellation };
          }
          const failure = unknownRuntimeFailure(error);
          this.recordTransition(record, {
            type: "step.failed",
            userTurnId: turn.id,
            stepId,
            error: failure,
            at: this.timestamp(),
          });
          record.activeStepSnapshot = undefined;
          return { status: "failed", error: failure };
        }

        if (record.cancellation.cancelled) {
          const cancellation = this.requireCancellation(record);
          const finishFailure = await this.finishStep(
            record,
            snapshot,
            "aborted",
            cancellation.reason,
          );
          return finishFailure === undefined
            ? { status: "aborted", cancellation }
            : { status: "failed", error: finishFailure };
        }

        let outcome: StepPipelineResult<StepMemory, Result>;
        record.stepOutputOpen = true;
        try {
          outcome = validateStepPipelineResult(
            await (lease?.pipeline ?? source as StepPipeline<Configuration, Payload, StepMemory, Result>).execute({
              definition: record.definition,
              snapshot,
              memory: record.stepMemory,
              signal: record.cancellation.signal,
              output: this.createStepOutputPublisher(record, snapshot),
            }),
          );
        } catch (error: unknown) {
          outcome = record.cancellation.cancelled
            ? { status: "aborted", reason: "run_cancelled" }
            : {
                status: "failed",
                error: error instanceof InvalidStepPipelineResultError
                  ? runtimeFailure(
                      "invalid_step_pipeline_result",
                      error.message,
                      false,
                    )
                  : unknownRuntimeFailure(error),
              };
        } finally {
          record.stepOutputOpen = false;
        }

        if (record.cancellation.cancelled || outcome.status === "aborted") {
          const cancellation = record.cancellation.cancelled
            ? this.requireCancellation(record)
            : this.requestRuntimeAbort(
                record,
                outcome.status === "aborted"
                  ? outcome.reason ?? "step_aborted"
                  : "step_aborted",
              );
          const finishFailure = await this.finishStep(
            record,
            snapshot,
            "aborted",
            cancellation.reason,
          );
          if (finishFailure !== undefined) {
            return { status: "failed", error: finishFailure };
          }
          return { status: "aborted", cancellation };
        }

        if (outcome.status === "failed") {
          const finishFailure = await this.finishStep(
            record,
            snapshot,
            "failed",
            outcome.error.message,
            outcome.error,
          );
          return {
            status: "failed",
            error: finishFailure ?? outcome.error,
          };
        }

        if (outcome.status === "continue" || outcome.memory !== undefined) {
          record.stepMemory = outcome.memory;
        }
        const decision = decideAfterStep({
          outcome: outcome.status,
          ...(outcome.status === "continue"
            ? { continuationReason: outcome.reason }
            : {}),
          pendingSteering: record.stepInbox.hasPending(turn.id),
          hasRemainingStepBudget: ordinal < this.maxSteps,
          maxSteps: this.maxSteps,
        });
        const stepReason = decision.type === "continue"
          ? decision.reason
          : outcome.status === "completed"
            ? "pipeline_completed"
            : "step_completed";
        const finishFailure = await this.finishStep(
          record,
          snapshot,
          "completed",
          stepReason,
        );
        if (finishFailure !== undefined) {
          return { status: "failed", error: finishFailure };
        }
        if (decision.type === "continue") continue;
        if (decision.type === "fail") {
          if (decision.error.code === "max_steps_exceeded") {
            record.stepInbox.closeUserTurn(turn.id, "step_budget_exhausted");
          }
          return { status: "failed", error: decision.error };
        }
        if (decision.type === "abort") {
          return {
            status: "aborted",
            cancellation: this.requestRuntimeAbort(record, "step_aborted"),
          };
        }
        if (outcome.status !== "completed") {
          return {
            status: "failed",
            error: runtimeFailure(
              "invalid_step_outcome",
              "A completed UserTurn requires a completed Step result",
              false,
            ),
          };
        }
        return { status: "completed", result: outcome.result };
      } finally {
        lease?.release();
      }
    }

    return {
      status: "failed",
      error: runtimeFailure(
        "max_steps_exceeded",
        `UserTurn stopped after reaching maxSteps=${this.maxSteps}`,
        false,
      ),
    };
  }

  private async captureEnvironment(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    userTurn: UserTurnSnapshot<Payload, Result>,
    stepId: string,
    ordinal: number,
  ): Promise<RuntimeEnvironment> {
    const provider = this.options.snapshotProvider;
    if (provider === undefined) return Object.freeze({});
    return await provider.capture({
      definition: record.definition,
      run: snapshotRun(record.state),
      userTurn,
      step: Object.freeze({ stepId, ordinal }),
      signal: record.cancellation.signal,
    });
  }

  private async processUserTurnResult(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    outcome: TurnOutcome<Result>,
  ): Promise<TurnOutcome<Result>> {
    const pipeline = this.options.userTurnPipeline;
    if (outcome.status !== "completed" || pipeline === undefined) return outcome;
    if (record.cancellation.cancelled) {
      return {
        status: "aborted",
        cancellation: this.requireCancellation(record),
      };
    }
    const turn = currentUserTurn(record.state);
    if (turn === undefined) {
      return {
        status: "failed",
        error: runtimeFailure(
          "missing_user_turn",
          "Runtime has no active UserTurn for result processing",
          false,
        ),
      };
    }
    try {
      const result = await pipeline.process({
        definition: record.definition,
        run: snapshotRun(record.state),
        userTurn: snapshotUserTurn(turn),
        result: outcome.result,
        signal: record.cancellation.signal,
      });
      return record.cancellation.cancelled
        ? {
            status: "aborted",
            cancellation: this.requireCancellation(record),
          }
        : { status: "completed", result };
    } catch (error: unknown) {
      return record.cancellation.cancelled
        ? {
            status: "aborted",
            cancellation: this.requireCancellation(record),
          }
        : { status: "failed", error: unknownRuntimeFailure(error) };
    }
  }

  private async openCurrentUserTurn(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
  ): Promise<void> {
    const turn = currentUserTurn(record.state);
    if (turn === undefined) throw new Error("Runtime has no active UserTurn");
    await this.lifecycle.openUserTurn({
      run: snapshotRun(record.state),
      userTurn: snapshotUserTurn(turn),
    });
    await this.options.continuationPolicy?.openUserTurn?.({
      definition: record.definition,
      run: snapshotRun(record.state),
      userTurn: snapshotUserTurn(turn),
      signal: record.cancellation.signal,
    });
  }

  private async applyContinuationPolicy(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    outcome: TurnOutcome<Result>,
  ): Promise<void> {
    const policy = this.options.continuationPolicy;
    if (
      policy?.afterUserTurn === undefined ||
      outcome.status !== "completed" ||
      record.cancellation.cancelled ||
      record.followUps.size > 0
    ) {
      return;
    }
    const turn = currentUserTurn(record.state);
    if (turn === undefined) throw new Error("Runtime has no active UserTurn");
    const decision = await policy.afterUserTurn({
      definition: record.definition,
      run: snapshotRun(record.state),
      userTurn: snapshotUserTurn(turn),
      result: outcome.result,
      pending: Object.freeze({
        queuedFollowUps: record.followUps.size,
        completionHolds: Object.freeze([...record.holds.values()]),
      }),
      completion: Object.freeze({
        defer: (reason: string) => this.deferRunCompletion(record.state.id, reason),
      }),
      signal: record.cancellation.signal,
    });
    if (
      decision.type === "none" ||
      record.cancellation.cancelled ||
      record.followUps.size > 0
    ) {
      return;
    }
    const receipt = this.control(record.definition.id, record.state.id, {
      type: "follow_up",
      payload: decision.payload,
      text: decision.text,
      source: decision.source,
      ...(decision.reserveCapacity === undefined
        ? {}
        : { reserveCapacity: decision.reserveCapacity }),
      ...(decision.preemptible === undefined
        ? {}
        : { preemptible: decision.preemptible }),
    });
    if (!receipt.accepted) {
      throw new Error(
        `Continuation follow-up was rejected: ${receipt.reason ?? "unknown"}`,
      );
    }
  }

  private async finishCurrentUserTurn(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    outcome: TurnOutcome<Result>,
  ): Promise<void> {
    const turn = currentUserTurn(record.state);
    if (turn === undefined) throw new Error("Runtime has no active UserTurn");
    const reason = outcome.status === "failed"
      ? outcome.error.message
      : outcome.status === "aborted"
        ? outcome.cancellation.reason
        : undefined;
    await this.lifecycle.finishUserTurn({
      run: snapshotRun(record.state),
      userTurn: snapshotUserTurn(turn),
      status: outcome.status,
      ...(reason === undefined ? {} : { reason }),
    });
    const at = this.timestamp();
    if (outcome.status === "completed") {
      this.recordTransition(record, {
        type: "user_turn.completed",
        userTurnId: turn.id,
        result: outcome.result,
        at,
      });
      record.stepInbox.closeUserTurn(turn.id, "user_turn_completed");
      return;
    }
    if (outcome.status === "failed") {
      this.recordTransition(record, {
        type: "user_turn.failed",
        userTurnId: turn.id,
        error: outcome.error,
        at,
      });
      record.stepInbox.closeUserTurn(turn.id, "user_turn_failed");
      return;
    }
    this.recordTransition(record, {
      type: "user_turn.aborted",
      userTurnId: turn.id,
      cancellation: outcome.cancellation,
      at,
    });
    record.stepInbox.closeUserTurn(turn.id, "user_turn_aborted");
  }

  private async finishStep(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    snapshot: StepSnapshot<Payload>,
    status: "completed" | "failed" | "aborted",
    reason: string,
    error?: RuntimeFailure,
  ): Promise<RuntimeFailure | undefined> {
    try {
      await this.lifecycle.finishStep({ snapshot, status, reason });
    } catch (lifecycleError: unknown) {
      const failure = runtimeFailure(
        "lifecycle_commit_failed",
        unknownRuntimeFailure(lifecycleError).message,
        false,
      );
      this.recordTransition(record, {
        type: "step.failed",
        userTurnId: snapshot.userTurn.userTurnId,
        stepId: snapshot.step.stepId,
        error: failure,
        at: this.timestamp(),
      });
      record.activeStepSnapshot = undefined;
      record.stepOutputOpen = false;
      return failure;
    }
    if (status === "completed") {
      this.recordTransition(record, {
        type: "step.completed",
        userTurnId: snapshot.userTurn.userTurnId,
        stepId: snapshot.step.stepId,
        reason,
        at: this.timestamp(),
      });
    } else if (status === "failed") {
      this.recordTransition(record, {
        type: "step.failed",
        userTurnId: snapshot.userTurn.userTurnId,
        stepId: snapshot.step.stepId,
        error: error ?? runtimeFailure("step_failed", reason, false),
        at: this.timestamp(),
      });
    } else {
      this.recordTransition(record, {
        type: "step.aborted",
        userTurnId: snapshot.userTurn.userTurnId,
        stepId: snapshot.step.stepId,
        reason,
        at: this.timestamp(),
      });
    }
    record.activeStepSnapshot = undefined;
    record.stepOutputOpen = false;
    return undefined;
  }

  private abortControl(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    controlId: string,
    control: Extract<RuntimeControl<Payload>, { readonly type: "abort" }>,
  ): RuntimeControlReceipt {
    if (record.cancellation.cancelled) {
      return Object.freeze({
        accepted: false,
        kind: "abort",
        runId: record.state.id,
        controlId,
        reason: "already_cancelled",
        cancellation: this.requireCancellation(record),
      });
    }
    const cancellation = record.cancellation.request(Object.freeze({
      reason: normalizeReason(control.reason, "runtime_abort"),
      source: normalizeSource(control.source),
      requestedAt: control.requestedAt ?? this.timestamp(),
    }));
    record.stepInbox.close("run_cancelled");
    record.followUps.close("run_cancelled");
    this.recordTransition(record, {
      type: "run.cancel_requested",
      controlId,
      cancellation,
      at: this.timestamp(),
    });
    this.wakeRun(record);
    return Object.freeze({
      accepted: true,
      kind: "abort",
      runId: record.state.id,
      controlId,
      cancellation,
    });
  }

  private requestRuntimeAbort(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    reason: string,
  ): RuntimeCancellation {
    if (record.cancellation.cancelled) return this.requireCancellation(record);
    const controlId = requireIdentifier(this.ids.controlId(), "Control id");
    const cancellation = record.cancellation.request(Object.freeze({
      reason,
      source: "runtime",
      requestedAt: this.timestamp(),
    }));
    record.stepInbox.close("run_cancelled");
    record.followUps.close("run_cancelled");
    this.recordTransition(record, {
      type: "run.cancel_requested",
      controlId,
      cancellation,
      at: this.timestamp(),
    });
    this.wakeRun(record);
    return cancellation;
  }

  private recordControlReceipt(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    kind: Extract<RuntimeControlKind, "steer" | "follow_up">,
    receipt: {
      readonly accepted: boolean;
      readonly message: { readonly id: string };
      readonly position?: number;
      readonly reason?: RuntimeControlReceiptReason;
    },
  ): void {
    if (receipt.reason === "duplicate_control") {
      this.recordTransition(record, {
        type: "control.duplicate",
        controlId: receipt.message.id,
        kind,
        at: this.timestamp(),
      });
      return;
    }
    if (receipt.accepted && receipt.position !== undefined) {
      this.recordTransition(record, {
        type: "control.queued",
        controlId: receipt.message.id,
        kind,
        position: receipt.position,
        at: this.timestamp(),
      });
      return;
    }
    this.recordTransition(record, {
      type: "control.rejected",
      controlId: receipt.message.id,
      kind,
      reason: receipt.reason ?? "duplicate_control",
      at: this.timestamp(),
    });
  }

  private async completeRun(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    result: Result,
  ): Promise<void> {
    try {
      await this.finishContinuationPolicy(record, "completed");
      await this.lifecycle.finishRun({
        snapshot: snapshotRun(record.state),
        status: "completed",
      });
    } catch (error: unknown) {
      await this.failRun(record, runtimeFailure(
        "lifecycle_commit_failed",
        unknownRuntimeFailure(error).message,
        false,
      ));
      return;
    }
    this.recordTransition(record, {
      type: "run.completed",
      result,
      at: this.timestamp(),
    });
    await this.finalizeRun(record, Object.freeze({
      status: "completed",
      result,
      snapshot: snapshotRun(record.state),
    }));
  }

  private async failRun(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    error: RuntimeFailure,
  ): Promise<void> {
    if (record.finalized) return;
    if (record.cancellation.cancelled) {
      await this.abortRun(record, this.requireCancellation(record));
      return;
    }
    await this.failActiveEntities(record, error);
    try {
      await this.finishContinuationPolicy(record, "failed", error.message);
    } catch {}
    try {
      await this.lifecycle.finishRun({
        snapshot: snapshotRun(record.state),
        status: "failed",
        reason: error.message,
      });
    } catch {
      // The original failure remains canonical; reconciliation is external.
    }
    if (!isRunTerminal(record.state.status)) {
      this.recordTransition(record, {
        type: "run.failed",
        error,
        at: this.timestamp(),
      });
    }
    await this.finalizeRun(record, Object.freeze({
      status: "failed",
      error,
      snapshot: snapshotRun(record.state),
    }));
  }

  private async abortRun(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    cancellation: RuntimeCancellation,
  ): Promise<void> {
    if (record.finalized) return;
    await this.abortActiveEntities(record, cancellation);
    try {
      await this.finishContinuationPolicy(record, "aborted", cancellation.reason);
    } catch {}
    try {
      await this.lifecycle.finishRun({
        snapshot: snapshotRun(record.state),
        status: "aborted",
        reason: cancellation.reason,
      });
    } catch {
      // Cancellation remains canonical even when an external journal needs repair.
    }
    if (!isRunTerminal(record.state.status)) {
      this.recordTransition(record, {
        type: "run.aborted",
        cancellation,
        at: this.timestamp(),
      });
    }
    await this.finalizeRun(record, Object.freeze({
      status: "aborted",
      cancellation,
      snapshot: snapshotRun(record.state),
    }));
  }

  private async failActiveEntities(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    error: RuntimeFailure,
  ): Promise<void> {
    const step = currentStep(record.state);
    if (step?.status === "running") {
      if (record.activeStepSnapshot !== undefined) {
        try {
          await this.lifecycle.finishStep({
            snapshot: record.activeStepSnapshot,
            status: "failed",
            reason: error.message,
          });
        } catch {}
      }
      this.recordTransition(record, {
        type: "step.failed",
        userTurnId: record.controlUserTurnId,
        stepId: step.id,
        error,
        at: this.timestamp(),
      });
      record.activeStepSnapshot = undefined;
      record.stepOutputOpen = false;
    }
    const turn = currentUserTurn(record.state);
    if (turn?.status === "running") {
      try {
        await this.lifecycle.finishUserTurn({
          run: snapshotRun(record.state),
          userTurn: snapshotUserTurn(turn),
          status: "failed",
          reason: error.message,
        });
      } catch {}
      this.recordTransition(record, {
        type: "user_turn.failed",
        userTurnId: turn.id,
        error,
        at: this.timestamp(),
      });
      record.stepInbox.closeUserTurn(turn.id, "user_turn_failed");
    }
  }

  private async abortActiveEntities(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    cancellation: RuntimeCancellation,
  ): Promise<void> {
    const step = currentStep(record.state);
    if (step?.status === "running") {
      if (record.activeStepSnapshot !== undefined) {
        try {
          await this.lifecycle.finishStep({
            snapshot: record.activeStepSnapshot,
            status: "aborted",
            reason: cancellation.reason,
          });
        } catch {}
      }
      this.recordTransition(record, {
        type: "step.aborted",
        userTurnId: record.controlUserTurnId,
        stepId: step.id,
        reason: cancellation.reason,
        at: this.timestamp(),
      });
      record.activeStepSnapshot = undefined;
      record.stepOutputOpen = false;
    }
    const turn = currentUserTurn(record.state);
    if (turn?.status === "running") {
      try {
        await this.lifecycle.finishUserTurn({
          run: snapshotRun(record.state),
          userTurn: snapshotUserTurn(turn),
          status: "aborted",
          reason: cancellation.reason,
        });
      } catch {}
      this.recordTransition(record, {
        type: "user_turn.aborted",
        userTurnId: turn.id,
        cancellation,
        at: this.timestamp(),
      });
      record.stepInbox.closeUserTurn(turn.id, "user_turn_aborted");
    }
  }

  private recordTransition(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    input: RuntimeTransition<Payload, Result>,
  ): void {
    const transition = freezeRuntimeTransition(input);
    const eventId = requireIdentifier(this.ids.eventId(), "Event id");
    const nextState = applyRuntimeTransition(record.state, transition);
    const userTurnId = "userTurnId" in transition
      ? transition.userTurnId
      : undefined;
    const stepId = "stepId" in transition ? transition.stepId : undefined;
    record.events.publish({
      eventId,
      occurredAt: transition.at,
      transition,
      ...(userTurnId === undefined ? {} : { userTurnId }),
      ...(stepId === undefined ? {} : { stepId }),
    });
    record.state = nextState;
    record.observerWork = record.observerWork
      .then(() => this.observers.emit(transition))
      .catch(() => undefined);
  }

  private createStepOutputPublisher(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    snapshot: StepSnapshot<Payload>,
  ): StepOutputPublisher {
    const thisRuntime = this;
    const output: StepOutputPublisher = {
      publishModel(event) {
        thisRuntime.requireActiveStepOutput(record, snapshot);
        record.events.publishModel({
          eventId: requireIdentifier(thisRuntime.ids.eventId(), "Event id"),
          occurredAt: thisRuntime.timestamp(),
          event,
          userTurnId: snapshot.userTurn.userTurnId,
          stepId: snapshot.step.stepId,
        });
      },
      publishTool(event) {
        thisRuntime.requireActiveStepOutput(record, snapshot);
        if (
          event.scope.runId !== snapshot.run.runId ||
          event.scope.userTurnId !== snapshot.userTurn.userTurnId ||
          event.scope.stepId !== snapshot.step.stepId
        ) {
          throw new Error("Tool event scope does not match the active Runtime Step");
        }
        record.events.publishTool({
          eventId: requireIdentifier(thisRuntime.ids.eventId(), "Event id"),
          event,
        });
      },
    };
    return Object.freeze(output);
  }

  private requireActiveStepOutput(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    snapshot: StepSnapshot<Payload>,
  ): void {
    const step = currentStep(record.state);
    if (
      !record.active ||
      !record.stepOutputOpen ||
      record.activeStepSnapshot !== snapshot ||
      step?.id !== snapshot.step.stepId ||
      step.status !== "running"
    ) {
      throw new Error("Step output publisher is no longer active");
    }
  }

  private async finalizeRun(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    completion: RunCompletion<Result, Payload>,
  ): Promise<void> {
    if (record.finalized) return;
    record.finalized = true;
    record.active = false;
    record.stepOutputOpen = false;
    record.holds.clear();
    record.stepInbox.close(
      completion.status === "completed"
        ? "run_completed"
        : completion.status === "failed"
          ? "run_failed"
          : "run_cancelled",
      completion.status === "aborted" ? "cancelled" : "expired",
    );
    record.followUps.close(
      completion.status === "completed"
        ? "run_completed"
        : completion.status === "failed"
          ? "run_failed"
          : "run_cancelled",
      completion.status === "aborted" ? "cancelled" : "expired",
    );
    if (this.activeRunIdByScope.get(record.state.scope) === record.state.id) {
      this.activeRunIdByScope.delete(record.state.scope);
    }
    record.events.close();
    record.resolveCompletion(completion);
    this.retainedTerminalRuns.push(record.state.id);
    this.pruneTerminalRuns();
  }

  private async finishContinuationPolicy(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
    status: "completed" | "failed" | "aborted",
    reason?: string,
  ): Promise<void> {
    await this.options.continuationPolicy?.finishRun?.({
      definition: record.definition,
      run: snapshotRun(record.state),
      status,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private pruneTerminalRuns(): void {
    while (this.retainedTerminalRuns.length > this.maxRetainedRuns) {
      const runId = this.retainedTerminalRuns.shift();
      if (runId !== undefined && this.runs.get(runId)?.active === false) {
        this.runs.delete(runId);
      }
    }
  }

  private async waitForRunDecision(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
  ): Promise<void> {
    while (
      record.active &&
      !record.cancellation.cancelled &&
      record.followUps.size === 0 &&
      record.holds.size > 0
    ) {
      const signal = record.decisionSignal.promise;
      if (
        record.cancellation.cancelled ||
        record.followUps.size > 0 ||
        record.holds.size === 0
      ) {
        continue;
      }
      await signal;
    }
  }

  private wakeRun(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
  ): void {
    const current = record.decisionSignal;
    record.decisionSignal = createDecisionSignal();
    current.resolve();
  }

  private requireCancellation(
    record: ManagedRun<Configuration, Payload, StepMemory, Result>,
  ): RuntimeCancellation {
    const cancellation = record.cancellation.value;
    if (cancellation === undefined) {
      throw new Error("Runtime cancellation is missing");
    }
    return cancellation;
  }

  private requireRun(
    runId: AgentRunId,
  ): ManagedRun<Configuration, Payload, StepMemory, Result> {
    const record = this.runs.get(runId);
    if (record === undefined) throw new Error(`Run ${runId} is not registered`);
    return record;
  }

  private timestamp(): string {
    const value = this.now();
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("Runtime clock must return a non-empty timestamp");
    }
    return value;
  }
}

function queueReceipt(
  runId: AgentRunId,
  kind: Extract<RuntimeControlKind, "steer" | "follow_up">,
  receipt: {
    readonly accepted: boolean;
    readonly message: { readonly id: string };
    readonly position?: number;
    readonly reason?: RuntimeControlReceiptReason;
  },
): RuntimeControlReceipt {
  return Object.freeze({
    accepted: receipt.accepted,
    kind,
    runId,
    controlId: receipt.message.id,
    ...(receipt.position === undefined ? {} : { position: receipt.position }),
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  });
}

function rejectedReceipt(
  runId: AgentRunId,
  kind: RuntimeControlKind,
  controlId: string,
  reason: RuntimeControlReceiptReason,
): RuntimeControlReceipt {
  return Object.freeze({
    accepted: false,
    kind,
    runId,
    controlId,
    reason,
  });
}

function createDecisionSignal(): DecisionSignal {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function defaultRuntimeIds(): RuntimeIdGenerator {
  return Object.freeze({
    runId: () => randomId(),
    userTurnId: () => randomId(),
    controlId: () => randomId(),
    eventId: () => randomId(),
  });
}

function randomId(): string {
  if (globalThis.crypto?.randomUUID === undefined) {
    throw new Error("Runtime requires an injected id generator");
  }
  return globalThis.crypto.randomUUID();
}

function normalizeScope(scope: string): string {
  if (typeof scope !== "string") throw new Error("Run scope must be a string");
  const normalized = scope.trim();
  if (normalized.length === 0) throw new Error("Run scope must not be empty");
  return normalized;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  return value;
}

function normalizeSource(source: string | undefined): string {
  if (source === undefined) return "runtime";
  return requireIdentifier(source, "Control source");
}

function isTrustedHumanSource(source: string): boolean {
  return source === "wish-cli" || source === "wish-webui";
}

function initialUserTurnProvenance(
  source: string,
  receivedAt: string,
): UserTurnProvenance {
  return Object.freeze({
    origin: "run_input",
    source,
    receivedAt,
  });
}

function followUpUserTurnProvenance(message: {
  readonly id: string;
  readonly source: string;
  readonly receivedAt: string;
}): UserTurnProvenance {
  return Object.freeze({
    origin: "follow_up",
    source: message.source,
    controlId: message.id,
    receivedAt: message.receivedAt,
  });
}

function normalizeReason(reason: string | undefined, fallback: string): string {
  if (reason === undefined) return fallback;
  const normalized = reason.trim();
  return normalized.length === 0 ? fallback : normalized;
}

function describePayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string"
  ) {
    return value.text;
  }
  return "Queued follow-up";
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return resolved;
}

class InvalidStepPipelineResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStepPipelineResultError";
  }
}

function validateStepPipelineResult<StepMemory, Result>(
  value: StepPipelineResult<StepMemory, Result>,
): StepPipelineResult<StepMemory, Result> {
  if (!isRecord(value)) {
    throw new InvalidStepPipelineResultError(
      "Step Pipeline must return an object",
    );
  }
  switch (value.status) {
    case "continue":
      if (typeof value.reason !== "string" || value.reason.trim().length === 0) {
        throw new InvalidStepPipelineResultError(
          "A continuing Step requires a non-empty reason",
        );
      }
      if (!("memory" in value)) {
        throw new InvalidStepPipelineResultError(
          "A continuing Step requires next-Step memory",
        );
      }
      return value;

    case "completed":
      if (!("result" in value)) {
        throw new InvalidStepPipelineResultError(
          "A completed Step requires a result",
        );
      }
      return value;

    case "failed":
      if (!isRuntimeFailure(value.error)) {
        throw new InvalidStepPipelineResultError(
          "A failed Step requires a RuntimeFailure",
        );
      }
      return value;

    case "aborted":
      if (value.reason !== undefined && typeof value.reason !== "string") {
        throw new InvalidStepPipelineResultError(
          "An aborted Step reason must be a string",
        );
      }
      return value;

    default:
      throw new InvalidStepPipelineResultError(
        "Step Pipeline returned an unknown status",
      );
  }
}

function isRuntimeFailure(value: unknown): value is RuntimeFailure {
  return isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean";
}

function snapshotAgentDefinition<Configuration>(
  definition: AgentDefinition<Configuration>,
  agentId: string,
): AgentDefinition<Configuration> {
  return Object.freeze({
    ...definition,
    id: agentId,
    ...(definition.configuration === undefined
      ? {}
      : {
          configuration: cloneAndFreezePlainValue(
            definition.configuration,
          ) as Configuration,
        }),
    ...(definition.metadata === undefined
      ? {}
      : {
          metadata: cloneAndFreezePlainValue(
            definition.metadata,
          ) as NonNullable<AgentDefinition<Configuration>["metadata"]>,
        }),
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
