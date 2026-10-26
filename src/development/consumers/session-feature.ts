import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import { currentChange } from "../controller.js";

/** Session disposal removes links, not project-owned requirements or evidence. */
export default {
  name: "wish-development-session-feature", inject: ["wishDevelopment", "application"],
  apply(ctx: Context): void {
    registerManagedSessionFeature(ctx, "wish-development", {
      purgeOrder: 5,
      async inspect(sessionId) {
        const { project } = await ctx.wishDevelopment.inspect(sessionId);
        if (!project) return undefined;
        const change = currentChange(project);
        return { key: "wish-development", title: "开发目标", titleEn: "Development goal", text: `${change.rawWish}\n\n${change.phase} · ${change.gate}`, data: project,
          token: { projectId: project.id, revision: project.revision, changeId: change.id }, actions: [] };
      },
      async act() { throw new Error("Use the exact-version Wish development controls"); },
      async runStarted(application, handle) { await ctx.wishDevelopment.observeConversationRun(application, handle); },
      async beforeInput(sessionId, text, context) { await ctx.wishDevelopment.beforeConversationInput(sessionId, text, context); },
      async beforeRemoval(sessionId) { await ctx.wishDevelopment.drainSession(sessionId); },
      async purgeSession(sessionId) { await ctx.wishDevelopment.detachSession(sessionId); },
    }, { codeReload: true });
  },
};
