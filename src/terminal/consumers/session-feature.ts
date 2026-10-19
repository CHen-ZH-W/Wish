import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SessionFeature } from "../../apps/session-features.js";
import type { UserTerminalPort } from "../types.js";

/** Retained PTYs are owned by their Session and must drain before deletion. */
export function createUserTerminalSessionFeature(
  terminal: Pick<UserTerminalPort, "list" | "close">,
  getSession: (sessionId: string) => Promise<{ readonly scope: string }>,
): SessionFeature {
  return {
    async inspect() { return undefined; },
    async act() { throw new Error("User Terminal controls are available in the Session sidebar"); },
    async beforeRemoval(sessionId, operation) {
      const session = await getSession(sessionId);
      const terminals = await terminal.list(sessionId, session.scope);
      if (operation === "delete") {
        for (const item of terminals) await terminal.close(sessionId, session.scope, item.id);
        if ((await terminal.list(sessionId, session.scope)).length) throw new Error("会话终端仍未关闭，请稍后重试删除。");
        return;
      }
      if (terminals.length) throw new Error("请先在会话右侧栏关闭所有用户终端，再归档会话。");
    },
  };
}

export default {
  name: "user-terminal-session-feature",
  inject: ["application", "userTerminal", "sessions"],
  apply(ctx: Context): void {
    registerManagedSessionFeature(ctx, "user-terminal", createUserTerminalSessionFeature(
      ctx.userTerminal, sessionId => ctx.sessions.manager.get({ sessionId }),
    ), { codeReload: true });
  },
};
