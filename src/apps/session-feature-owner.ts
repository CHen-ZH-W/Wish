import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { SessionFeature, SessionFeatureInputContext, SessionFeatureRunContext } from "./session-features.js";
import type { Session } from "../sessions/types.js";
import type { WishApplication, WishRunHandle } from "./types.js";

/** Generic admission and cleanup, with feature state remaining domain-owned. */
export function registerManagedSessionFeature(ctx: Context, key: string, feature: SessionFeature, options: { readonly codeReload?: boolean } = {}): void {
  const work = new PluginWorkOwner(ctx, { code: "session_feature", ...options, close: () => { unregister(); } });
  const unregister = ctx.application.registerSessionFeature(key, {
    ...(feature.sessionGraph === undefined ? {} : { sessionGraph: feature.sessionGraph }),
    ...(feature.retainOwnershipOnUnload === undefined ? {} : { retainOwnershipOnUnload: feature.retainOwnershipOnUnload }),
    ...(feature.purgeOrder === undefined ? {} : { purgeOrder: feature.purgeOrder }),
    inspect: sessionId => work.run(() => feature.inspect(sessionId)),
    act: (sessionId, action, token, feedback) => work.run(() => feature.act(sessionId, action, token, feedback)),
    ...(feature.beforeInput ? { beforeInput: (sessionId: string, text: string, context?: SessionFeatureInputContext) => work.run(() => feature.beforeInput!(sessionId, text, context)) } : {}),
    ...(feature.runStarted ? { runStarted: (application: WishApplication, handle: WishRunHandle, context?: SessionFeatureRunContext) => work.run(() => feature.runStarted!(application, handle, context)) } : {}),
    ...(feature.metadataUpdated ? { metadataUpdated: (session: Session) => work.run(() => feature.metadataUpdated!(session)) } : {}),
    ...(feature.beforeRemoval ? { beforeRemoval: (sessionId: string, operation?: "archive" | "delete") => work.run(() => feature.beforeRemoval!(sessionId, operation)) } : {}),
    ...(feature.purgeRun ? { purgeRun: (sessionId: string, runId: string) => work.run(() => feature.purgeRun!(sessionId, runId)) } : {}),
    ...(feature.purgeSession ? { purgeSession: (sessionId: string) => work.run(() => feature.purgeSession!(sessionId)) } : {}),
  });
}
