export interface CoordinatorState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly version: number;
  readonly active: boolean;
  readonly goal?: string;
  readonly enteredAt: string;
  readonly exitedAt?: string;
  readonly outcome?: string;
}

export interface CoordinatorRunRequest {
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export interface EnterCoordinatorRequest extends CoordinatorRunRequest {
  readonly sessionId: string;
  readonly goal?: string;
}

export interface ExitCoordinatorRequest extends CoordinatorRunRequest {
  readonly outcome?: string;
}

export interface Coordinator {
  get(request: CoordinatorRunRequest): Promise<CoordinatorState | undefined>;
  enter(request: EnterCoordinatorRequest): Promise<CoordinatorState>;
  exit(request: ExitCoordinatorRequest): Promise<CoordinatorState>;
  close(): Promise<void>;
}

export interface CoordinatorStateStore {
  get(runId: string, signal?: AbortSignal): Promise<CoordinatorState | undefined>;
  /** expectedVersion undefined means the Run must not exist yet. */
  put(
    state: CoordinatorState,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}
export interface CoordinatorModeControl { readonly toolName: string; readonly resourcePrefix: string }
