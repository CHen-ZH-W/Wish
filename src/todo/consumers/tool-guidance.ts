import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

export default {
  name: "todo-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "todo_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "todo.progress",
      order: 510,
      requiredTools: ["todo_write"],
      content: [
        "Use todo_write to show and maintain progress for multi-step work in the current UserTurn. Mark completed work promptly. Parallel items may be in_progress together. When spawning a child for an item, pass that item's id as spawn_agent.todoId; Host then follows its execution and updates its status.",
        "Todo is turn-local progress. It does not start work, create a durable task graph, or activate a Goal.",
      ].join("\n"),
    });
  },
};
