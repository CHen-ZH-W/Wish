import type { Context } from "@deepseek-ai/cordis";
import type { SessionFeature } from "../../apps/session-features.js";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { MemoryCurationService } from "../curation/service.js";
import { parseMemoryCitations } from "../citations.js";

export function createCurationTrigger(
  curation: Pick<MemoryCurationService, "wake"> & Partial<Pick<MemoryCurationService, "recordUsage">>, sessionGraph: object, isActive: () => boolean = () => true,
): SessionFeature {
  const wake = (sessionId: string) => { try { if (isActive()) curation.wake(sessionId); } catch { /* Background retirement cannot reject user input. */ } };
  return {
    sessionGraph, retainOwnershipOnUnload: false,
    async inspect() { return undefined; },
    async act() { throw new Error("No background curation action"); },
    async runStarted(application, handle, context) {
      const startsLearning = context?.inputSource === "user" && !!context.text.trim();
      if (startsLearning) wake(handle.scope);
      if (!startsLearning && !curation.recordUsage) return;
      // Completion provides another opportunity to recover interrupted background work.
      void handle.completion.then(async () => {
        if (isActive() && curation.recordUsage) {
          try {
            const history = await application.readSessionHistory({ sessionId: handle.scope });
            for (const record of history.records) {
              if (record.kind !== "message" || record.runId !== handle.runId || record.message.role !== "assistant") continue;
              const sources = parseMemoryCitations(record.message.content).sourceIds;
              if (isActive() && sources.length) await curation.recordUsage(sources);
            }
          } catch { /* A memory usage failure cannot fail a completed foreground Run. */ }
        }
        if (startsLearning) wake(handle.scope);
      }, () => { if (startsLearning) wake(handle.scope); });
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
