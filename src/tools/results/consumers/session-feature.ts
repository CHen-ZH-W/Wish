import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../../apps/session-feature-owner.js";

export default {
  name: "tool-result-archive-session-feature",
  inject: ["application", "toolResultArchive"],
  apply(ctx: Context): void {
    registerManagedSessionFeature(ctx, "tool-result-archive", {
      purgeOrder: 80,
      inspect: async () => undefined,
      act: async () => { throw new Error("Tool Result archives are Session-owned"); },
      purgeSession: sessionId => ctx.toolResultArchive.purgeSession(sessionId),
    }, { codeReload: true });
  },
};
