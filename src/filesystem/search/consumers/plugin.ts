import type { Context } from "@deepseek-ai/cordis";

import { createGrepTool } from "./model-tool.js";

/** Model-facing Grep Consumer over the Filesystem Search service. */
export const Grep = {
  name: "grep-tool",
  inject: ["tools", "filesystemSearch"],
  apply(ctx: Context): void {
    ctx.tools.register(createGrepTool({ search: ctx.filesystemSearch }));
  },
};
