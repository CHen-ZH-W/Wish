import type { Context } from "@deepseek-ai/cordis";
import { createReadTool } from "./read.js";
import type {} from "../../../boot/plugin-control/code-reload.js";
import type {} from "../../../boot/plugin-control/lifecycle.js";

/** Model Consumer over the provider-neutral Filesystem service. */
export default {
  name: "read-tool",
  inject: ["tools", "filesystem"],
  apply(ctx: Context): void {
    ctx.root.get("codeReload")?.register(ctx);
    const tool = createReadTool({ filesystem: ctx.filesystem });
    let active = 0, fenced = false, closed = false;
    const registration = ctx.tools.register({ ...tool, async execute(...args) {
      if (fenced || closed) throw Error("read_consumer_closed");
      active++;
      try { return await tool.execute(...args); } finally { active--; }
    } });
    ctx.root.get("pluginLifecycle")?.register(ctx, () => ({
      disposition: closed || active ? "blocked" : "direct",
      code: closed ? "read_consumer_closed" : active ? "read_requests_active" : "read_consumer_idle",
      counts: { requests: active },
    }), () => {
      if (fenced || closed) throw Error("read_consumer_closed");
      fenced = true;
      return {
        close: async () => {
          if (active) throw Error("read_requests_active");
          closed = true; registration.unregister();
        },
        release: () => { if (!closed) fenced = false; },
      };
    });
    ctx.effect(() => () => { closed = true; }, "Read Consumer admission");
  },
};
