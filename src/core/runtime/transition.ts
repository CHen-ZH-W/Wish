import type { RuntimeControlKind } from "./control.js";
import {
  currentStep,
  currentUserTurn,
  isRunTerminal,
  type AgentStepId,
  type RunState,
  type RuntimeCancellation,
  type RuntimeFailure,
  type StepState,
  type UserTurnProvenance,
  type UserTurnState,
} from "./state.js";
import type { RunInputSource, UserTurnId } from "../agent/types.js";

export type RuntimeTransition<Payload = unknown, Result = unknown> =
  | { readonly type: "run.started"; readonly at: string }
  | {
      readonly type: "user_turn.started";
      readonly userTurnId: UserTurnId;
      readonly ordinal: number;
      readonly input: Payload;
      readonly inputSource?: RunInputSource;
      readonly provenance: UserTurnProvenance;
      readonly at: string;
    }
  | {
      readonly type: "step.started";
      readonly userTurnId: UserTurnId;
      readonly stepId: AgentStepId;
      readonly ordinal: number;
      readonly at: string;
    }
  | {
      readonly type: "step.completed";
      readonly userTurnId: UserTurnId;
      readonly stepId: AgentStepId;
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "step.failed";
      readonly userTurnId: UserTurnId;
      readonly stepId: AgentStepId;
      readonly error: RuntimeFailure;
      readonly at: string;
    }
  | {
      readonly type: "step.aborted";
      readonly userTurnId: UserTurnId;
      readonly stepId: AgentStepId;
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "user_turn.completed";
      readonly userTurnId: UserTurnId;
      readonly result: Result;
      readonly at: string;
    }
  | {
      readonly type: "user_turn.failed";
      readonly userTurnId: UserTurnId;
      readonly error: RuntimeFailure;
      readonly at: string;
    }
  | {
      readonly type: "user_turn.aborted";
      readonly userTurnId: UserTurnId;
      readonly cancellation: RuntimeCancellation;
      readonly at: string;
    }
  | {
      readonly type: "control.queued";
      readonly controlId: string;
      readonly kind: Extract<RuntimeControlKind, "steer" | "follow_up">;
      readonly position: number;
      readonly at: string;
    }
  | {
      readonly type: "control.steering_delivered";
      readonly controlIds: readonly string[];
      readonly stepId: AgentStepId;
      readonly at: string;
    }
  | {
      readonly type: "control.follow_up_dequeued";
      readonly controlId: string;
      readonly at: string;
    }
  | {
      readonly type: "control.follow_ups_preempted";
      readonly controlIds: readonly string[];
      readonly at: string;
    }
  | {
      readonly type: "control.rejected";
      readonly controlId: string;
      readonly kind: RuntimeControlKind;
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "control.duplicate";
      readonly controlId: string;
      readonly kind: Extract<RuntimeControlKind, "steer" | "follow_up">;
      readonly at: string;
    }
  | {
      readonly type: "run.cancel_requested";
      readonly controlId: string;
      readonly cancellation: RuntimeCancellation;
      readonly at: string;
    }
  | {
      readonly type: "run.completion_deferred";
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "run.completion_released";
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "run.completed";
      readonly result: Result;
      readonly at: string;
    }
  | {
      readonly type: "run.failed";
      readonly error: RuntimeFailure;
      readonly at: string;
    }
  | {
      readonly type: "run.aborted";
      readonly cancellation: RuntimeCancellation;
      readonly at: string;
    };

/** Applies one validated transition without mutating the previous state. */
export function applyRuntimeTransition<Payload, Result>(
  state: RunState<Payload, Result>,
  transition: RuntimeTransition<Payload, Result>,
): RunState<Payload, Result> {
  if (isRunTerminal(state.status)) {
    throw new Error(`Run ${state.id} is already terminal`);
  }

  switch (transition.type) {
    case "run.started":
      requireState(state.status === "created", "Run must be created before start");
      return freezeState({
        ...state,
        version: state.version + 1,
        status: "running",
        startedAt: transition.at,
      });

    case "user_turn.started": {
      requireRunningRun(state);
      requireState(
        state.currentUserTurnId === undefined,
        "A UserTurn is already active",
      );
      requireState(
        transition.ordinal === state.userTurns.length + 1,
        "UserTurn ordinal is not contiguous",
      );
      requireState(
        !state.userTurns.some((turn) => turn.id === transition.userTurnId),
        `UserTurn ${transition.userTurnId} already exists`,
      );
      const turn: UserTurnState<Payload, Result> = Object.freeze({
        id: transition.userTurnId,
        ordinal: transition.ordinal,
        status: "running",
        input: transition.input,
        ...(transition.inputSource === undefined
          ? {}
          : { inputSource: transition.inputSource }),
        provenance: freezeUserTurnProvenance(transition.provenance),
        startedAt: transition.at,
        steps: Object.freeze([] as StepState[]),
      });
      return freezeState({
        ...state,
        version: state.version + 1,
        currentUserTurnId: transition.userTurnId,
        userTurns: Object.freeze([...state.userTurns, turn]),
      });
    }

    case "step.started": {
      const turn = requireActiveTurn(state, transition.userTurnId);
      const previousStep = turn.steps.at(-1);
      requireState(
        transition.ordinal === turn.steps.length + 1,
        "Step ordinal is not contiguous",
      );
      requireState(
        !turn.steps.some((step) => step.id === transition.stepId),
        `Step ${transition.stepId} already exists`,
      );
      requireState(
        previousStep === undefined || previousStep.status === "completed",
        "A Step can start only after the previous Step completed",
      );
      const step: StepState = Object.freeze({
        id: transition.stepId,
        ordinal: transition.ordinal,
        status: "running",
        startedAt: transition.at,
      });
      return replaceTurn(state, Object.freeze({
        ...turn,
        steps: Object.freeze([...turn.steps, step]),
      }));
    }

    case "step.completed":
      return finishStep(state, transition.userTurnId, transition.stepId, {
        status: "completed",
        endedAt: transition.at,
        reason: transition.reason,
      });

    case "step.failed":
      return finishStep(state, transition.userTurnId, transition.stepId, {
        status: "failed",
        endedAt: transition.at,
        reason: transition.error.message,
        error: transition.error,
      });

    case "step.aborted":
      return finishStep(state, transition.userTurnId, transition.stepId, {
        status: "aborted",
        endedAt: transition.at,
        reason: transition.reason,
      });

    case "user_turn.completed": {
      const turn = requireActiveTurn(state, transition.userTurnId);
      requireState(
        turn.steps.at(-1)?.status === "completed",
        "A completed UserTurn requires a completed Step",
      );
      return finishTurn(state, Object.freeze({
        ...turn,
        status: "completed",
        endedAt: transition.at,
        result: transition.result,
      }));
    }

    case "user_turn.failed": {
      const turn = requireActiveTurn(state, transition.userTurnId);
      return finishTurn(state, Object.freeze({
        ...turn,
        status: "failed",
        endedAt: transition.at,
        error: freezeFailure(transition.error),
      }));
    }

    case "user_turn.aborted": {
      const turn = requireActiveTurn(state, transition.userTurnId);
      return finishTurn(state, Object.freeze({
        ...turn,
        status: "aborted",
        endedAt: transition.at,
        cancellation: freezeCancellation(transition.cancellation),
      }));
    }

    case "control.queued":
      requireRunningRun(state);
      if (transition.kind === "steer") {
        requireState(
          currentUserTurn(state)?.status === "running",
          "Steering requires an active UserTurn",
        );
      }
      return freezeState({
        ...state,
        version: state.version + 1,
        pendingSteering: state.pendingSteering +
          (transition.kind === "steer" ? 1 : 0),
        queuedFollowUps: state.queuedFollowUps +
          (transition.kind === "follow_up" ? 1 : 0),
      });

    case "control.steering_delivered":
      requireRunningRun(state);
      requireState(
        currentStep(state)?.status === "running",
        "Steering delivery requires an active Step",
      );
      requireState(
        transition.controlIds.length > 0,
        "Steering delivery must contain at least one control",
      );
      requireState(
        new Set(transition.controlIds).size === transition.controlIds.length,
        "Steering delivery contains duplicate controls",
      );
      requireState(
        transition.controlIds.length <= state.pendingSteering,
        "Delivered steering exceeds the pending count",
      );
      return freezeState({
        ...state,
        version: state.version + 1,
        pendingSteering: state.pendingSteering - transition.controlIds.length,
      });

    case "control.follow_up_dequeued":
      requireRunningRun(state);
      requireState(state.queuedFollowUps > 0, "No follow-up is queued");
      return freezeState({
        ...state,
        version: state.version + 1,
        queuedFollowUps: state.queuedFollowUps - 1,
      });

    case "control.follow_ups_preempted":
      requireRunningRun(state);
      requireState(
        transition.controlIds.length > 0,
        "Follow-up preemption must contain at least one control",
      );
      requireState(
        transition.controlIds.length <= state.queuedFollowUps,
        "Preempted follow-ups exceed the pending count",
      );
      return freezeState({
        ...state,
        version: state.version + 1,
        queuedFollowUps: state.queuedFollowUps - transition.controlIds.length,
      });

    case "control.rejected":
      requireRunningRun(state);
      return freezeState({ ...state, version: state.version + 1 });

    case "control.duplicate":
      requireRunningRun(state);
      return freezeState({ ...state, version: state.version + 1 });

    case "run.cancel_requested":
      requireRunningRun(state);
      return freezeState({
        ...state,
        version: state.version + 1,
        pendingSteering: 0,
        queuedFollowUps: 0,
        cancellation: freezeCancellation(transition.cancellation),
      });

    case "run.completion_deferred":
      requireRunningRun(state);
      return freezeState({
        ...state,
        version: state.version + 1,
        completionHolds: state.completionHolds + 1,
      });

    case "run.completion_released":
      requireRunningRun(state);
      requireState(state.completionHolds > 0, "No completion hold is active");
      return freezeState({
        ...state,
        version: state.version + 1,
        completionHolds: state.completionHolds - 1,
      });

    case "run.completed":
      requireRunningRun(state);
      requireState(
        state.currentUserTurnId === undefined,
        "Cannot complete a Run with an active UserTurn",
      );
      requireState(
        state.userTurns.at(-1)?.status === "completed",
        "A completed Run requires a completed UserTurn",
      );
      requireState(
        state.pendingSteering === 0 &&
          state.queuedFollowUps === 0 &&
          state.completionHolds === 0,
        "Cannot complete a Run with pending work",
      );
      return terminalRun(state, {
        status: "completed",
        endedAt: transition.at,
        result: transition.result,
      });

    case "run.failed":
      requireNoActiveUserTurn(state, "fail");
      return terminalRun(state, {
        status: "failed",
        endedAt: transition.at,
        error: freezeFailure(transition.error),
      });

    case "run.aborted":
      requireNoActiveUserTurn(state, "abort");
      return terminalRun(state, {
        status: "aborted",
        endedAt: transition.at,
        cancellation: freezeCancellation(transition.cancellation),
      });
  }
}

export function freezeRuntimeTransition<Payload, Result>(
  transition: RuntimeTransition<Payload, Result>,
): RuntimeTransition<Payload, Result> {
  if ("error" in transition) {
    return Object.freeze({
      ...transition,
      error: freezeFailure(transition.error),
    });
  }
  if ("cancellation" in transition) {
    return Object.freeze({
      ...transition,
      cancellation: freezeCancellation(transition.cancellation),
    });
  }
  if (
    transition.type === "control.steering_delivered" ||
    transition.type === "control.follow_ups_preempted"
  ) {
    return Object.freeze({
      ...transition,
      controlIds: Object.freeze([...transition.controlIds]),
    });
  }
  if (transition.type === "user_turn.started") {
    if (
      transition.inputSource !== undefined &&
      transition.inputSource !== "user" &&
      transition.inputSource !== "follow_up" &&
      transition.inputSource !== "unknown"
    ) {
      throw new Error("Unknown Runtime input source");
    }
    return Object.freeze({
      ...transition,
      input: cloneAndFreezePlainValue(transition.input) as Payload,
      provenance: freezeUserTurnProvenance(transition.provenance),
    });
  }
  if (
    transition.type === "user_turn.completed" ||
    transition.type === "run.completed"
  ) {
    return Object.freeze({
      ...transition,
      result: cloneAndFreezePlainValue(transition.result) as Result,
    });
  }
  return Object.freeze({ ...transition });
}

function freezeUserTurnProvenance(
  provenance: UserTurnProvenance,
): UserTurnProvenance {
  if (
    provenance.origin !== "run_input" &&
    provenance.origin !== "follow_up"
  ) {
    throw new Error("Unknown UserTurn provenance origin");
  }
  if (
    typeof provenance.source !== "string" ||
    provenance.source.trim().length === 0
  ) {
    throw new Error("UserTurn provenance source must not be empty");
  }
  if (
    typeof provenance.receivedAt !== "string" ||
    provenance.receivedAt.trim().length === 0
  ) {
    throw new Error("UserTurn provenance receivedAt must not be empty");
  }
  if (
    provenance.origin === "follow_up" &&
    (typeof provenance.controlId !== "string" ||
      provenance.controlId.trim().length === 0)
  ) {
    throw new Error("Follow-up UserTurn provenance requires a control id");
  }
  if (
    provenance.origin === "run_input" &&
    provenance.controlId !== undefined
  ) {
    throw new Error("Initial UserTurn provenance cannot carry a control id");
  }
  return Object.freeze({ ...provenance });
}

function finishStep<Payload, Result>(
  state: RunState<Payload, Result>,
  userTurnId: UserTurnId,
  stepId: AgentStepId,
  terminal: Pick<StepState, "status" | "endedAt" | "reason"> & {
    readonly error?: RuntimeFailure;
  },
): RunState<Payload, Result> {
  const turn = requireActiveTurn(state, userTurnId);
  const step = currentStep(state);
  requireState(step?.id === stepId, "Step is not the active Step");
  requireState(step.status === "running", "Step is already terminal");
  const finished = Object.freeze({
    ...step,
    ...terminal,
    ...(terminal.error === undefined
      ? {}
      : { error: freezeFailure(terminal.error) }),
  });
  return replaceTurn(state, Object.freeze({
    ...turn,
    steps: Object.freeze([...turn.steps.slice(0, -1), finished]),
  }));
}

function finishTurn<Payload, Result>(
  state: RunState<Payload, Result>,
  turn: UserTurnState<Payload, Result>,
): RunState<Payload, Result> {
  requireState(
    turn.steps.at(-1)?.status !== "running",
    "Cannot finish a UserTurn with an active Step",
  );
  const replaced = replaceTurn(state, turn);
  const { currentUserTurnId: _currentUserTurnId, ...withoutCurrent } = replaced;
  return freezeState({
    ...withoutCurrent,
    version: state.version + 1,
    pendingSteering: 0,
  });
}

function replaceTurn<Payload, Result>(
  state: RunState<Payload, Result>,
  turn: UserTurnState<Payload, Result>,
): RunState<Payload, Result> {
  const index = state.userTurns.findIndex((candidate) => candidate.id === turn.id);
  requireState(index >= 0, `UserTurn ${turn.id} does not belong to the Run`);
  const userTurns = [...state.userTurns];
  userTurns[index] = turn;
  return freezeState({
    ...state,
    version: state.version + 1,
    userTurns: Object.freeze(userTurns),
  });
}

function terminalRun<Payload, Result>(
  state: RunState<Payload, Result>,
  terminal:
    | { readonly status: "completed"; readonly endedAt: string; readonly result: Result }
    | { readonly status: "failed"; readonly endedAt: string; readonly error: RuntimeFailure }
    | {
        readonly status: "aborted";
        readonly endedAt: string;
        readonly cancellation: RuntimeCancellation;
      },
): RunState<Payload, Result> {
  const { currentUserTurnId: _currentUserTurnId, ...withoutCurrent } = state;
  return freezeState({
    ...withoutCurrent,
    ...terminal,
    version: state.version + 1,
    pendingSteering: 0,
    queuedFollowUps: 0,
    completionHolds: 0,
  });
}

function requireActiveTurn<Payload, Result>(
  state: RunState<Payload, Result>,
  userTurnId: UserTurnId,
): UserTurnState<Payload, Result> {
  requireRunningRun(state);
  const turn = currentUserTurn(state);
  requireState(turn?.id === userTurnId, "UserTurn is not active");
  requireState(turn.status === "running", "UserTurn is already terminal");
  return turn;
}

function requireRunningRun<Payload, Result>(
  state: RunState<Payload, Result>,
): void {
  requireState(state.status === "running", "Run is not running");
}

function requireNoActiveUserTurn<Payload, Result>(
  state: RunState<Payload, Result>,
  action: "fail" | "abort",
): void {
  requireRunningRun(state);
  requireState(
    state.currentUserTurnId === undefined,
    `Cannot ${action} a Run with an active UserTurn`,
  );
}

function requireState(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function freezeFailure(error: RuntimeFailure): RuntimeFailure {
  return Object.freeze({
    ...error,
    ...(error.details === undefined
      ? {}
      : {
          details: cloneAndFreezePlainValue(error.details) as Readonly<
            Record<string, unknown>
          >,
        }),
  });
}

function freezeCancellation(
  cancellation: RuntimeCancellation,
): RuntimeCancellation {
  return Object.freeze({ ...cancellation });
}

function freezeState<Payload, Result>(
  state: RunState<Payload, Result>,
): RunState<Payload, Result> {
  return Object.freeze(state);
}

function cloneAndFreezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezePlainValue));
  }
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneAndFreezePlainValue(item),
      ]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
