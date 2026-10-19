export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "stopped";

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
}

/** Process-local standing list owned by exactly one UserTurn. */
export interface TodoState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly revision: number;
  readonly items: readonly TodoItem[];
  readonly openedAt: string;
  readonly updatedAt: string;
}

export interface OpenTodoTurnRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly openedAt?: string;
}

export interface ReplaceTodoRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly items: readonly TodoItem[];
}

/** An explicit link from one Todo item to a Host-owned child execution. */
export interface TodoChildWorkRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly itemId: string;
  readonly childId: string;
  readonly status: "running" | "completed" | "failed" | "stopped";
}

export interface TodoChildWorkUpdate {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly childId: string;
  readonly status: "running" | "completed" | "failed" | "stopped";
}

export interface Todo {
  get(sessionId: string): Promise<TodoState | undefined>;
  openTurn(request: OpenTodoTurnRequest): Promise<TodoState>;
  replace(request: ReplaceTodoRequest): Promise<TodoState>;
  bindChild(request: TodoChildWorkRequest): Promise<TodoState | undefined>;
  updateChild(request: TodoChildWorkUpdate): Promise<TodoState | undefined>;
  clear(sessionId: string, runId?: string): Promise<void>;
  close(): Promise<void>;
}
