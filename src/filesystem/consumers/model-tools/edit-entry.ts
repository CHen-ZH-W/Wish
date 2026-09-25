import type { Context } from "@deepseek-ai/cordis";
import { createEditTool } from "./edit.js";
import { ManagedToolOwner } from "../../../tools/managed.js";

/** Model Consumer over the provider-neutral Filesystem service. */
export default {
  name: "edit-tool",
  inject: ["tools", "filesystem"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "edit_consumer", codeReload: true });
    owner.register(createEditTool({ filesystem: ctx.filesystem }));
  },
};
