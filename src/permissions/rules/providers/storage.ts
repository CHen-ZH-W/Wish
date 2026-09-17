import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { StorageBackendLease } from "../../../storage/backend.js";
import { ApprovalRulesService } from "../service.js";
import { DomainApprovalRuleStore } from "../store.js";
import type {
  ApprovalRuleMatchRequest,
  ApprovalRuleRecord,
  RememberApprovalRuleRequest,
} from "../types.js";

export interface Config {
  readonly backendId?: string;
  readonly maxRules?: number;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
  maxRules: s.number().step(1).min(1),
});

/** Permission rule Provider persisting retained approvals through Storage Domain. */
export class StorageApprovalRules extends ApprovalRulesService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;

  readonly version: string;
  private readonly lease: StorageBackendLease;
  private readonly store: DomainApprovalRuleStore;
  private closing: Promise<void> | undefined;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    const lease = ctx.storageBackend.acquire(backendId, {
      kv: { list: false },
    });
    try {
      this.lease = lease;
      this.store = new DomainApprovalRuleStore({
        storage: lease,
        backendId,
        ...(config.maxRules === undefined ? {} : { maxRules: config.maxRules }),
      });
      this.version = this.store.version;
      ctx.effect(() => () => this.close(), "approval-rules.close");
    } catch (error: unknown) {
      lease.release();
      throw error;
    }
  }

  find(request: ApprovalRuleMatchRequest): Promise<ApprovalRuleRecord | undefined> {
    return this.store.find(request);
  }

  remember(request: RememberApprovalRuleRequest): Promise<ApprovalRuleRecord> {
    return this.store.remember(request);
  }

  list(signal?: AbortSignal): Promise<readonly ApprovalRuleRecord[]> {
    return this.store.list(signal);
  }

  revoke(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.store.revoke(id, signal);
  }

  clearRun(runId: string): boolean {
    return this.store.clearRun(runId);
  }

  close(): Promise<void> {
    this.closing ??= this.closeOwnedResources();
    return this.closing;
  }

  private async closeOwnedResources(): Promise<void> {
    try {
      await this.store.close();
    } finally {
      this.lease.release();
    }
  }
}

export default StorageApprovalRules;
