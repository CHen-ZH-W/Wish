import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

/** Optional Plan policy contribution; Tasks state and Tool registrations stay independent. */
export default { name: "tasks-plan-controls", inject: ["tasks", "plan"], apply(ctx: Context) {
  const releases = ["tasks_read", "tasks_update"].map(toolName =>
    ctx.plan.registerModeControl({ toolName, resourcePrefix: "tasks." }));
  new PluginWorkOwner(ctx, { code: "tasks_plan_controls", codeReload: true,
    close: () => { for (const release of releases) release(); } });
} };
