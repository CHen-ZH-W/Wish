import type { Context } from "@deepseek-ai/cordis";
import { ManagedToolOwner } from "../../tools/managed.js";
import { createWorkflowControlTools } from "./model-tools.js";

/** Mutating Workflow controls depend on the child Scheduler; durable reads do not. */
export default { name: "workflow-control-tools", inject: ["tools", "workflow", "workflowScheduler"], apply(ctx: Context) {
  const owner = new ManagedToolOwner(ctx, { code: "workflow_control_tools", codeReload: true });
  for (const tool of createWorkflowControlTools(ctx.workflow.state, ctx.workflowScheduler.children)) owner.register(tool);
} };
