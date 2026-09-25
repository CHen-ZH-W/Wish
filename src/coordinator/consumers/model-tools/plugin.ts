import { ManagedToolOwner } from "../../../tools/managed.js";
import type { Context } from "@deepseek-ai/cordis";

import { createCoordinatorTools } from "./tools.js";

export const CoordinatorTools = {
  name: "coordinator-tools",
  inject: ["tools", "coordinator"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "coordinator_tools", codeReload: true });
    for (const definition of createCoordinatorTools(ctx.coordinator)) {
      owner.register(definition);
    }
  },
};

export default CoordinatorTools;
