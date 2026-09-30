import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SessionFeature } from "../../apps/session-features.js";
import type { Todo } from "../types.js";

export function createTodoSessionFeature(todo: Todo): SessionFeature {
  return {
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
      throw new Error("Todo is model-owned within the current UserTurn");
    },
  };
}

function marker(status: "pending" | "in_progress" | "completed"): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
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
