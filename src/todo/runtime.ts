import type {
  OpenTodoTurnRequest,
  ReplaceTodoRequest,
  Todo,
  TodoChildWorkRequest,
  TodoChildWorkUpdate,
  TodoItem,
  TodoState,
  TodoStatus,
} from "./types.js";

export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_CONTENT_CHARS = 500;

export class TodoRuntime implements Todo {
  private readonly states = new Map<string, TodoState>();
  private readonly childWork = new Map<string, Map<string, { itemId: string; status: TodoChildWorkRequest["status"] }>>();
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
      this.childWork.delete(sessionId);
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
      const normalized = normalizeTodoItems(request.items);
      const bindings = this.childWork.get(sessionId);
      const ids = new Set(normalized.map(item => item.id));
      if (bindings) for (const [childId, binding] of bindings) if (!ids.has(binding.itemId)) bindings.delete(childId);
      const items = Object.freeze(normalized.map(item => {
        const bound = this.statusForItem(bindings, item.id);
        return bound === undefined ? item : Object.freeze({ ...item, status: bound });
      }));
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

  bindChild(request: TodoChildWorkRequest): Promise<TodoState | undefined> {
    return this.serial(() => {
      const current = this.currentTurn(request);
      if (!current) return undefined;
      const itemId = requireId(request.itemId, "Todo item id");
      const childId = requireId(request.childId, "Todo child id");
      const target = current.items.findIndex(item => item.id === itemId);
      if (target < 0) throw new Error(`Todo item ${itemId} does not exist`);
      const bindings = this.childWork.get(request.sessionId) ?? new Map();
      const existing = bindings.get(childId);
      if (existing && existing.itemId !== itemId) throw new Error("Todo child binding conflict");
      bindings.set(childId, { itemId, status: request.status });
      this.childWork.set(request.sessionId, bindings);
      const items = current.items.map((item, index) => {
        // Starting the next explicit phase closes prior unbound self-reported work.
        if (index < target && item.status === "in_progress" && !this.hasBoundWork(bindings, item.id)) {
          return Object.freeze({ ...item, status: "completed" as const });
        }
        if (item.id !== itemId) return item;
        return Object.freeze({ ...item, status: this.statusForItem(bindings, itemId)! });
      });
      return this.commit(current, items);
    });
  }

  updateChild(request: TodoChildWorkUpdate): Promise<TodoState | undefined> {
    return this.serial(() => {
      const current = this.currentTurn(request);
      if (!current) return undefined;
      const bindings = this.childWork.get(request.sessionId);
      const childId = requireId(request.childId, "Todo child id");
      const binding = bindings?.get(childId);
      if (!binding) return current;
      if (binding.status === request.status) return current;
      bindings!.set(childId, { ...binding, status: request.status });
      const status = this.statusForItem(bindings, binding.itemId)!;
      return this.commit(current, current.items.map(item => item.id === binding.itemId
        ? Object.freeze({ ...item, status }) : item));
    });
  }

  clear(sessionId: string, runId?: string): Promise<void> {
    return this.serial(() => {
      const id = requireId(sessionId, "Todo session id");
      if (runId === undefined || this.states.get(id)?.runId === requireId(runId, "Todo Run id")) {
        this.states.delete(id);
        this.childWork.delete(id);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    this.states.clear();
    this.childWork.clear();
  }

  private currentTurn(request: { readonly sessionId: string; readonly runId: string; readonly userTurnId: string }): TodoState | undefined {
    const current = this.states.get(requireId(request.sessionId, "Todo session id"));
    if (!current || current.runId !== request.runId || current.userTurnId !== request.userTurnId) return undefined;
    return current;
  }

  private hasBoundWork(bindings: Map<string, { itemId: string }> | undefined, itemId: string): boolean {
    return bindings !== undefined && [...bindings.values()].some(binding => binding.itemId === itemId);
  }

  private statusForItem(bindings: Map<string, { itemId: string; status: TodoChildWorkRequest["status"] }> | undefined, itemId: string): TodoStatus | undefined {
    const statuses = [...bindings?.values() ?? []].filter(binding => binding.itemId === itemId).map(binding => binding.status);
    if (!statuses.length) return undefined;
    if (statuses.includes("running")) return "in_progress";
    if (statuses.includes("failed")) return "failed";
    if (statuses.includes("stopped")) return "stopped";
    return "completed";
  }

  private commit(current: TodoState, items: readonly TodoItem[]): TodoState {
    if (items.every((item, index) => item.status === current.items[index]?.status)) return current;
    const next = Object.freeze({ ...current, revision: current.revision + 1,
      items: Object.freeze(items), updatedAt: new Date().toISOString() });
    this.states.set(current.sessionId, next);
    return next;
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
    return Object.freeze({ id, content, status });
  });
  return Object.freeze(items);
}

function requireStatus(value: unknown, index: number): TodoStatus {
  if (value !== "pending" && value !== "in_progress" && value !== "completed" && value !== "failed" && value !== "stopped") {
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
