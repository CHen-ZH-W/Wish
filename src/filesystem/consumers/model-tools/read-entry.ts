import type { Context } from "@deepseek-ai/cordis";
import { createReadTool } from "./read.js";
import { ManagedToolOwner } from "../../../tools/managed.js";

/** Model Consumer over the provider-neutral Filesystem service. */
export default {
  name: "read-tool",
  inject: ["tools", "filesystem"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "read_consumer", codeReload: true });
    owner.register(createReadTool({ filesystem: ctx.filesystem }));
  },
};
