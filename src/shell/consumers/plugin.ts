import type { Context } from "@deepseek-ai/cordis";

import { createBashTool } from "./model-tool.js";

/** Model-facing synchronous Bash Consumer over the Shell service. */
export const Bash = {
  name: "bash-tool",
  inject: ["tools", "shell", "toolOutputArtifacts"],
  apply(ctx: Context): void {
    ctx.tools.register(createBashTool({
      shell: ctx.shell,
      artifacts: ctx.toolOutputArtifacts,
    }));
  },
};
