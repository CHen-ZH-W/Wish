import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../../../apps/session-feature-owner.js";

export default {
  name: "tool-output-artifacts-session-feature",
  inject: ["application", "toolOutputArtifacts"],
  apply(ctx: Context): void {
    registerManagedSessionFeature(ctx, "tool-output-artifacts", {
      purgeOrder: 75,
      inspect: async () => undefined,
      act: async () => { throw new Error("Tool output artifacts are Session-owned"); },
      purgeSession: sessionId => ctx.toolOutputArtifacts.purgeSession(sessionId),
    }, { codeReload: true });
  },
};
