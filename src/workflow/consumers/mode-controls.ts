import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../boot/plugin-control/code-reload.js";
export const WorkflowPlanControls = { name: "workflow-plan-controls", inject: ["plan", "workflow"], apply(ctx: Context) {
  ctx.root.get("codeReload")?.register(ctx);
  ctx.plan.registerModeControl({ toolName: "workflow_read", resourcePrefix: "workflow." });
} };
export const WorkflowCoordinatorControls = { name: "workflow-coordinator-controls", inject: ["coordinator", "workflow"], apply(ctx: Context) {
  ctx.root.get("codeReload")?.register(ctx);
  for (const toolName of ["workflow_read", "workflow_start", "workflow_retry", "workflow_cancel"]) ctx.coordinator.registerModeControl({ toolName, resourcePrefix: "workflow." });
  ctx.coordinator.registerModeControl({ toolName: "tasks_read", resourcePrefix: "tasks." });
} };
