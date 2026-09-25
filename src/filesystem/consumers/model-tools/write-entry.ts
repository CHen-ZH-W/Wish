import type { Context } from "@deepseek-ai/cordis";
import { createWriteTool } from "./write.js";
import { ManagedToolOwner } from "../../../tools/managed.js";

/** Model Consumer over the provider-neutral Filesystem service. */
export default {
  name: "write-tool",
  inject: ["tools", "filesystem"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "write_consumer", codeReload: true });
    owner.register(createWriteTool({ filesystem: ctx.filesystem }));
  },
};
