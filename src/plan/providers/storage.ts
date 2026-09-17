import { type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { StorageBackendLease } from "../../storage/backend.js";
import type { ContextProviderRegistration } from "../../context/service.js";
import type { PermissionPolicyRegistration } from "../../permissions/index.js";
import { PlanContextProvider } from "../context.js";
import { createPlanPermissionPolicy } from "../policy.js";
import { PlanRuntime } from "../runtime.js";
import { PlanService } from "../service.js";
import { DomainPlanStateStore } from "../store.js";
import type {
  ApprovePlanRequest,
  EnterPlanRequest,
  PlanSessionRequest,
  PlanState,
  UpdatePlanRequest,
  DecidePlanReviewRequest,
  PlanFeedbackRequest,
} from "../types.js";

export interface Config {
  readonly backendId?: string;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
});

/** Durable Plan Provider plus its hard-policy and Context projections. */
export class StoragePlanService extends PlanService {
  static readonly inject = ["storageBackend", "permissions", "contextEngine"];
  static readonly Config = Config;

  private readonly lease: StorageBackendLease;
  private readonly backend: PlanRuntime;
  private readonly contextRegistration: ContextProviderRegistration;
  private readonly policyRegistration: PermissionPolicyRegistration;
  private closing: Promise<void> | undefined;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: false } });
    try {
      this.backend = new PlanRuntime({
        store: new DomainPlanStateStore({ storage: this.lease, backendId }),
      });
      this.policyRegistration = ctx.permissions.registerPolicy(
        createPlanPermissionPolicy(this, () => this.modeControls()),
      );
      try {
        this.contextRegistration = ctx.contextEngine.registerProvider(
          new PlanContextProvider(this),
        );
      } catch (error: unknown) {
        this.policyRegistration.unregister();
        throw error;
      }
      ctx.effect(() => () => this.close(), "plan.close");
    } catch (error: unknown) {
      this.lease.release();
      throw error;
    }
  }

  get(request: PlanSessionRequest): Promise<PlanState | undefined> {
    return this.backend.get(request);
  }

  enter(request: EnterPlanRequest): Promise<PlanState> {
    return this.backend.enter(request);
  }

  update(request: UpdatePlanRequest): Promise<PlanState> {
    return this.backend.update(request);
  }

  approve(request: ApprovePlanRequest): Promise<PlanState> {
    return this.backend.approve(request);
  }

  review(request: ApprovePlanRequest): Promise<PlanState> { return this.backend.review(request); }
  decide(request: DecidePlanReviewRequest): Promise<PlanState> { return this.backend.decide(request); }
  feedback(request: PlanFeedbackRequest): Promise<PlanState | undefined> { return this.backend.feedback(request); }

  close(): Promise<void> {
    return this.closing ??= this.closeOwnedResources();
  }

  private async closeOwnedResources(): Promise<void> {
    this.contextRegistration.unregister();
    this.policyRegistration.unregister();
    try {
      await this.backend.close();
    } finally {
      this.lease.release();
    }
  }
}

export default StoragePlanService;
