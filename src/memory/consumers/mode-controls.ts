import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { Context } from "@deepseek-ai/cordis";
const names = ["memory_search", "memory_read"];
export const MemoryPlanControls = { name: "memory-plan-controls", inject: ["memory", "plan"], apply(ctx: Context) {
  const releases = names.map(toolName => ctx.plan.registerModeControl({ toolName, resourcePrefix: "memory." }));
  new PluginWorkOwner(ctx, { code: "memory_mode_controls", codeReload: true,
    close: () => { for (const release of releases) release(); } });
} };
export const MemoryCoordinatorControls = { name: "memory-coordinator-controls", inject: ["memory", "coordinator"], apply(ctx: Context) {
  const releases = names.map(toolName => ctx.coordinator.registerModeControl({ toolName, resourcePrefix: "memory." }));
  new PluginWorkOwner(ctx, { code: "memory_mode_controls", codeReload: true,
    close: () => { for (const release of releases) release(); } });
} };
