import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { StorageBackendLease } from "../../storage/backend.js";
import { JournalSystemPromptHistory, SYSTEM_PROMPT_HISTORY_NAMESPACE } from "./ledger.js";
import { SystemPromptHistoryService } from "./service.js";
import type { SystemPromptSnapshot, SystemPromptSnapshotInput } from "./types.js";

export interface Config { readonly backendId?: string; }
export const Config: s<Config> = s.object({ backendId: s.string() });

/** Storage-backed owner for immutable System Prompt request snapshots. */
export default class StorageSystemPromptHistory extends SystemPromptHistoryService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;
  private readonly lease: StorageBackendLease;
  private readonly ledger: JournalSystemPromptHistory;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { journal: { atomicBatch: true, durability: "fsync" } });
    try {
      this.ledger = new JournalSystemPromptHistory(
        this.lease.resolve(backendId, "journal").open({ namespace: SYSTEM_PROMPT_HISTORY_NAMESPACE }),
        backendId,
      );
    } catch (error: unknown) {
      this.lease.release();
      throw error;
    }
    this.work = new PluginWorkOwner(ctx, { code: "system_prompt_history", codeReload: true,
      close: () => this.ledger.close().finally(() => this.lease.release()) });
  }

  record(input: SystemPromptSnapshotInput, signal?: AbortSignal): Promise<void> {
    return this.work.run(() => this.ledger.record(input, signal));
  }
  list(sessionId: string, signal?: AbortSignal): Promise<readonly SystemPromptSnapshot[]> {
    return this.work.run(() => this.ledger.list(sessionId, signal));
  }
  close(): Promise<void> { return this.work.close(); }
}
