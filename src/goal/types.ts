export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type GoalActivation = "armed" | "disarmed";

export interface GoalRef {
  readonly id: string;
  readonly revision: number;
}

export interface GoalBlockReason {
  readonly code: string;
  readonly message: string;
}

/** Durable Session-scoped state. Activation is intentionally absent. */
export interface GoalState extends GoalRef {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  /** Storage mutation version, including admitted rounds. */
  readonly version: number;
  readonly objective: string;
  readonly phase: GoalPhase;
  readonly blockedReason?: GoalBlockReason;
  readonly roundsStarted: number;
  readonly maxGoalRounds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalView extends GoalState {
  readonly activation: GoalActivation;
}

export interface GoalSessionRequest {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface CreateGoalRequest extends GoalSessionRequest {
  readonly objective: string;
  readonly maxGoalRounds?: number;
}

export interface MutateGoalRequest extends GoalSessionRequest {
  readonly ref: GoalRef;
}

export interface EditGoalRequest extends MutateGoalRequest {
  readonly objective?: string;
  readonly maxGoalRounds?: number;
}

export interface BlockGoalRequest extends MutateGoalRequest {
  readonly reason: GoalBlockReason;
}

export interface Goal {
  get(request: GoalSessionRequest): Promise<GoalView | undefined>;
  create(request: CreateGoalRequest): Promise<GoalView>;
  edit(request: EditGoalRequest): Promise<GoalView>;
  pause(request: MutateGoalRequest): Promise<GoalView>;
  resume(request: MutateGoalRequest): Promise<GoalView>;
  complete(request: MutateGoalRequest): Promise<GoalView>;
  block(request: BlockGoalRequest): Promise<GoalView>;
  clear(request: MutateGoalRequest): Promise<GoalRef>;
  disarm(request: GoalSessionRequest): Promise<GoalView | undefined>;
  admitRound(request: MutateGoalRequest): Promise<GoalView>;
  close(): Promise<void>;
}

export interface GoalStateStore {
  get(sessionId: string, signal?: AbortSignal): Promise<GoalState | undefined>;
  put(state: GoalState, expectedVersion?: number, signal?: AbortSignal): Promise<void>;
  delete(sessionId: string, expectedVersion: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
