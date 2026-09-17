import { Context, type Fiber } from "@deepseek-ai/cordis";

import type { StorageBackendResolver } from "../src/storage/backend.js";
import {
  DomainApprovalRuleStore,
  MemoryApprovalRuleStore,
  type ApprovalRuleMatchRequest,
  type ApprovalRuleRecord,
  type ApprovalRuleScope,
  type ApprovalRuleStore,
  type RetainedApprovalRuleScope,
} from "../src/permissions/rules/index.js";
import MemoryApprovalRules from
  "../src/permissions/rules/providers/memory.js";
import StorageApprovalRules from
  "../src/permissions/rules/providers/storage.js";

declare const storage: StorageBackendResolver;
declare const match: ApprovalRuleMatchRequest;

const scope: ApprovalRuleScope = "once";
const retained: RetainedApprovalRuleScope = "workspace";
const memory: ApprovalRuleStore = new MemoryApprovalRuleStore();
const domain: ApprovalRuleStore = new DomainApprovalRuleStore({
  storage,
  backendId: "file",
});
const found: Promise<ApprovalRuleRecord | undefined> = memory.find(match);
const remembered: Promise<ApprovalRuleRecord> = domain.remember({
  ...match,
  scope: retained,
});

const ctx = new Context();
const memoryFiber: Fiber = ctx.plugin(MemoryApprovalRules);
const storageFiber: Fiber = ctx.plugin(StorageApprovalRules, {
  backendId: "file",
  maxRules: 1024,
});

void scope;
void found;
void remembered;
void memoryFiber;
void storageFiber;
