import type { Context } from "@deepseek-ai/cordis";
import { ManagedToolOwner } from "../../../tools/managed.js";

import { createSubagentTools } from "./tools.js";
import { SubagentResultRelay } from "../../adapters/runtime-results.js";
import { SubagentToolDispatchService } from "./dispatch.js";

export const SubagentTools = {
  name: "subagent-tools",
  inject: ["tools", "subagents"],
  apply(ctx: Context): void {
    const dispatch = new SubagentToolDispatchService(ctx, ctx.subagents);
    const resultRelay = new SubagentResultRelay({ subagents: ctx.subagents });
    const owner = new ManagedToolOwner(ctx, { code: "subagent_tools", codeReload: true,
      blocked: () => resultRelay.pendingResults ? "subagent_results_pending" : undefined,
      close: () => resultRelay.close() });
    for (const definition of createSubagentTools({
      subagents: ctx.subagents,
      dispatch: (request, context, grant) => dispatch.dispatch(request, context, grant),
      completionObserver: resultRelay,
    })) {
      owner.register(definition);
    }
  },
};

export default SubagentTools;
