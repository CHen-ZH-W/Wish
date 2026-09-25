import type { Context } from "@deepseek-ai/cordis";
import { SessionRunEvidenceSource } from "../adapters/session-evidence.js";
import "../curation/service.js";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
export const inject = ["memoryCuration", "runtimeLifecycle", "sessions"];
export function apply(ctx: Context): void {
  const sessions = ctx.sessions.acquire();
  try {
    let unregister: (() => Promise<void>) | undefined;
    const work = new PluginWorkOwner(ctx, { code: "memory_runtime_evidence", codeReload: true,
      close: async () => { try { await unregister?.(); } finally { sessions.release(); } } });
    const source = new SessionRunEvidenceSource(sessions.manager, ctx.runtimeLifecycle);
    unregister = ctx.memoryCuration.registerSource({ id: source.id, scan: signal => work.run(() => source.scan(signal)) });
  } catch (error) { sessions.release(); throw error; }
}
