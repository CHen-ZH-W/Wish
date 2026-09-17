import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { MemoryCurationService } from "../curation/service.js";
import { MemoryCurationScheduler } from "../curation/scheduler.js";
import { DomainCurationStore } from "../curation/store.js";
import { RecapMemoryCandidateExtractor } from "../curation/extractor.js";
import { registerPluginLifecycle } from "../../boot/plugin-control/lifecycle.js";

export interface Config { readonly backendId?: string; readonly automatic?: boolean; readonly intervalMs?: number; readonly maxConcurrent?: number; readonly maxAttempts?: number; readonly timeoutMs?: number }
export const Config: s<Config> = s.object({ backendId: s.string(), automatic: s.boolean(), intervalMs: s.number().step(1).min(1).max(3_600_000),
  maxConcurrent: s.number().step(1).min(1).max(16), maxAttempts: s.number().step(1).min(1).max(32), timeoutMs: s.number().step(1).min(1).max(300_000) });
export default class StorageMemoryCuration extends MemoryCurationService {
  static readonly inject = ["memory", "storageBackend"];
  static readonly Config = Config;
  readonly scheduler: MemoryCurationScheduler;
  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx);
    const lease = ctx.storageBackend.acquire(config.backendId ?? ctx.storageBackend.id, { kv: { list: false } });
    try {
      this.scheduler = new MemoryCurationScheduler({ memory: ctx.memory,
        store: new DomainCurationStore(lease, lease.id, ctx.memory.libraryId), extractor: new RecapMemoryCandidateExtractor(),
        ...(config.maxConcurrent === undefined ? {} : { maxConcurrent: config.maxConcurrent }),
        ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        onError: error => ctx.logger.warn("Memory curation background pass failed", error),
      });
      let lifecycleClose: Promise<void> | undefined;
      registerPluginLifecycle(ctx, () => {
        const state = this.scheduler.lifecycleSnapshot();
        const pending = state.activeJobs + state.scanning + state.ticking + state.sourceReads;
        return { disposition: pending ? "drain" : "direct", code: pending ? "memory_curation_draining" : "memory_curation_idle",
          counts: { jobs: state.activeJobs, scans: state.scanning, ticks: state.ticking, reads: state.sourceReads } };
      }, () => {
        const resume = this.scheduler.suspendAdmissions();
        return { close: () => lifecycleClose ??= this.scheduler.close(), release: () => { if (!lifecycleClose) resume(); } };
      });
      ctx.effect(() => () => this.scheduler.close().finally(() => lease.release()), "memory.curation.close");
    } catch (error) { lease.release(); throw error; }
  }
  async [Service.init]() { await this.scheduler.recover(); if (this.config.automatic === true) this.scheduler.start(this.config.intervalMs); }
}
