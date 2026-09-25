import { ManagedToolOwner } from "../../../tools/managed.js";
import type { Context } from "@deepseek-ai/cordis";

import { createPlanTools } from "./tools.js";

export const PlanTools = {
  name: "plan-tools",
  inject: ["tools", "plan"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "plan_tools", codeReload: true });
    for (const definition of createPlanTools(ctx.plan)) {
      owner.register(definition);
    }
  },
};

export default PlanTools;
