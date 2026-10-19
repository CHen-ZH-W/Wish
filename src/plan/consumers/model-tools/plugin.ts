import { ManagedToolOwner } from "../../../tools/managed.js";
import type { Context } from "@deepseek-ai/cordis";

import { createPlanTools } from "./tools.js";

const PLAN_TOOL_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  enter_plan_mode: ["plan.state", "human.review", "session.resume"],
  read_plan: ["plan.state"],
  update_plan: ["plan.state", "human.review", "session.resume"],
  exit_plan_mode: ["plan.state", "human.review", "session.resume"],
});

export const PlanTools = {
  name: "plan-tools",
  inject: ["tools", "plan"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "plan_tools", codeReload: true });
    for (const definition of createPlanTools(ctx.plan)) {
      owner.register(definition, undefined, {
        requires: PLAN_TOOL_REQUIREMENTS[definition.name] ?? [],
      });
    }
  },
};

export default PlanTools;
