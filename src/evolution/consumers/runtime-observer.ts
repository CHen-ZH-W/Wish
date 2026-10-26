import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { captureTaskTrace, type ToolArchiveEvidence } from "../observations.js";
import type {} from "../service.js";

/** Backscans committed facts. No execution hook or Core dependency on Evolution. */
export default {
  name: "evolution-runtime-observer", inject: ["evolution", "runtimeLifecycle", "sessions", "modelAttemptLedger", "launch"],
  apply(ctx: Context): void {
    if (ctx.launch.environment.WISH_EXPERIMENT_WORKER === "1") return;
    const sessions = ctx.sessions.acquire(), retirement = new AbortController();
    let scanning: Promise<number> | undefined;
    const work = new PluginWorkOwner(ctx, { code: "evolution_observer", codeReload: true, replacement: "generation", beforeDrain: () => retirement.abort(), close: () => { sessions.release(); } });
    const scan = (): Promise<number> => scanning ??= work.run(async () => {
      const events = await ctx.runtimeLifecycle.readEvents(undefined, retirement.signal);
      const scopes = new Map(events.filter(event => event.type === "run.opened" && event.scope).map(event => [event.runId, event.scope!]));
      const terminals = new Map(events.filter(event => ["run.completed", "run.failed", "run.aborted", "run.interrupted"].includes(event.type)).map(event => [event.runId, event]));
      const bindings = await ctx.get("agentProfiles")?.listBindings() ?? [];
      const archived = await ctx.evolution.archive.list();
      const known = new Set(archived.map(trace => trace.runId));
      const facts = await ctx.evolution.observationFacts();
      const needsOutcome = new Set(facts.outcomes.filter(outcome => !archived.some(trace => trace.runId === outcome.runId && trace.outcome?.evidenceDigest === outcome.evidenceDigest)).map(outcome => outcome.runId));
      const recent = new Set([...terminals.keys()].slice(-100));
      let captured = 0;
      for (const [runId] of terminals) {
        if (known.has(runId) && !recent.has(runId) && !needsOutcome.has(runId)) continue;
        retirement.signal.throwIfAborted();
        const sessionId = scopes.get(runId); if (!sessionId || sessionId.startsWith("evolution-")) continue;
        try {
          const [history, attempts, prompts] = await Promise.all([
            sessions.manager.readHistory({ sessionId, signal: retirement.signal }),
            ctx.modelAttemptLedger.list({ runId }, retirement.signal),
            ctx.get("systemPromptHistory")?.list(sessionId, retirement.signal) ?? Promise.resolve([]),
          ]);
          const binding = bindings.find(item => item.runId === runId);
          const origin = facts.origins.find(item => item.runId === runId), outcome = facts.outcomes.find(item => item.runId === runId);
          if (origin && origin.sessionId !== sessionId) throw new Error("evolution_trace_registered_session_mismatch");
          const toolArchives: ToolArchiveEvidence[] = [];
          const archive = ctx.get("toolResultArchive")?.open();
          try {
            let remaining = 64_000;
            const seen = new Set<string>();
            for (const record of history.records) {
              if (record.kind !== "message" || record.runId !== runId || !record.toolResultArchive || seen.has(record.toolResultArchive.toolCallId) || toolArchives.length >= 256) continue;
              const reference = record.toolResultArchive; seen.add(reference.toolCallId);
              const receipt = { toolCallId: reference.toolCallId, locator: reference.locator, hash: reference.hash };
              try {
                if (!archive) throw new Error("archive_unavailable");
                const row = await archive.read(reference, retirement.signal);
                if (row.sessionId !== sessionId || row.runId !== runId || row.result.callId !== reference.toolCallId || row.resultSha256 !== reference.hash) throw new Error("evolution_archive_identity_mismatch");
                const raw = JSON.stringify(row.result), preview = raw.slice(0, Math.min(4096, remaining)); remaining -= preview.length;
                toolArchives.push({ ...receipt, status: "available", untrustedPreview: preview, truncated: raw.length !== preview.length });
              } catch (error) {
                if (retirement.signal.aborted) throw error;
                toolArchives.push({ ...receipt, status: "unavailable" });
              }
            }
          } finally { archive?.release(); }
          await ctx.evolution.recordTrace(captureTaskTrace({ sessionId, runId, history, events, attempts, prompts,
            toolArchives, ...(origin ? { sourceKind: origin.sourceKind, taskId: origin.taskId } : {}), ...(outcome ? { outcome } : {}),
            ...(binding ? { profileSnapshotDigest: binding.snapshotDigest } : {}) })); captured++;
        } catch (error) {
          if (retirement.signal.aborted) throw error;
          ctx.logger.debug("Evolution could not capture a removed or unavailable Session", error);
        }
      }
      return captured;
    }).finally(() => { scanning = undefined; });
    ctx.effect(() => {
      let timer: ReturnType<typeof setInterval> | undefined, disposed = false;
      const start = () => {
        if (disposed || retirement.signal.aborted) return;
        timer = setInterval(() => { void scan().catch(error => { if (!retirement.signal.aborted) ctx.logger.warn("Evolution observation deferred", error); }); }, 15_000);
        timer.unref();
        void scan().catch(error => { if (!retirement.signal.aborted) ctx.logger.warn("Evolution observation deferred", error); });
      };
      const reload = ctx.root.get("codeReload"); if (reload) reload.startWhenReady(ctx, start); else start();
      return () => { disposed = true; clearInterval(timer); };
    }, "Evolution committed trace observation");
  },
};
