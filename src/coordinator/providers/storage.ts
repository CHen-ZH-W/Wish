import { type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { ContextProviderRegistration } from "../../context/service.js";
import type { PermissionPolicyRegistration } from "../../permissions/index.js";
import type { StorageBackendLease } from "../../storage/backend.js";
import { CoordinatorContextProvider } from "../context.js";
import { createCoordinatorPermissionPolicy } from "../policy.js";
import { CoordinatorRuntime } from "../runtime.js";
import { CoordinatorService } from "../service.js";
import { DomainCoordinatorStateStore } from "../store.js";
import type {
  CoordinatorRunRequest,
  CoordinatorState,
  EnterCoordinatorRequest,
  ExitCoordinatorRequest,
} from "../types.js";

export interface Config {
  readonly backendId?: string;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
});

/** Durable Coordinator Provider; Subagents remains a separately injected owner. */
export class StorageCoordinatorService extends CoordinatorService {
  static readonly inject = [
    "storageBackend",
    "permissions",
    "contextEngine",
  ];
  static readonly Config = Config;

  private readonly lease: StorageBackendLease;
  private readonly backend: CoordinatorRuntime;
  private readonly contextRegistration: ContextProviderRegistration;
  private readonly policyRegistration: PermissionPolicyRegistration;
  private closing: Promise<void> | undefined;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: false } });
    try {
      this.backend = new CoordinatorRuntime({
        store: new DomainCoordinatorStateStore({ storage: this.lease, backendId }),
      });
      this.policyRegistration = ctx.permissions.registerPolicy(
        createCoordinatorPermissionPolicy(this, () => this.modeControls()),
      );
      try {
        this.contextRegistration = ctx.contextEngine.registerProvider(
          new CoordinatorContextProvider(this),
        );
      } catch (error: unknown) {
        this.policyRegistration.unregister();
        throw error;
      }
      ctx.effect(() => () => this.close(), "coordinator.close");
    } catch (error: unknown) {
      this.lease.release();
      throw error;
    }
  }

  get(request: CoordinatorRunRequest): Promise<CoordinatorState | undefined> {
    return this.backend.get(request);
  }

  enter(request: EnterCoordinatorRequest): Promise<CoordinatorState> {
    // Availability is admission, not ownership of the transport's lifetime.
    // Existing mode state/policy must survive a child Provider replacement.
    if (!this.ctx.get("subagents")) throw new Error("Coordinator requires the Subagents capability");
    return this.backend.enter(request);
  }

  exit(request: ExitCoordinatorRequest): Promise<CoordinatorState> {
    return this.backend.exit(request);
  }

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

export default StorageCoordinatorService;
