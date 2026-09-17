import type { Context } from "@deepseek-ai/cordis";
import { SkillOwnerLifecycle } from "../lifecycle.js";

/** Optional plugins, each depending only on the mode it extends. */
export const SkillsPlanControls = {
  name: "skills-plan-controls", inject: ["skills", "plan"],
  apply(ctx: Context): void {
    const owner = new SkillOwnerLifecycle(ctx);
    for (const toolName of ["list_skills", "read_skill"]) owner.own(ctx.plan.registerModeControl({ toolName, resourcePrefix: "skills." }));
  },
};
export const SkillsCoordinatorControls = {
  name: "skills-coordinator-controls", inject: ["skills", "coordinator"],
  apply(ctx: Context): void {
    const owner = new SkillOwnerLifecycle(ctx);
    for (const toolName of ["list_skills", "read_skill"]) owner.own(ctx.coordinator.registerModeControl({ toolName, resourcePrefix: "skills." }));
  },
};
