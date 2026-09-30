import type { ContextItem, ContextProvider } from "../core/context/projector.js";
import type { ContextInput } from "../context/types.js";
import type { Todo } from "./types.js";

export const TODO_CONTEXT_PROVIDER_ID = "todo-state";

export class TodoContextProvider implements ContextProvider<ContextInput> {
  readonly id = TODO_CONTEXT_PROVIDER_ID;

  constructor(private readonly todo: Todo) {}

  async provide(input: ContextInput, signal?: AbortSignal): Promise<readonly ContextItem[]> {
    signal?.throwIfAborted();
    const state = await this.todo.get(input.sessionId);
    signal?.throwIfAborted();
    if (
      state === undefined ||
      state.runId !== input.runId ||
      state.userTurnId !== input.userTurnId ||
      state.items.length === 0
    ) {
      return Object.freeze([]);
    }
    return Object.freeze([Object.freeze({
      id: `${TODO_CONTEXT_PROVIDER_ID}:current`,
      kind: "instruction" as const,
      placement: "dynamic_tail" as const,
      message: Object.freeze({
        role: "developer" as const,
        content: [
          "Current UserTurn Todo list (host state, not a durable task graph):",
          JSON.stringify({ revision: state.revision, items: state.items }, null, 2),
          "Keep this list current with todo_write. Replace the whole list; mark completed work promptly and keep at most one item in_progress.",
          "This list resets when the next UserTurn opens.",
        ].join("\n"),
      }),
    })]);
  }
}
