import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";

/** Prevent a Session from becoming read-only while it still owns retained PTYs. */
export default {
  name: "user-terminal-session-feature",
  inject: ["application", "userTerminal", "sessions", "workspace"],
  apply(ctx: Context): void {
    registerManagedSessionFeature(ctx, "user-terminal", {
      async inspect() { return undefined; },
      async act() { throw new Error("User Terminal controls are available in the Session sidebar"); },
      async beforeRemoval(sessionId) {
        const session = await ctx.sessions.manager.get({ sessionId });
        const workspace = await ctx.workspace.resolve({ root: session.scope });
        const terminals = await ctx.userTerminal.list(sessionId, workspace.root);
        if (terminals.length) throw new Error("请先在会话右侧栏关闭所有用户终端，再归档或删除会话。");
      },
    }, { codeReload: true });
  },
};
