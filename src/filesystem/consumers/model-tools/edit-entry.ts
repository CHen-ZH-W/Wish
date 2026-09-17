import type { Context } from "@deepseek-ai/cordis";
import { createEditTool } from "./edit.js";

/** Model Consumer over the provider-neutral Filesystem service. */
export default {
  name: "edit-tool",
  inject: ["tools", "filesystem"],
  apply(ctx: Context): void {
    ctx.tools.register(createEditTool({ filesystem: ctx.filesystem }));
  },
};
