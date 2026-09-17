import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ApprovalRuleMatchRequest,
  ApprovalRuleRecord,
  ApprovalRuleStore,
  RememberApprovalRuleRequest,
} from "./types.js";

/** Permission-owned replaceable rule-store Definition. */
export abstract class ApprovalRulesService extends Service
  implements ApprovalRuleStore {
  abstract readonly version: string;

  constructor(ctx: Context) {
    super(ctx, "approvalRules");
  }

  abstract find(
    request: ApprovalRuleMatchRequest,
  ): Promise<ApprovalRuleRecord | undefined>;

  abstract remember(
    request: RememberApprovalRuleRequest,
  ): Promise<ApprovalRuleRecord>;

  abstract list(signal?: AbortSignal): Promise<readonly ApprovalRuleRecord[]>;
  abstract revoke(id: string, signal?: AbortSignal): Promise<boolean>;
  abstract clearRun(runId: string): boolean;
  abstract close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    approvalRules: ApprovalRulesService;
  }
}

export default ApprovalRulesService;
