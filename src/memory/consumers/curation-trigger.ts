import type { Context } from "@deepseek-ai/cordis";
import type { SessionFeature } from "../../apps/session-features.js";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { MemoryCurationService } from "../curation/service.js";

export function createCurationTrigger(
  curation: Pick<MemoryCurationService, "wake"> & Partial<Pick<MemoryCurationService, "recordUsage">>, sessionGraph: object, isActive: () => boolean = () => true,
): SessionFeature {
  const wake = (sessionId: string) => { try { if (isActive()) curation.wake(sessionId); } catch { /* Background retirement cannot reject user input. */ } };
  return {
    sessionGraph, retainOwnershipOnUnload: false,
    async inspect() { return undefined; },
    async act() { throw new Error("No background curation action"); },
    async runStarted(application, handle, context) {
      if (context?.inputSource !== "user" || !context.text.trim()) return;
      wake(handle.scope);
      // Completion provides another opportunity to recover interrupted background work.
      void handle.completion.then(async () => {
        if (isActive() && curation.recordUsage) {
          try {
            const history = await application.readSessionHistory({ sessionId: handle.scope });
            const sources = new Set<string>();
            for (const record of history.records) {
              if (record.kind !== "message" || record.runId !== handle.runId || record.message.role !== "assistant") continue;
              for (const block of record.message.content.matchAll(/<wish-memory-citation>([\s\S]*?)<\/wish-memory-citation>/gu))
                for (const match of block[1]!.matchAll(/rollout_summaries\/(curation-[a-f0-9]{64})\.md/gu)) sources.add(match[1]!);
            }
            if (isActive() && sources.size) await curation.recordUsage([...sources]);
          } catch { /* A memory usage failure cannot fail a completed foreground Run. */ }
        }
        wake(handle.scope);
      }, () => wake(handle.scope));
    },
  };
}

export default {
  name: "memory-curation-trigger", inject: ["application", "memoryCuration", "sessions"],
  apply(ctx: Context) {
    let active = true;
    ctx.effect(() => () => { active = false; }, "memory.curation.trigger.close");
    registerManagedSessionFeature(ctx, "memory-curation-trigger", createCurationTrigger(ctx.memoryCuration, ctx.sessions.manager, () => active), { codeReload: true });
  },
};
