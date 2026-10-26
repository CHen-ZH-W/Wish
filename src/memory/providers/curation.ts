import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { MemoryCurationService } from "../curation/service.js";
import { MemoryCurationScheduler } from "../curation/scheduler.js";
import { DomainCurationStore } from "../curation/store.js";
import { ModelMemoryExtractor, RecapMemoryExtractor } from "../curation/extractor.js";
import { BackgroundMemoryCuration } from "../curation/background.js";
import { WorkspaceMemoryConsolidator } from "../curation/workspace-consolidator.js";
import { MemoryWorkspace, writeMemoryFile } from "../curation/workspace.js";
import { SessionNotFoundError } from "../../sessions/types.js";
import { join } from "node:path";
import type {} from "../../models/service.js";
import type {} from "../../sessions/service.js";
import { registerPluginOwner } from "../../boot/plugin-control/owner-registry.js";

export interface Config {
  readonly backendId?: string;
  readonly automatic?: boolean;
  readonly extractor?: "model" | "recap";
  readonly model?: string;
  readonly consolidationModel?: string;
  readonly minIdleMs?: number;
  readonly maxAgeMs?: number;
  readonly maxUnusedDays?: number;
  readonly directory?: string;
}
export const Config: s<Config> = s.object({ backendId: s.string(), automatic: s.boolean(),
  extractor: s.union(["model", "recap"]), model: s.string(), consolidationModel: s.string(),
  directory: s.string(), maxUnusedDays: s.number().step(1).min(0), minIdleMs: s.number().step(1).min(0), maxAgeMs: s.number().step(1).min(1) });
export default class StorageMemoryCuration extends MemoryCurationService {
  static readonly inject = ["memory", "storageBackend", "models", "sessions"];
  static readonly Config = Config;
  readonly scheduler: MemoryCurationScheduler;
  readonly workspace: MemoryWorkspace;
  private readonly background: BackgroundMemoryCuration;
  private readonly noteWrites = new Set<Promise<unknown>>();
  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx);
    const lease = ctx.storageBackend.acquire(config.backendId ?? ctx.storageBackend.id, { kv: { list: false } });
    try {
      const openModel = async (signal: AbortSignal, requested?: string) => {
        signal.throwIfAborted();
        const configuration = await ctx.models.load({ dataDirectory: ctx.sessions.dataDirectory });
        signal.throwIfAborted();
        const models = ctx.models.open(configuration);
        const ref = requested ? models.configuredModel.resolve(requested).ref : models.configuredModel.getDefaultModel();
        return { model: models.measuredModel, ref };
      };
      this.workspace = new MemoryWorkspace(config.directory ?? join(ctx.sessions.dataDirectory, "memories", ctx.memory.libraryId));
      this.scheduler = new MemoryCurationScheduler({ memory: ctx.memory, maintenance: true,
        ...(config.maxUnusedDays === undefined ? {} : { maxUnusedDays: config.maxUnusedDays }),
        sourceAvailable: async job => {
          if (!job.evidence.sessionId) return true;
          try { return (await ctx.sessions.manager.get({ sessionId: job.evidence.sessionId })).status === "active"; }
          catch (error) { if (error instanceof SessionNotFoundError) return false; throw error; }
        },
        store: new DomainCurationStore(lease, lease.id, ctx.memory.libraryId),
        extractor: config.extractor === "recap" ? new RecapMemoryExtractor() : {
          extract: async (evidence, signal) => {
            const { model, ref } = await openModel(signal, config.model);
            return new ModelMemoryExtractor(model, ref).extract(evidence, signal);
          },
        },
        consolidator: new WorkspaceMemoryConsolidator(this.workspace, signal => openModel(signal, config.consolidationModel ?? config.model)),
        onError: error => ctx.logger.warn("Memory curation background pass failed", error),
      });
      this.background = new BackgroundMemoryCuration({ scheduler: this.scheduler,
        getSession: input => ctx.sessions.manager.get(input),
        ...(config.minIdleMs === undefined ? {} : { minIdleMs: config.minIdleMs }),
        ...(config.maxAgeMs === undefined ? {} : { maxAgeMs: config.maxAgeMs }),
        onError: error => ctx.logger.warn("Memory curation background pass failed", error),
      });
      let lifecycleClose: Promise<void> | undefined;
      const close = () => {
        this.background.stop();
        return lifecycleClose ??= Promise.all([this.scheduler.close(), this.background.drain(), ...this.noteWrites]).then(() => { lease.release(); });
      };
      registerPluginOwner(ctx, {
        replacement: "drain",
        status: () => {
          const state = this.scheduler.lifecycleSnapshot();
          const pending = state.activeJobs + state.scanning + state.ticking + state.sourceReads + Number(this.background.active) + this.noteWrites.size;
          return { disposition: pending ? "drain" : "direct", code: pending ? "memory_curation_draining" : "memory_curation_idle",
            counts: { jobs: state.activeJobs, scans: state.scanning, ticks: state.ticking, reads: state.sourceReads } };
        },
        prepare: change => {
          this.background.suspend();
          const resume = this.scheduler.suspendAdmissions();
          return {
            drained: change.kind === "replace" ? Promise.all([this.background.drain(), this.scheduler.drain(), ...this.noteWrites]).then(() => {}) : Promise.resolve(),
            deactivate: async () => { if (change.kind !== "replace") await close(); },
            release: () => { if (!lifecycleClose) { resume(); this.background.resume(); } },
          };
        },
      });
      ctx.effect(() => close, "memory.curation.close");
    } catch (error) { lease.release(); throw error; }
  }
  async [Service.init]() {
    await this.scheduler.recover();
    const reload = this.ctx.root.get("codeReload");
    const resume = reload ? this.scheduler.suspendAdmissions({ allowRegistration: true }) : () => {};
    const start = () => { resume(); this.background.resume(); };
    if (reload) reload.startWhenReady(this.ctx, start); else start();
  }
  override addNote(input: Parameters<MemoryCurationScheduler["addNote"]>[0], signal?: AbortSignal) {
    const pending = (async () => {
      const receipt = await this.scheduler.addNote(input, signal);
      const path = `extensions/ad_hoc/notes/${receipt.noteId}.md`;
      const job = (await this.scheduler.state(signal)).jobs.find(item => item.id === receipt.noteId);
      if (job?.status !== "completed" && !Object.hasOwn(await this.workspace.files(), path) && !Object.hasOwn(await this.workspace.baseline(), path)) await writeMemoryFile(this.workspace.directory, path, input.text);
      this.wake("");
      return receipt;
    })();
    this.noteWrites.add(pending);
    void pending.finally(() => this.noteWrites.delete(pending)).catch(() => {});
    return pending;
  }
  override wake(sessionId: string): void { if (this.config.automatic === true) this.background.wake(sessionId); }
}
