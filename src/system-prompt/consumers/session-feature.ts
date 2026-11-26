import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";

export default {
  name: "system-prompt-history-session-feature", inject: ["application", "systemPromptHistory", "sessions"],
  apply(ctx: Context): void {
    registerManagedSessionFeature(ctx, "system-prompt-history", {
      sessionGraph: ctx.sessions.manager, purgeOrder: 95,
      async inspect() { return undefined; },
      async act() { throw new Error("System Prompt history has no cleanup action"); },
      async purgeSession(sessionId) { await ctx.systemPromptHistory.purgeSession?.(sessionId); },
      async sweepDeletedSessions(wasDeleted) { await ctx.systemPromptHistory.sweepDeletedSessions?.(wasDeleted); },
    }, { codeReload: true });
  },
};
