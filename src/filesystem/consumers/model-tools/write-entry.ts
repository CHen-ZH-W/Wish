import type { Context } from "@deepseek-ai/cordis";
import { createWriteTool } from "./write.js";

/** Model Consumer over the provider-neutral Filesystem service. */
export default {
  name: "write-tool",
  inject: ["tools", "filesystem"],
  apply(ctx: Context): void {
    ctx.tools.register(createWriteTool({ filesystem: ctx.filesystem }));
  },
};
