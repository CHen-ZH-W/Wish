import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { RuntimeLifecycleService } from "../../lifecycle.js";
import type { ToolExecutionLifecycle } from "../../../tools/executor.js";
import type { StorageBackendLease } from "../../../../storage/backend.js";
import {
  JournalRuntimeLifecycleAuthority,
  RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
} from "../journal.js";
import { RuntimeLifecycleAuthorityService } from "../service.js";
import { buildRuntimeLifecycleStartupSnapshot } from "../startup.js";
import type {
  DurableRuntimeLifecycleEvent,
  ResolveRuntimeReconciliationRequest,
  RuntimeReconciliationCommit,
  RuntimeLifecycleRecoveryReport,
  RuntimeLifecycleStartupSnapshot,
} from "../types.js";

export interface Config {
  readonly backendId?: string;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
});

/** Cordis Provider binding the Runtime authority to one configured Journal. */
export class JournalRuntimeLifecycleProvider
  extends RuntimeLifecycleAuthorityService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;

  readonly version: string;
  private readonly lease: StorageBackendLease;
  private readonly authority: JournalRuntimeLifecycleAuthority;
  private startupReport: RuntimeLifecycleRecoveryReport | undefined;
  private startupSnapshot: RuntimeLifecycleStartupSnapshot | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    const lease = ctx.storageBackend.acquire(backendId, {
      journal: { atomicBatch: true, durability: "fsync" },
    });
    try {
      const journal = lease.resolve(backendId, "journal").open({
        namespace: RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
      });
      this.lease = lease;
      this.authority = new JournalRuntimeLifecycleAuthority({
        journal,
        backendId,
      });
      this.version = `runtime-lifecycle-journal-v1:${backendId}`;
    } catch (error: unknown) {
      lease.release();
      throw error;
    }
    ctx.effect(() => () => this.close(), "Runtime lifecycle Journal");
  }

  get startupRecovery(): RuntimeLifecycleStartupSnapshot {
    if (this.startupSnapshot === undefined) {
      throw new Error("Runtime lifecycle startup recovery is not ready");
    }
    return this.startupSnapshot;
  }

  [Service.check](): boolean {
    return this.startupSnapshot !== undefined;
  }

  /** Keep the Fiber LOADING, and all consumers PENDING, until recovery is durable. */
  async [Service.init](): Promise<void> {
    try {
      const recovery = await this.authority.recoverInterrupted(
        "provider_startup",
      );
      this.startupReport = recovery;
      const events = await this.authority.readEvents();
      this.startupSnapshot = buildRuntimeLifecycleStartupSnapshot(
        recovery,
        events,
      );
      // During an in-place Cordis update the provider Fiber remains ACTIVE,
      // so the readiness predicate must be re-evaluated explicitly.
      this.ctx.reflect.notify(["runtimeLifecycle"]);
    } catch (error: unknown) {
      try {
        await this.close();
      } catch {
        // Preserve the recovery failure that explains why the Fiber failed.
      }
      throw error;
    }
  }

  openRun(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["openRun"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.openRun(...args));
  }

  finishRun(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["finishRun"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.finishRun(...args));
  }

  openUserTurn(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["openUserTurn"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.openUserTurn(...args));
  }

  finishUserTurn(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["finishUserTurn"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.finishUserTurn(...args));
  }

  openStep(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["openStep"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.openStep(...args));
  }

  finishStep(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["finishStep"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.finishStep(...args));
  }

  prepare(
    ...args: Parameters<ToolExecutionLifecycle<unknown>["prepare"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.prepare(...args));
  }

  markDispatched(
    ...args: Parameters<ToolExecutionLifecycle<unknown>["markDispatched"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.markDispatched(...args));
  }

  finish(
    ...args: Parameters<ToolExecutionLifecycle<unknown>["finish"]>
  ): Promise<void> {
    return Promise.resolve(this.authority.finish(...args));
  }

  recoverInterrupted(
    reason?: string,
  ): Promise<RuntimeLifecycleRecoveryReport> {
    return this.authority.recoverInterrupted(reason);
  }

  async recoverySnapshot(
    signal?: AbortSignal,
  ): Promise<RuntimeLifecycleStartupSnapshot> {
    const recovery = this.startupReport;
    if (recovery === undefined) {
      throw new Error("Runtime lifecycle startup recovery is not ready");
    }
    const snapshot = buildRuntimeLifecycleStartupSnapshot(
      recovery,
      await this.authority.readEvents(undefined, signal),
    );
    this.startupSnapshot = snapshot;
    return snapshot;
  }

  async resolveReconciliation(
    request: ResolveRuntimeReconciliationRequest,
  ): Promise<RuntimeReconciliationCommit> {
    const commit = await this.authority.resolveReconciliation(request);
    await this.recoverySnapshot(request.signal);
    return commit;
  }

  readEvents(
    runId?: string,
    signal?: AbortSignal,
  ): Promise<readonly DurableRuntimeLifecycleEvent[]> {
    return this.authority.readEvents(runId, signal);
  }

  close(): Promise<void> {
    return this.closePromise ??= this.authority.close().finally(() => {
      this.lease.release();
    });
  }
}

export default JournalRuntimeLifecycleProvider;
