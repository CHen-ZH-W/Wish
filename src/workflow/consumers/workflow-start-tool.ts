import type { Context } from "@deepseek-ai/cordis";
import { ManagedToolOwner } from "../../tools/managed.js";
import { createWorkflowStartTool } from "./model-tools.js";
import type {} from "../service.js";

export default { name: "workflow-start-tool", inject: ["tools", "workflow", "workflowScheduler", "workflowGraphScheduler"], apply(ctx: Context) {
  const owner = new ManagedToolOwner(ctx, { code: "workflow_start_tool", codeReload: true });
  owner.register(createWorkflowStartTool(ctx.workflow.state, ctx.workflowScheduler.children, ctx.workflowGraphScheduler.graphs));
} };
