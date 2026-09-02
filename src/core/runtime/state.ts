import type {
  AgentId,
  AgentMetadata,
  AgentRunId,
  UserTurnId,
} from "../agent/types.js";

export type AgentStepId = string;

export type RunStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type UserTurnStatus = "running" | "completed" | "failed" | "aborted";

export type StepStatus = "running" | "completed" | "failed" | "aborted";

export interface RuntimeFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RuntimeCancellation {
  readonly reason: string;
  readonly source: string;
  readonly requestedAt: string;
}

export interface StepState {
  readonly id: AgentStepId;
  readonly ordinal: number;
  readonly status: StepStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly reason?: string;
  readonly error?: RuntimeFailure;
}

export interface UserTurnState<Payload = unknown, Result = unknown> {
  readonly id: UserTurnId;
  readonly ordinal: number;
  readonly status: UserTurnStatus;
  readonly input: Payload;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly steps: readonly StepState[];
  readonly result?: Result;
  readonly error?: RuntimeFailure;
  readonly cancellation?: RuntimeCancellation;
}

/** Canonical process-local state for one Run and all of its UserTurns. */
export interface RunState<Payload = unknown, Result = unknown> {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly id: AgentRunId;
  readonly agentId: AgentId;
  readonly scope: string;
  readonly parentRunId?: AgentRunId;
  readonly metadata?: AgentMetadata;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly currentUserTurnId?: UserTurnId;
  readonly userTurns: readonly UserTurnState<Payload, Result>[];
  readonly pendingSteering: number;
  readonly queuedFollowUps: number;
  readonly completionHolds: number;
  readonly cancellation?: RuntimeCancellation;
  readonly result?: Result;
  readonly error?: RuntimeFailure;
}

export interface CreateRunStateInput {
  readonly runId: AgentRunId;
  readonly agentId: AgentId;
  readonly scope: string;
  readonly parentRunId?: AgentRunId;
  readonly metadata?: AgentMetadata;
  readonly createdAt: string;
}

export function createRunState<Payload, Result>(
  input: CreateRunStateInput,
): RunState<Payload, Result> {
  const runId = requireIdentifier(input.runId, "Run id");
  const agentId = requireIdentifier(input.agentId, "Agent id");
  const scope = normalizeScope(input.scope);
  const parentRunId = input.parentRunId === undefined
    ? undefined
    : requireIdentifier(input.parentRunId, "Parent Run id");
  if (parentRunId === runId) {
    throw new Error("A Run cannot be its own parent");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    version: 0,
    id: runId,
    agentId,
    scope,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(input.metadata === undefined
      ? {}
      : {
          metadata: cloneAndFreezePlainValue(
            input.metadata,
          ) as AgentMetadata,
        }),
    status: "created" as const,
    createdAt: requireIdentifier(input.createdAt, "Run createdAt"),
    userTurns: Object.freeze([] as UserTurnState<Payload, Result>[]),
    pendingSteering: 0,
    queuedFollowUps: 0,
    completionHolds: 0,
  });
}

export function currentUserTurn<Payload, Result>(
  state: RunState<Payload, Result>,
): UserTurnState<Payload, Result> | undefined {
  const id = state.currentUserTurnId;
  return id === undefined
    ? undefined
    : state.userTurns.find((turn) => turn.id === id);
}

export function currentStep<Payload, Result>(
  state: RunState<Payload, Result>,
): StepState | undefined {
  const turn = currentUserTurn(state);
  return turn?.steps.at(-1);
}

export function isRunTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

export function isUserTurnTerminal(status: UserTurnStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

export function isStepTerminal(status: StepStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
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
