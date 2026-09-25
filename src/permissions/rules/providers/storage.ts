import { PluginWorkOwner } from "../../../boot/plugin-control/work-owner.js";
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
  private readonly work: PluginWorkOwner;

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
      this.work = new PluginWorkOwner(ctx, { code: "approval_rules", codeReload: true, close: () => this.closeOwnedResources() });
    } catch (error: unknown) {
      lease.release();
      throw error;
    }
  }

  find(request: ApprovalRuleMatchRequest): Promise<ApprovalRuleRecord | undefined> {
    return this.work.run(() => this.store.find(request));
  }

  remember(request: RememberApprovalRuleRequest): Promise<ApprovalRuleRecord> {
    return this.work.run(() => this.store.remember(request));
  }

  list(signal?: AbortSignal): Promise<readonly ApprovalRuleRecord[]> {
    return this.work.run(() => this.store.list(signal));
  }

  revoke(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.work.run(() => this.store.revoke(id, signal));
  }

  clearRun(runId: string): boolean {
    this.work.assertOpen();
    return this.store.clearRun(runId);
  }

  close(): Promise<void> {
    return this.work.close();
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
