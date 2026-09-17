import type { Context } from "@deepseek-ai/cordis";

import { createPlanTools } from "./tools.js";

export const PlanTools = {
  name: "plan-tools",
  inject: ["tools", "plan"],
  apply(ctx: Context): void {
    for (const definition of createPlanTools(ctx.plan)) {
      ctx.tools.register(definition);
    }
  },
};

export default PlanTools;
