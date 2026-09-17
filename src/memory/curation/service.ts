import { Service, type Context } from "@deepseek-ai/cordis";
import type { MemoryCurationScheduler } from "./scheduler.js";
import type { CurationEvidenceSource } from "./types.js";
export abstract class MemoryCurationService extends Service {
  constructor(ctx: Context) { super(ctx, "memoryCuration"); }
  abstract readonly scheduler: MemoryCurationScheduler;
  registerSource(source: CurationEvidenceSource): () => Promise<void> {
    const unregister = this.scheduler.registerSource(source);
    try { this.ctx.effect(() => unregister, `memory.curation.source(${source.id})`); }
    catch (error) { void unregister(); throw error; }
    return unregister;
  }
}
declare module "@deepseek-ai/cordis" { interface Context { memoryCuration: MemoryCurationService; } }
