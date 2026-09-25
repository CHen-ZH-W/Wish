import { Service, type Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import s from "@deepseek-ai/schemastery";
import type { StorageBackendLease } from "../../storage/backend.js";
import { MemoryService } from "../service.js";
import { MemoryRuntime } from "../memory.js";
import { JournalMemoryStore } from "../store.js";
import { identity } from "../validation.js";
import type { ChangeMemoryStatusRequest, DecideMemoryRequest, MemoryQuery, ProposeMemoryRequest } from "../types.js";
export interface Config { readonly backendId?: string; readonly libraryId?: string }
export const Config: s<Config> = s.object({ backendId: s.string(), libraryId: s.string() });
export default class StorageMemoryService extends MemoryService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;
  readonly libraryId: string;
  private readonly lease: StorageBackendLease;
  private readonly runtime: MemoryRuntime;
  private readonly work: PluginWorkOwner;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.libraryId = identity(config.libraryId ?? "default");
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { journal: { atomicBatch: true, durability: "fsync" } });
    try {
      const journal = this.lease.resolve(backendId, "journal").open({ namespace: `memory/${this.libraryId}` });
      this.runtime = new MemoryRuntime(new JournalMemoryStore(journal, this.libraryId));
      this.work = new PluginWorkOwner(ctx, { code: "memory", codeReload: true,
        close: () => this.runtime.close().finally(() => this.lease.release()) });
    } catch (error) { this.lease.release(); throw error; }
  }
  async [Service.init]() { await this.runtime.state(); }
  state(signal?: AbortSignal) { return this.work.run(() => this.runtime.state(signal)); }
  query(input?: MemoryQuery) { return this.work.run(() => this.runtime.query(input)); }
  read(id: string, signal?: AbortSignal) { return this.work.run(() => this.runtime.read(id, signal)); }
  propose(input: ProposeMemoryRequest) { return this.work.run(() => this.runtime.propose(input)); }
  decide(input: DecideMemoryRequest) { return this.work.run(() => this.runtime.decide(input)); }
  changeStatus(input: ChangeMemoryStatusRequest) { return this.work.run(() => this.runtime.changeStatus(input)); }
  snapshot(input?: MemoryQuery) { return this.work.run(() => this.runtime.snapshot(input)); }
  close() { return this.work.close(); }
}
