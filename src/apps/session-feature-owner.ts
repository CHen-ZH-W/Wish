import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { SessionFeature } from "./session-features.js";

/** Generic admission and cleanup, with feature state remaining domain-owned. */
export function registerManagedSessionFeature(ctx: Context, key: string, feature: SessionFeature, options: { readonly codeReload?: boolean } = {}): void {
  const work = new PluginWorkOwner(ctx, { code: "session_feature", ...options, close: () => { unregister(); } });
  const unregister = ctx.application.registerSessionFeature(key, {
    inspect: sessionId => work.run(() => feature.inspect(sessionId)),
    act: (sessionId, action, token, feedback) => work.run(() => feature.act(sessionId, action, token, feedback)),
    ...(feature.beforeInput ? { beforeInput: (sessionId: string, text: string) => work.run(() => feature.beforeInput!(sessionId, text)) } : {}),
    ...(feature.beforeRemoval ? { beforeRemoval: (sessionId: string) => work.run(() => feature.beforeRemoval!(sessionId)) } : {}),
  });
}
