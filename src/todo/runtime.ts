import type {
  OpenTodoTurnRequest,
  ReplaceTodoRequest,
  Todo,
  TodoItem,
  TodoState,
  TodoStatus,
} from "./types.js";

export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_CONTENT_CHARS = 500;

export class TodoRuntime implements Todo {
  private readonly states = new Map<string, TodoState>();
  private tail = Promise.resolve();
  private closed = false;

  async get(sessionId: string): Promise<TodoState | undefined> {
    await this.tail;
    return this.states.get(requireId(sessionId, "Todo session id"));
  }

  openTurn(request: OpenTodoTurnRequest): Promise<TodoState> {
    return this.serial(() => {
      const sessionId = requireId(request.sessionId, "Todo session id");
      const runId = requireId(request.runId, "Todo Run id");
      const userTurnId = requireId(request.userTurnId, "Todo UserTurn id");
      const current = this.states.get(sessionId);
      if (current?.runId === runId && current.userTurnId === userTurnId) {
        return current;
      }
      const openedAt = request.openedAt ?? new Date().toISOString();
      const state = Object.freeze({
        schemaVersion: 1 as const,
        sessionId,
        runId,
        userTurnId,
        revision: 0,
        items: Object.freeze([] as TodoItem[]),
        openedAt,
        updatedAt: openedAt,
      });
      this.states.set(sessionId, state);
      return state;
    });
  }

  replace(request: ReplaceTodoRequest): Promise<TodoState> {
    return this.serial(() => {
      const sessionId = requireId(request.sessionId, "Todo session id");
      const runId = requireId(request.runId, "Todo Run id");
      const userTurnId = requireId(request.userTurnId, "Todo UserTurn id");
      const current = this.states.get(sessionId);
      if (current === undefined) throw new Error("Todo UserTurn is not open");
      if (current.runId !== runId || current.userTurnId !== userTurnId) {
        throw new Error("Todo UserTurn identity conflict");
      }
      const items = normalizeTodoItems(request.items);
      const next = Object.freeze({
        ...current,
        revision: current.revision + 1,
        items,
        updatedAt: new Date().toISOString(),
      });
      this.states.set(sessionId, next);
      return next;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    this.states.clear();
  }

  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Todo service closed"));
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function normalizeTodoItems(input: readonly TodoItem[]): readonly TodoItem[] {
  if (!Array.isArray(input)) throw new Error("todos must be an array");
  if (input.length > MAX_TODO_ITEMS) {
    throw new Error(`todos must contain at most ${MAX_TODO_ITEMS} items`);
  }
  const ids = new Set<string>();
  let inProgress = 0;
  const items = input.map((item, index) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`todos[${index}] must be an object`);
    }
    const id = requireId(item.id, `todos[${index}].id`);
    if (ids.has(id)) throw new Error(`Duplicate Todo id: ${id}`);
    ids.add(id);
    const content = requireText(item.content, `todos[${index}].content`);
    if (content.length > MAX_TODO_CONTENT_CHARS) {
      throw new Error(`todos[${index}].content is too long`);
    }
    const status = requireStatus(item.status, index);
    if (status === "in_progress" && ++inProgress > 1) {
      throw new Error("Only one Todo may be in_progress");
    }
    return Object.freeze({ id, content, status });
  });
  return Object.freeze(items);
}

function requireStatus(value: unknown, index: number): TodoStatus {
  if (value !== "pending" && value !== "in_progress" && value !== "completed") {
    throw new Error(`todos[${index}].status is invalid`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value.trim();
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be non-empty trimmed text`);
  }
  return value;
}
