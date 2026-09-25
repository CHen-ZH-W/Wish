import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { StorageBackendLease } from "../../storage/backend.js";
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

/** Durable Plan state Provider; Context and permission projections are optional adapters. */
export class StoragePlanService extends PlanService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;

  private readonly lease: StorageBackendLease;
  private readonly backend: PlanRuntime;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: false } });
    try {
      this.backend = new PlanRuntime({
        store: new DomainPlanStateStore({ storage: this.lease, backendId }),
      });
      this.work = new PluginWorkOwner(ctx, { code: "plan", codeReload: true, close: () => this.closeOwnedResources() });
    } catch (error: unknown) {
      this.lease.release();
      throw error;
    }
  }

  get(request: PlanSessionRequest): Promise<PlanState | undefined> {
    return this.work.run(() => this.backend.get(request));
  }

  enter(request: EnterPlanRequest): Promise<PlanState> {
    return this.work.run(() => this.backend.enter(request));
  }

  update(request: UpdatePlanRequest): Promise<PlanState> {
    return this.work.run(() => this.backend.update(request));
  }

  approve(request: ApprovePlanRequest): Promise<PlanState> {
    return this.work.run(() => this.backend.approve(request));
  }

  review(request: ApprovePlanRequest): Promise<PlanState> { return this.work.run(() => this.backend.review(request)); }
  decide(request: DecidePlanReviewRequest): Promise<PlanState> { return this.work.run(() => this.backend.decide(request)); }
  feedback(request: PlanFeedbackRequest): Promise<PlanState | undefined> { return this.work.run(() => this.backend.feedback(request)); }

  close(): Promise<void> {
    return this.work.close();
  }

  private async closeOwnedResources(): Promise<void> {
    try {
      await this.backend.close();
    } finally {
      this.lease.release();
    }
  }
}

export default StoragePlanService;
