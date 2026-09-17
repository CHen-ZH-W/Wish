import type { Context } from "@deepseek-ai/cordis";

import { ApprovalRulesService } from "../service.js";
import { MemoryApprovalRuleStore } from "../store.js";
import type {
  ApprovalRuleMatchRequest,
  ApprovalRuleRecord,
  RememberApprovalRuleRequest,
} from "../types.js";

/** Volatile approval-rule Provider for standalone and focused test compositions. */
export class MemoryApprovalRules extends ApprovalRulesService {
  readonly version: string;
  private readonly store = new MemoryApprovalRuleStore();

  constructor(ctx: Context) {
    super(ctx);
    this.version = this.store.version;
    ctx.effect(() => () => this.store.close(), "approval-rules-memory.close");
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
    return this.store.close();
  }
}

export default MemoryApprovalRules;
