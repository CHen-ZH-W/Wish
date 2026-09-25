import type { Context } from "@deepseek-ai/cordis";

import { createGrepTool } from "./model-tool.js";
import { ManagedToolOwner } from "../../../tools/managed.js";

/** Model-facing Grep Consumer over the Filesystem Search service. */
export const Grep = {
  name: "grep-tool",
  inject: ["tools", "filesystemSearch"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "grep_consumer", codeReload: true });
    owner.register(createGrepTool({ search: ctx.filesystemSearch }));
  },
};
