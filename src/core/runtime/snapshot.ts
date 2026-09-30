import type {
  AgentId,
  AgentMetadata,
  AgentRunId,
  RunInputSource,
  UserTurnId,
} from "../agent/types.js";
import type { RuntimeControlMessage } from "./control.js";
import {
  currentStep,
  currentUserTurn,
  type AgentStepId,
  type RunState,
  type RunStatus,
  type StepState,
  type UserTurnState,
} from "./state.js";

export type RuntimeEnvironment = Readonly<Record<string, unknown>>;

export interface RunSnapshot<Payload = unknown, Result = unknown> {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly runId: AgentRunId;
  readonly agentId: AgentId;
  readonly scope: string;
  readonly parentRunId?: AgentRunId;
  readonly metadata?: AgentMetadata;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly currentUserTurnId?: UserTurnId;
  readonly userTurns: readonly UserTurnSnapshot<Payload, Result>[];
  readonly pendingSteering: number;
  readonly queuedFollowUps: number;
  readonly completionHolds: number;
  readonly result?: Result;
  readonly error?: RunState<Payload, Result>["error"];
  readonly cancellation?: RunState<Payload, Result>["cancellation"];
}

export type UserTurnSnapshot<Payload = unknown, Result = unknown> = Readonly<
  UserTurnState<Payload, Result>
>;

/** Immutable execution authority and input captured once for a Step. */
export interface StepSnapshot<Payload = unknown> {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly stateVersion: number;
  readonly run: {
    readonly runId: AgentRunId;
    readonly agentId: AgentId;
    readonly scope: string;
    readonly parentRunId?: AgentRunId;
  };
  readonly userTurn: {
    readonly userTurnId: UserTurnId;
    readonly ordinal: number;
    readonly input: Payload;
    readonly inputSource?: RunInputSource;
    readonly provenance: UserTurnState<Payload>["provenance"];
  };
  readonly step: {
    readonly stepId: AgentStepId;
    readonly ordinal: number;
  };
  readonly steering: readonly RuntimeControlMessage<"steer">[];
  /** Model, Tool, world-state, and authority projections supplied by a Port. */
  readonly environment: RuntimeEnvironment;
}

export function snapshotRun<Payload, Result>(
  state: RunState<Payload, Result>,
): RunSnapshot<Payload, Result> {
  return Object.freeze({
    schemaVersion: 1 as const,
    version: state.version,
    runId: state.id,
    agentId: state.agentId,
    scope: state.scope,
    ...(state.parentRunId === undefined
      ? {}
      : { parentRunId: state.parentRunId }),
    ...(state.metadata === undefined ? {} : { metadata: state.metadata }),
    status: state.status,
    createdAt: state.createdAt,
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    ...(state.endedAt === undefined ? {} : { endedAt: state.endedAt }),
    ...(state.currentUserTurnId === undefined
      ? {}
      : { currentUserTurnId: state.currentUserTurnId }),
    userTurns: Object.freeze(state.userTurns.map(snapshotUserTurn)),
    pendingSteering: state.pendingSteering,
    queuedFollowUps: state.queuedFollowUps,
    completionHolds: state.completionHolds,
    ...("result" in state ? { result: state.result } : {}),
    ...(state.error === undefined
      ? {}
      : { error: Object.freeze({ ...state.error }) }),
    ...(state.cancellation === undefined
      ? {}
      : { cancellation: Object.freeze({ ...state.cancellation }) }),
  });
}

export function snapshotUserTurn<Payload, Result>(
  turn: UserTurnState<Payload, Result>,
): UserTurnSnapshot<Payload, Result> {
  return Object.freeze({
    ...turn,
    steps: Object.freeze(turn.steps.map(snapshotStepState)),
  });
}

export function captureStepSnapshot<Payload, Result>(input: {
  readonly state: RunState<Payload, Result>;
  readonly step: StepState;
  readonly steering: readonly RuntimeControlMessage<"steer">[];
  readonly environment: RuntimeEnvironment;
  readonly capturedAt: string;
}): StepSnapshot<Payload> {
  const turn = currentUserTurn(input.state);
  if (turn === undefined || turn.status !== "running") {
    throw new Error("Cannot capture a Step without an active UserTurn");
  }
  if (input.step.status !== "running") {
    throw new Error("Cannot capture a terminal Step");
  }
  const activeStep = currentStep(input.state);
  if (
    activeStep?.id !== input.step.id ||
    activeStep.ordinal !== input.step.ordinal
  ) {
    throw new Error("Cannot capture a Step that is not active");
  }
  const steering = input.steering.map((message) => {
    if (
      message.kind !== "steer" ||
      message.runId !== input.state.id ||
      message.userTurnId !== turn.id
    ) {
      throw new Error("Step steering does not match the active Run and UserTurn");
    }
    return Object.freeze({ ...message });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    capturedAt: input.capturedAt,
    stateVersion: input.state.version,
    run: Object.freeze({
      runId: input.state.id,
      agentId: input.state.agentId,
      scope: input.state.scope,
      ...(input.state.parentRunId === undefined
        ? {}
        : { parentRunId: input.state.parentRunId }),
    }),
    userTurn: Object.freeze({
      userTurnId: turn.id,
      ordinal: turn.ordinal,
      input: turn.input,
      ...(turn.inputSource === undefined ? {} : { inputSource: turn.inputSource }),
      provenance: Object.freeze({ ...turn.provenance }),
    }),
    step: Object.freeze({
      stepId: input.step.id,
      ordinal: input.step.ordinal,
    }),
    steering: Object.freeze(steering),
    environment: freezeEnvironment(input.environment),
  });
}

function snapshotStepState(step: StepState): StepState {
  return Object.freeze({
    ...step,
    ...(step.error === undefined
      ? {}
      : { error: Object.freeze({ ...step.error }) }),
  });
}

function freezeEnvironment(
  environment: RuntimeEnvironment,
): RuntimeEnvironment {
  if (!isPlainRecord(environment)) {
    throw new Error("Step environment must be a plain record");
  }
  return freezePlainValue(environment) as RuntimeEnvironment;
}

function freezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezePlainValue));
  }
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezePlainValue(item)]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
