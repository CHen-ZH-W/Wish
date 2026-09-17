import type { Context } from "@deepseek-ai/cordis";

import { createCoordinatorTools } from "./tools.js";

export const CoordinatorTools = {
  name: "coordinator-tools",
  inject: ["tools", "coordinator"],
  apply(ctx: Context): void {
    for (const definition of createCoordinatorTools(ctx.coordinator)) {
      ctx.tools.register(definition);
    }
  },
};

export default CoordinatorTools;
