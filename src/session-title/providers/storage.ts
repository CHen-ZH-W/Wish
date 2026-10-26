import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type {} from "../../composition/runtime-service.js";
import type { StorageBackendLease } from "../../storage/backend.js";
import { TitleController } from "../controller.js";
import { SessionTitleService } from "../service.js";
import { DomainTitleJobStore } from "../store.js";
import type { TitleAcceptedInput, TitleConfig, TitleEvent } from "../types.js";

export interface Config extends TitleConfig { readonly backendId?: string }
export const Config: s<Config> = s.object({
  backendId: s.string(),
  maxConcurrent: s.number().step(1).min(1).max(16),
  timeoutMs: s.number().step(1).min(1).max(2147483647),
  maxAttempts: s.number().step(1).min(1).max(10),
  retryBaseMs: s.number().step(1).min(1).max(2147483647),
  retryMaxMs: s.number().step(1).min(1).max(2147483647),
  maxTitleBytes: s.number().step(1).min(1).max(256),
  fallbackMaxCodePoints: s.number().step(1).min(1).max(256),
  fallbackMaxBytes: s.number().step(1).min(1).max(768),
  seedMaxCodePoints: s.number().step(1).min(1).max(8000),
});

/** Storage owns the durable jobs; Sessions atomically accepts the final title. */
export default class StorageSessionTitles extends SessionTitleService {
  static readonly inject = ["sessions", "storageBackend", "sessionTitleGenerator", "runEngine"];
  static readonly Config = Config;
  private readonly lease: StorageBackendLease;
  private readonly controller: TitleController;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: false } });
    try {
      this.controller = new TitleController({
        sessions: ctx.sessions.manager,
        store: new DomainTitleJobStore({ storage: this.lease, backendId }),
        generator: { generate: input => ctx.sessionTitleGenerator.generate(input) },
        canDispatch: () => ctx.runEngine.lifecycleSnapshot().activeRuns === 0,
        config,
        onEvent: event => this.report(event),
      });
      this.work = new PluginWorkOwner(ctx, {
        code: "session_title", codeReload: true,
        suspendAdmissions: () => this.controller.suspendAdmissions(),
        beforeDrain: () => { void this.controller.close(); },
        close: () => this.controller.close().finally(() => this.lease.release()),
      });
    } catch (error) { this.lease.release(); throw error; }
  }

  async [Service.init](): Promise<void> {
    const start = this.controller.suspendAdmissions();
    try {
      await this.controller.resume();
      const reload = this.ctx.root.get("codeReload");
      if (reload) reload.startWhenReady(this.ctx, start);
      else start();
    } catch (error) {
      try { await this.close(); } catch { /* Preserve the recovery failure. */ }
      throw error;
    }
  }
  accept(input: TitleAcceptedInput): Promise<void> { return this.work.run(() => this.controller.accept(input)); }
  resume(): Promise<void> { return this.work.run(() => this.controller.resume()); }
  inspect(sessionId: string) { return this.work.run(() => this.controller.inspect(sessionId)); }
  cancel(sessionId: string): Promise<void> { return this.work.run(() => this.controller.cancel(sessionId)); }
  purge(sessionId: string): Promise<void> { return this.work.run(() => this.controller.purge(sessionId)); }
  close(): Promise<void> { return this.work.close(); }

  private report(event: TitleEvent): void {
    // Structured fields exclude title text, prompt text, credentials and Provider messages.
    const fields = JSON.stringify({ event: "session_title", ...event });
    if (event.errorCode) this.ctx.logger.warn(fields);
    else this.ctx.logger.info(fields);
  }
}
