import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { RespondInteraction } from "../types.js";
import { InteractionError } from "../validation.js";

export default {
  name: "interaction-session-feature", inject: ["interactions", "application"],
  apply(ctx: Context) {
    registerManagedSessionFeature(ctx, "conversation-interactions", {
      purgeOrder: 4,
      async inspect(sessionId) {
        const state = await ctx.interactions.get(sessionId);
        if (!state?.requests.length) return undefined;
        return { key: "conversation-interactions", title: "会话交互", titleEn: "Conversation interactions", text: state.requests.filter(r => r.status === "pending").map(r => r.title).join("\n"), data: state,
          token: { sessionId }, actions: state.requests.some(r => r.status === "pending") ? [{ name: "respond", label: "提交回答", labelEn: "Submit answer", feedback: true }] : [] };
      },
      async act(sessionId, action, token, feedback) {
        if (action !== "respond" || token.sessionId !== sessionId || !feedback) throw new InteractionError("interaction_invalid_response");
        const response: unknown = JSON.parse(feedback);
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new InteractionError("interaction_invalid_response");
        const value = response as RespondInteraction;
        if (Object.keys(value).some(k => !["requestId", "revision", "answers", "dismiss"].includes(k)) || typeof value.requestId !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.dismiss !== undefined && typeof value.dismiss !== "boolean") throw new InteractionError("interaction_invalid_response");
        await ctx.interactions.respond(sessionId, value);
      },
      async beforeInput(sessionId, _text, context) {
        // A composer submission dismisses the form, never fabricates a confirmed
        // answer before Runtime has admitted the new human input.
        if (context?.inputSource === "user" || context?.inputSource === "follow_up") await ctx.interactions.interrupt(sessionId, "continued-in-conversation", context.runId);
      },
      async purgeRun(sessionId, runId) { await ctx.interactions.interrupt(sessionId, "run-stopped", runId); },
      async purgeSession(sessionId) { await ctx.interactions.delete(sessionId); },
    }, { codeReload: true });
  },
};
