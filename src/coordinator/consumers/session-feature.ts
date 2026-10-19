import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";

/** Coordinator owns Run state, including cleanup after a terminal Run. */
export default {
  name: "coordinator-session-feature",
  inject: ["application", "coordinator"],
  apply(ctx: Context): void {
    registerManagedSessionFeature(ctx, "coordinator", {
      purgeOrder: 30,
      inspect: async () => undefined,
      act: async () => { throw new Error("Coordinator state is Run-owned"); },
      purgeRun: (sessionId, runId) => ctx.coordinator.clear({ sessionId, runId }),
      purgeSession: sessionId => ctx.coordinator.clearSession(sessionId),
    }, { codeReload: true });
  },
};
