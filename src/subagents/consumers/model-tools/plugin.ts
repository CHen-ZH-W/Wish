import type { Context } from "@deepseek-ai/cordis";

import { createSubagentTools } from "./tools.js";
import { SubagentResultRelay } from "../../adapters/runtime-results.js";

export const SubagentTools = {
  name: "subagent-tools",
  inject: ["tools", "subagents"],
  apply(ctx: Context): void {
    const resultRelay = new SubagentResultRelay({ subagents: ctx.subagents });
    ctx.effect(() => () => resultRelay.close(), "subagent-result-relay.close");
    for (const definition of createSubagentTools({
      subagents: ctx.subagents,
      completionObserver: resultRelay,
    })) {
      ctx.tools.register(definition);
    }
  },
};

export default SubagentTools;
