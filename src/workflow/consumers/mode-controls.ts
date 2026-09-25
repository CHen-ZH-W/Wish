import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
export const WorkflowPlanControls = { name: "workflow-plan-controls", inject: ["plan", "workflow"], apply(ctx: Context) {
  const release = ctx.plan.registerModeControl({ toolName: "workflow_read", resourcePrefix: "workflow." });
  new PluginWorkOwner(ctx, { code: "workflow_mode_controls", codeReload: true, close: release });
} };
export const WorkflowCoordinatorControls = { name: "workflow-coordinator-controls", inject: ["coordinator", "workflow"], apply(ctx: Context) {
  const releases = ["workflow_read", "workflow_start", "workflow_retry", "workflow_cancel"].map(toolName =>
    ctx.coordinator.registerModeControl({ toolName, resourcePrefix: "workflow." }));
  releases.push(ctx.coordinator.registerModeControl({ toolName: "tasks_read", resourcePrefix: "tasks." }));
  new PluginWorkOwner(ctx, { code: "workflow_mode_controls", codeReload: true,
    close: () => { for (const release of releases) release(); } });
} };
