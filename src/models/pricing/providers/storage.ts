import { PluginWorkOwner } from "../../../boot/plugin-control/work-owner.js";
import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { StorageBackendLease } from "../../../storage/backend.js";
import type {
  ListModelAttemptsInput,
  ModelAttemptFinish,
  ModelAttemptRecord,
  ModelAttemptStart,
} from "../attempts.js";
import {
  JournalModelAttemptLedger,
  MODEL_ATTEMPT_JOURNAL_NAMESPACE,
} from "../ledger.js";
import { ModelAttemptLedgerService } from "../service.js";

export interface Config {
  readonly backendId?: string;
  readonly currency?: string;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
  currency: s.string(),
});

/** Cordis Provider binding the Pricing attempt ledger to Storage Journal. */
export class StorageModelAttemptLedger extends ModelAttemptLedgerService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;

  readonly currency: string;
  private readonly lease: StorageBackendLease;
  private readonly ledger: JournalModelAttemptLedger;
  private ready = false;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.currency = requireCurrency(config.currency ?? "USD");
    const backendId = config.backendId ?? ctx.storageBackend.id;
    const lease = ctx.storageBackend.acquire(backendId, {
      journal: { atomicBatch: true, durability: "fsync" },
    });
    try {
      const journal = lease.resolve(backendId, "journal").open({
        namespace: MODEL_ATTEMPT_JOURNAL_NAMESPACE,
      });
      this.lease = lease;
      this.ledger = new JournalModelAttemptLedger(journal, backendId);
    } catch (error: unknown) {
      lease.release();
      throw error;
    }
    this.work = new PluginWorkOwner(ctx, { code: "model_attempt_ledger", codeReload: true,
      close: () => this.ledger.close().finally(() => { this.ready = false; this.lease.release(); }) });
  }

  [Service.check](): boolean {
    return this.ready;
  }

  async [Service.init](): Promise<void> {
    try {
      await this.ledger.recoverInterrupted(new Date().toISOString());
      this.ready = true;
      this.ctx.reflect.notify(["modelAttemptLedger"]);
    } catch (error: unknown) {
      try {
        await this.close();
      } catch {
        // Preserve the startup recovery failure.
      }
      throw error;
    }
  }

  start(input: ModelAttemptStart, signal?: AbortSignal): Promise<void> {
    return this.work.run(() => this.ledger.start(input, signal));
  }

  finish(input: ModelAttemptFinish, signal?: AbortSignal): Promise<void> {
    return this.work.run(() => this.ledger.finish(input, signal));
  }

  get(attemptId: string, signal?: AbortSignal): Promise<ModelAttemptRecord | undefined> {
    return this.work.run(() => this.ledger.get(attemptId, signal));
  }

  list(
    input?: ListModelAttemptsInput,
    signal?: AbortSignal,
  ): Promise<readonly ModelAttemptRecord[]> {
    return this.work.run(() => this.ledger.list(input, signal));
  }

  recoverInterrupted(endedAt: string, signal?: AbortSignal): Promise<number> {
    return this.work.run(() => this.ledger.recoverInterrupted(endedAt, signal));
  }

  close(): Promise<void> {
    return this.work.close();
  }
}

function requireCurrency(value: string): string {
  if (!/^[A-Z]{3}$/u.test(value)) {
    throw new TypeError("Model Pricing currency must be a three-letter uppercase code");
  }
  return value;
}

export default StorageModelAttemptLedger;
