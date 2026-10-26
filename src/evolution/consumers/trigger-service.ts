import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { digest } from "../../agent-profiles/validation.js";
import { EvolutionTrigger, StorageEvolutionTriggerStore, type EvolutionTriggerConfig, type EvolutionTriggerSuggestion } from "../triggers.js";
import type {} from "../service.js";
import { statfs } from "node:fs/promises";

interface Config { readonly mode?: "off" | "advisory" | "automatic"; readonly minConfidence?: number; readonly intervalMs?: number; readonly maxDailyModelCalls?: number; readonly maxDailyTokens?: number; readonly minFreeDiskBytes?: number }
const Config: s<Config> = s.object({ mode: s.union(["off", "advisory", "automatic"]).default("off"), minConfidence: s.number().min(0).max(1).default(0.8), intervalMs: s.number().min(5_000).default(30_000), maxDailyModelCalls: s.number().step(1).min(0).default(9), maxDailyTokens: s.number().step(1).min(0).default(96_000), minFreeDiskBytes: s.number().step(1).min(0).default(64 * 1024 * 1024) });
/** Optional Host scheduler. Domain persistence and candidate execution stay owned by Evolution. */
export default class EvolutionTriggerService extends Service {
  static readonly inject = ["evolution", "storageBackend", "runtimeLifecycle", "sessions", "launch"];
  static readonly Config = Config;
  readonly trigger: EvolutionTrigger;
  private readonly work: PluginWorkOwner;
  private readonly retirement = new AbortController();
  private flight: Promise<void> | undefined;
  private readonly origins = new Map<string, { sessionId: string; workspaceRoot: string; traceIds: readonly string[] }>();
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "evolutionTrigger");
    this.trigger = new EvolutionTrigger({ store: new StorageEvolutionTriggerStore(ctx.storageBackend.acquire(ctx.storageBackend.id, { kv: {} })),
      config: { mode: config.mode ?? "off", targets: ["prompt"], minConfidence: config.minConfidence ?? 0.8 },
      ports: {
        listSuggestions: signal => this.suggestions(signal),
        isUserBusy: async () => {
          const events = await ctx.runtimeLifecycle.readEvents(undefined, this.retirement.signal), active = new Set<string>();
          for (const event of events) {
            if (event.type === "run.opened") active.add(event.runId);
            if (["run.completed", "run.failed", "run.aborted", "run.interrupted"].includes(event.type)) active.delete(event.runId);
          }
          return active.size > 0;
        },
        assessResources: async () => {
          const campaigns = await ctx.evolution.list();
          if (campaigns.some(item => ["running", "waiting-input", "interrupted", "reconciliation-required"].includes(item.state))) return { available: false, reason: "research-capacity-busy" };
          const recent = campaigns.filter(item => Date.parse(item.createdAt) >= Date.now() - 86_400_000);
          if (recent.some(item => !item.usage.complete)) return { available: false, reason: "research-accounting-incomplete" };
          // Reserve the complete next bounded campaign before dispatching it.
          if (recent.reduce((sum, item) => sum + item.usage.modelCalls, 0) + 3 > (config.maxDailyModelCalls ?? 9) || recent.reduce((sum, item) => sum + item.usage.tokens, 0) + 32_000 > (config.maxDailyTokens ?? 96_000)) return { available: false, reason: "daily-research-budget" };
          try {
            const application = ctx.get("application"); if (!application || !ctx.get("models")) return { available: false, reason: "model-unavailable" };
            const host = await application.resolve(), disk = await statfs(host.dataDirectory);
            return disk.bavail * disk.bsize < (config.minFreeDiskBytes ?? 64 * 1024 * 1024) ? { available: false, reason: "disk-capacity-low" } : { available: true };
          } catch { return { available: false, reason: "resources-unavailable" }; }
        },
        dispatch: async (suggestion, context) => {
          context.signal.throwIfAborted();
          const origin = this.origins.get(suggestion.id);
          if (!origin) throw new Error("evolution_trigger_evidence_unavailable");
          const sessions = ctx.sessions.acquire();
          try {
            const session = await sessions.manager.get({ sessionId: origin.sessionId, signal: context.signal });
            if (session.status !== "active" || session.scope !== origin.workspaceRoot) throw new Error("evolution_trigger_session_unavailable");
          } finally { sessions.release(); }
          const campaign = await ctx.evolution.begin({ objective: suggestion.summary, requestId: context.operationId,
            target: suggestion.target, ...origin, hypothesis: "Repeated symptoms are a hypothesis; inspect alternative causes in the fixed traces." });
          return { campaignId: campaign.id, settled: settled(campaign.state) };
        },
        reconcile: async entry => {
          const campaign = (await ctx.evolution.list()).find(item => item.requestId === entry.operationId);
          return campaign ? { campaignId: campaign.id, settled: settled(campaign.state) } : undefined;
        },
      },
    });
    this.work = new PluginWorkOwner(ctx, { code: "evolution_trigger", codeReload: true, replacement: "generation", beforeDrain: () => { this.retirement.abort(); this.trigger.suspend(); }, close: () => this.trigger.close() });
    ctx.effect(() => {
      let timer: ReturnType<typeof setInterval> | undefined, disposed = false;
      const start = () => {
        if (disposed || this.retirement.signal.aborted) return;
        timer = setInterval(() => { void this.scan().catch(error => { if (!this.retirement.signal.aborted) ctx.logger.warn("Evolution trigger deferred", error); }); }, config.intervalMs ?? 30_000);
        timer.unref();
        void this.scan().catch(error => { if (!this.retirement.signal.aborted) ctx.logger.warn("Evolution trigger deferred", error); });
      };
      const reload = ctx.root.get("codeReload"); if (reload) reload.startWhenReady(ctx, start); else start();
      return () => { disposed = true; clearInterval(timer); };
    }, "Evolution evidence trigger");
  }
  get mode(): EvolutionTriggerConfig["mode"] { return this.trigger.configuration.mode; }
  async inspectSession(sessionId: string) {
    return this.work.run(async () => {
      if (this.mode === "off") return { mode: this.mode, suggestions: [] };
      const suggestions = await this.trigger.listAdvisories(this.retirement.signal);
      return { mode: this.mode, suggestions: suggestions.filter(item => this.origins.get(item.id)?.sessionId === sessionId) };
    });
  }
  private scan(): Promise<void> {
    if (this.flight) return this.flight;
    const flight = this.work.run(async () => {
      if (this.mode === "off") return;
      await this.trigger.recover(this.retirement.signal);
      const [snapshot, campaigns] = await Promise.all([this.trigger.snapshot(), this.ctx.evolution.list()]);
      for (const entry of snapshot.dispatches) {
        if (entry.status !== "dispatched") continue;
        const campaign = campaigns.find(item => item.id === entry.campaignId);
        if (campaign && settled(campaign.state)) await this.trigger.markSettled(entry.operationId, campaign.id);
      }
      if (this.ctx.evolution.available) await this.trigger.tick(this.retirement.signal);
    });
    this.flight = flight;
    void flight.finally(() => { if (this.flight === flight) this.flight = undefined; }).catch(() => {});
    return flight;
  }
  private async suggestions(signal: AbortSignal): Promise<readonly EvolutionTriggerSuggestion[]> {
    const traces = await this.ctx.evolution.traces(), groups = new Map<string, typeof traces>();
    for (const trace of traces) {
      if (!trace.sessionId) continue;
      const group = groups.get(trace.sessionId) ?? []; groups.set(trace.sessionId, [...group, trace]);
    }
    const origins = new Map<string, { sessionId: string; workspaceRoot: string; traceIds: readonly string[] }>(), suggestions: EvolutionTriggerSuggestion[] = [];
    const sessions = this.ctx.sessions.acquire();
    try {
    for (const [sessionId, rows] of groups) {
      signal.throwIfAborted();
      let session;
      try { session = await sessions.manager.get({ sessionId, signal }); }
      catch (error) { if (signal.aborted) throw error; continue; }
      if (session.status !== "active") continue;
      for (const ticket of this.ctx.evolution.diagnose(rows)) {
        origins.set(ticket.id, { sessionId, workspaceRoot: session.scope, traceIds: ticket.traceIds });
        suggestions.push({ id: ticket.id, target: ticket.target, failureCategory: ticket.failureCategory, confidence: ticket.confidence,
          taskIds: rows.filter(row => ticket.traceIds.includes(row.id)).map(row => row.taskId), evidenceDigest: digest(ticket.traceDigests), summary: ticket.problem });
      }
    }
    } finally { sessions.release(); }
    // Keep identities captured by an in-flight tick even when a UI refresh discovers newer evidence.
    if (new Set([...this.origins.keys(), ...origins.keys()]).size > 10_000) throw new Error("evolution_trigger_origin_limit");
    for (const [id, origin] of origins) if (!this.origins.has(id)) this.origins.set(id, origin);
    return suggestions;
  }
}
function settled(state: string): boolean { return !["running", "waiting-input", "paused", "interrupted", "reconciliation-required"].includes(state); }
declare module "@deepseek-ai/cordis" { interface Context { evolutionTrigger: EvolutionTriggerService } }
