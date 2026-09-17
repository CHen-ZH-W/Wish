import type { Context } from "@deepseek-ai/cordis";
import type {} from "../boot/plugin-control/lifecycle.js";
import type { SessionFeature } from "./session-features.js";
import type {} from "../boot/plugin-control/code-reload.js";

/** Generic lifecycle adapter, not a feature implementation or permission decision. */
export function registerManagedSessionFeature(ctx: Context, key: string, feature: SessionFeature, options: { readonly codeReload?: boolean } = {}): void {
  let closed = false, fenced = false;
  const pending = new Set<Promise<unknown>>();
  async function run<T>(action: () => Promise<T>): Promise<T> {
    if (closed || fenced) throw new Error("Session feature is unavailable");
    const work = Promise.resolve().then(() => { if (closed) throw new Error("Session feature is unavailable"); return action(); });
    pending.add(work);
    try { const value = await work; if (closed) throw new Error("Session feature was removed"); return value; }
    finally { pending.delete(work); }
  }
  const unregister = ctx.application.registerSessionFeature(key, {
    inspect: sessionId => run(() => feature.inspect(sessionId)),
    act: (sessionId, action, token, feedback) => run(() => feature.act(sessionId, action, token, feedback)),
    ...(feature.beforeInput ? { beforeInput: (sessionId: string, text: string) => run(() => feature.beforeInput!(sessionId, text)) } : {}),
    ...(feature.beforeRemoval ? { beforeRemoval: (sessionId: string) => run(() => feature.beforeRemoval!(sessionId)) } : {}),
  });
  const close = async () => { closed = true; unregister(); await Promise.allSettled([...pending]); };
  ctx.effect(() => close, `session-feature:${key}`);
  if (options.codeReload) ctx.root.get("codeReload")?.register(ctx, { prepare: () => {
    if (closed || fenced) throw Error("Session feature is unavailable");
    fenced = true;
    return { drained: Promise.allSettled([...pending]).then(() => {}), release: () => { if (!closed) fenced = false; } };
  } });
  if (options.codeReload && ctx.root.get("codeReload")) {
    fenced = true;
    ctx.root.get("codeReload")!.startWhenReady(ctx, () => { if (!closed) fenced = false; });
  }
  ctx.root.get("pluginLifecycle")?.register(ctx, () => ({ disposition: closed || pending.size ? "blocked" : "direct", code: closed ? "session_feature_closed" : pending.size ? "session_feature_busy" : "session_feature_idle", counts: { active_requests: pending.size } }), () => {
    if (closed || fenced || pending.size) throw new Error("Session feature is busy"); fenced = true;
    return { close, release() { if (!closed) fenced = false; } };
  });
}
