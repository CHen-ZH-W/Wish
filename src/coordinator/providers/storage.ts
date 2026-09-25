import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { StorageBackendLease } from "../../storage/backend.js";
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
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;

  private readonly lease: StorageBackendLease;
  private readonly backend: CoordinatorRuntime;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: false } });
    try {
      this.backend = new CoordinatorRuntime({
        store: new DomainCoordinatorStateStore({ storage: this.lease, backendId }),
      });
      this.work = new PluginWorkOwner(ctx, { code: "coordinator", codeReload: true, close: () => this.closeOwnedResources() });
    } catch (error: unknown) {
      this.lease.release();
      throw error;
    }
  }

  get(request: CoordinatorRunRequest): Promise<CoordinatorState | undefined> {
    return this.work.run(() => this.backend.get(request));
  }

  enter(request: EnterCoordinatorRequest): Promise<CoordinatorState> {
    // Availability is admission, not ownership of the transport's lifetime.
    // Existing mode state/policy must survive a child Provider replacement.
    if (!this.ctx.get("subagents")) throw new Error("Coordinator requires the Subagents capability");
    return this.work.run(() => this.backend.enter(request));
  }

  exit(request: ExitCoordinatorRequest): Promise<CoordinatorState> {
    return this.work.run(() => this.backend.exit(request));
  }

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

export default StorageCoordinatorService;
