import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import type { StorageBackendLease } from "../storage/backend.js";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { DomainInteractionStore } from "./store.js";
import { InteractionRuntime } from "./runtime.js";
import type { ConversationInteraction, OpenInteraction, RespondInteraction } from "./types.js";

export interface Config { readonly backendId?: string }
export const Config: s<Config> = s.object({ backendId: s.string() });
/** Shared product interaction state; neither Core nor conversation presentation owns it. */
export class Interactions extends Service {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;
  private readonly lease: StorageBackendLease;
  private readonly runtime: InteractionRuntime;
  private readonly ready: Promise<void>;
  private readonly work: PluginWorkOwner;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "interactions");
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: true } });
    this.runtime = new InteractionRuntime(new DomainInteractionStore(this.lease, backendId));
    this.ready = this.runtime.recover(); void this.ready.catch(() => {});
    this.work = new PluginWorkOwner(ctx, { code: "interactions", codeReload: true,
      blocked: () => this.runtime.waitingCount ? "interactions_waiting_for_user" : undefined,
      beforeDrain: () => { void this.runtime.close().catch(() => {}); }, close: async () => { try { await this.runtime.close(); } finally { this.lease.release(); } } });
  }
  private call<T>(action: () => Promise<T>) { return this.work.run(async () => { await this.ready; return action(); }); }
  readonly get = (sessionId: string) => this.call(() => this.runtime.get(sessionId));
  readonly open = (request: OpenInteraction) => this.call(() => this.runtime.open(request));
  readonly respond = (sessionId: string, response: RespondInteraction) => this.call(() => this.runtime.respond(sessionId, response));
  readonly interrupt = (sessionId: string, reason: string, runId?: string) => this.call(() => this.runtime.interrupt(sessionId, reason, runId));
  readonly delete = (sessionId: string) => this.call(() => this.runtime.delete(sessionId));
  readonly wait = (request: ConversationInteraction, signal?: AbortSignal) => this.work.run(() => this.runtime.wait(request, signal));
}
declare module "@deepseek-ai/cordis" { interface Context { interactions: Interactions } }
export default Interactions;
