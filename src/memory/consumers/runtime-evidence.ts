import type { Context } from "@deepseek-ai/cordis";
import { SessionRunEvidenceSource } from "../adapters/session-evidence.js";
import "../curation/service.js";
import { registerPluginLifecycle } from "../../boot/plugin-control/lifecycle.js";
export const inject = ["memoryCuration", "runtimeLifecycle", "sessions"];
export function apply(ctx: Context): void {
  const sessions = ctx.sessions.acquire();
  try {
    const unregister = ctx.memoryCuration.registerSource(new SessionRunEvidenceSource(sessions.manager, ctx.runtimeLifecycle));
    let closing: Promise<void> | undefined;
    const close = () => closing ??= unregister().finally(() => sessions.release());
    registerPluginLifecycle(ctx, () => ({ disposition: "direct", code: "memory_runtime_evidence_idle" }),
      () => ({ close, release() {} }));
    ctx.effect(() => close, "memory.curation.sessions.release");
  } catch (error) { sessions.release(); throw error; }
}
