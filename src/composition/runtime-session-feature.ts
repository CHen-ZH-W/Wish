import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../apps/session-feature-owner.js";

export default {
  name: "runtime-history-session-feature", inject: ["application", "runtimeLifecycle", "sessions"],
  apply(ctx: Context): void {
    registerManagedSessionFeature(ctx, "runtime-history", {
      sessionGraph: ctx.sessions.manager, purgeOrder: 1000,
      async inspect() { return undefined; },
      async act() { throw new Error("Runtime history has no cleanup action"); },
      async purgeSession(sessionId) { await ctx.runtimeLifecycle.purgeSession?.(sessionId); },
      async sweepDeletedSessions(wasDeleted) { await ctx.runtimeLifecycle.sweepDeletedSessions?.(wasDeleted); },
    }, { codeReload: true });
  },
};
