import type { Context } from "@deepseek-ai/cordis";
import type { SessionFeature } from "../../apps/session-features.js";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SessionTitleService } from "../service.js";

interface TitleFeatureError {
  readonly sessionId: string;
  readonly operation: "accept" | "cancel";
  readonly errorCode: string;
}

/** Title failures are isolated from admission; cleanup still belongs to the feature. */
export function createSessionTitleFeature(
  titles: Pick<SessionTitleService, "accept" | "cancel" | "purge">,
  onError?: (event: TitleFeatureError) => void,
  sessionGraph?: object,
): SessionFeature {
  const attempt = async (sessionId: string, operation: "accept" | "cancel", action: () => Promise<void>) => {
    try { await action(); }
    catch { try { onError?.({ sessionId, operation, errorCode: "session_title_unavailable" }); } catch { /* Diagnostic sinks cannot reject a primary operation. */ } }
  };
  return {
    ...(sessionGraph === undefined ? {} : { sessionGraph }),
    retainOwnershipOnUnload: false,
    purgeOrder: 90,
    async inspect() { return undefined; },
    async act() { throw new Error("No session title action is registered"); },
    async runStarted(_application, handle, context) {
      if (context?.inputSource !== "user") return;
      await attempt(handle.scope, "accept", () => titles.accept({
        sessionId: handle.scope, text: context.text, inputId: handle.initialUserTurnId,
        ...(context.model === undefined ? {} : { model: context.model }),
      }));
    },
    async metadataUpdated(session) {
      if (session.titleSource === "manual") await attempt(session.sessionId, "cancel", () => titles.cancel(session.sessionId));
    },
    async beforeRemoval(sessionId) { await titles.cancel(sessionId); },
    async purgeSession(sessionId) { await titles.purge(sessionId); },
  };
}

export default {
  name: "session-title-session-feature", inject: ["application", "sessionTitle", "sessions"],
  apply(ctx: Context) {
    registerManagedSessionFeature(ctx, "session-title", createSessionTitleFeature(ctx.sessionTitle,
      event => ctx.logger.warn(JSON.stringify({ event: "session_title_feature_failed", ...event })), ctx.sessions.manager), { codeReload: true });
  },
};
