import type { Context } from "@deepseek-ai/cordis";
import { ManagedToolOwner } from "../../tools/managed.js";
import { createTaskUpdateTool } from "./model-tools.js";

export default { name: "task-update-tool", inject: ["tools", "tasks", "plan"], apply(ctx: Context) {
  const owner = new ManagedToolOwner(ctx, { code: "task_update_tool", codeReload: true });
  owner.register(createTaskUpdateTool(ctx.tasks, ctx.plan));
} };
