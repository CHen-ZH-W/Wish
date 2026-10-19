import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SessionFeature } from "../../apps/session-features.js";
import type { Todo } from "../types.js";

export function createTodoSessionFeature(todo: Todo): SessionFeature {
  return {
    // This Run-owned list can be released as soon as the Run is terminal;
    // child/workflow cleanup may take longer and must not keep it visible.
    purgeOrder: 5,
    purgeRun(sessionId, runId) { return todo.clear(sessionId, runId); },
    purgeSession(sessionId) { return todo.clear(sessionId); },
    async inspect(sessionId) {
      const state = await todo.get(sessionId);
      if (state === undefined || state.items.length === 0) return undefined;
      const completed = state.items.filter((item) => item.status === "completed").length;
      return {
        key: "todo",
        title: `当前轮 Todo · ${completed}/${state.items.length}`,
        titleEn: `Current-turn Todo · ${completed}/${state.items.length}`,
        text: state.items.map((item) => `${marker(item.status)} ${item.content}`).join("\n"),
        data: state,
        token: {},
        actions: [],
      };
    },
    async act() {
      throw new Error("Todo has no Session action; use todo_write or linked execution progress");
    },
  };
}

function marker(status: "pending" | "in_progress" | "completed" | "failed" | "stopped"): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : status === "failed" ? "[!]" : status === "stopped" ? "[-]" : "[ ]";
}

export default {
  name: "todo-session-feature",
  inject: ["application", "todo"],
  apply(ctx: Context) {
    registerManagedSessionFeature(
      ctx,
      "todo",
      createTodoSessionFeature(ctx.todo),
      { codeReload: true },
    );
  },
};
