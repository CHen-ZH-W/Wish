import type { Context } from "@deepseek-ai/cordis";
const names = ["memory_search", "memory_read"];
export const MemoryPlanControls = { name: "memory-plan-controls", inject: ["memory", "plan"], apply(ctx: Context) {
  for (const toolName of names) ctx.plan.registerModeControl({ toolName, resourcePrefix: "memory." });
} };
export const MemoryCoordinatorControls = { name: "memory-coordinator-controls", inject: ["memory", "coordinator"], apply(ctx: Context) {
  for (const toolName of names) ctx.coordinator.registerModeControl({ toolName, resourcePrefix: "memory." });
} };
