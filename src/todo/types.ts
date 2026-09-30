export type TodoStatus = "pending" | "in_progress" | "completed";

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

export interface Todo {
  get(sessionId: string): Promise<TodoState | undefined>;
  openTurn(request: OpenTodoTurnRequest): Promise<TodoState>;
  replace(request: ReplaceTodoRequest): Promise<TodoState>;
  close(): Promise<void>;
}
