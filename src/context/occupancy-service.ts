import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { ContextProjection } from "../core/context/projector.js";
import type { ContextInput } from "./types.js";
import type { SessionContextOccupancyView } from "./consumers/webui-types.js";
import { captureContextOccupancy, projectContextOccupancy } from "./occupancy.js";
import { ContextOccupancyStore } from "./occupancy-store.js";

export interface Config { readonly backendId?: string }
export const Config: s<Config> = s.object({ backendId: s.string() });

/** Context owns this observer and its durable presentation metadata. */
export class ContextOccupancy extends Service {
  static readonly inject = ["storageBackend", "contextEngine", "sessions", "modelAttemptLedger", "application"];
  static readonly Config = Config;
  private readonly store: ContextOccupancyStore;
  private readonly work: PluginWorkOwner;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "contextOccupancy");
    const backendId = config.backendId ?? ctx.storageBackend.id;
    const lease = ctx.storageBackend.acquire(backendId, { kv: {} });
    try { this.store = new ContextOccupancyStore(lease, backendId); }
    catch (error) { lease.release(); throw error; }
    let removeObserver: (() => void) | undefined, removeFeature: (() => void) | undefined;
    this.work = new PluginWorkOwner(ctx, { code: "context_occupancy", codeReload: true,
      beforeDrain: () => { removeObserver?.(); removeFeature?.(); }, close: () => { lease.release(); } });
    const observer = ctx.contextEngine.registerObserver("context-occupancy", (input, projection) => this.record(input, projection));
    removeObserver = () => { observer.unregister(); };
    removeFeature = ctx.application.registerSessionFeature("context-occupancy", {
      purgeOrder: 44,
      // These are Session facts; terminal-Run cleanup must retain the meter.
      purgeSession: sessionId => this.work.run(() => this.store.clear(sessionId)),
      inspect: async () => undefined,
      async act() { throw new Error("Context occupancy is read-only"); },
    });
  }

  record(input: ContextInput, projection: ContextProjection): Promise<void> {
    return this.work.run(async () => {
      // Public Session services supply the configured data root and deletion guard.
      await this.ctx.sessions.manager.get({ sessionId: input.sessionId });
      const [history, attempts] = await Promise.all([
        this.ctx.sessions.manager.readHistory({ sessionId: input.sessionId }),
        this.ctx.modelAttemptLedger.list({ sessionId: input.sessionId, runId: input.runId, stepId: input.stepId }),
      ]);
      const snapshot = captureContextOccupancy(input, projection, history, attempts);
      await this.store.record(snapshot);
    });
  }

  inspect(sessionId: string, signal?: AbortSignal): Promise<SessionContextOccupancyView> {
    return this.work.run(async () => {
      signal?.throwIfAborted();
      const [snapshots, attempts, history] = await Promise.all([
        this.store.get(sessionId, signal),
        this.ctx.modelAttemptLedger.list({ sessionId }, signal),
        this.ctx.sessions.manager.readHistory({ sessionId, ...(signal ? { signal } : {}) }),
      ]);
      signal?.throwIfAborted();
      return projectContextOccupancy(sessionId, snapshots, attempts, history);
    });
  }
}

declare module "@deepseek-ai/cordis" { interface Context { contextOccupancy: ContextOccupancy } }
export default ContextOccupancy;
