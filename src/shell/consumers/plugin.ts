import type { Context } from "@deepseek-ai/cordis";

import { createBashTool } from "./model-tool.js";
import { ManagedToolOwner } from "../../tools/managed.js";

/** Model-facing synchronous Bash Consumer over the Shell service. */
export const Bash = {
  name: "bash-tool",
  inject: ["tools", "shell", "toolOutputArtifacts"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "bash_consumer", codeReload: true });
    owner.register(createBashTool({
      shell: ctx.shell,
      artifacts: ctx.toolOutputArtifacts,
    }));
  },
};
