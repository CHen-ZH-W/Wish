import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

export default {
  name: "tasks-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "tasks_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "tasks.plan-graph",
      order: 540,
      requiredTools: ["update_plan", "tasks_update"],
      content: [
        "When work is intended for an approved task-graph Workflow, save the Plan first, then use tasks_update in active Plan mode to attach the exact graph before submitting the Plan for human review.",
        "tasks_update defines dependencies and execution roles; it does not execute tasks. A turn-local Todo list is not a task graph.",
      ].join("\n"),
    });
  },
};
