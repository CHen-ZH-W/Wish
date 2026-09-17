import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  RuntimeLifecycleService,
} from "../lifecycle.js";
import type {
  ToolExecutionLifecycle,
} from "../../tools/scheduler.js";
import type {
  DurableRuntimeLifecycleEvent,
  ResolveRuntimeReconciliationRequest,
  RuntimeReconciliationCommit,
  RuntimeLifecycleRecoveryReport,
  RuntimeLifecycleStartupSnapshot,
} from "./types.js";

/** Replaceable authority shared by Runtime hierarchy and Tool dispatch. */
export abstract class RuntimeLifecycleAuthorityService extends Service
  implements RuntimeLifecycleService<unknown, unknown>, ToolExecutionLifecycle<unknown> {
  abstract readonly version: string;
  /** Available only after the Provider's Cordis initialization has completed. */
  abstract readonly startupRecovery: RuntimeLifecycleStartupSnapshot;

  constructor(ctx: Context) {
    super(ctx, "runtimeLifecycle");
  }

  abstract openRun(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["openRun"]>
  ): Promise<void>;
  abstract finishRun(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["finishRun"]>
  ): Promise<void>;
  abstract openUserTurn(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["openUserTurn"]>
  ): Promise<void>;
  abstract finishUserTurn(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["finishUserTurn"]>
  ): Promise<void>;
  abstract openStep(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["openStep"]>
  ): Promise<void>;
  abstract finishStep(
    ...args: Parameters<RuntimeLifecycleService<unknown, unknown>["finishStep"]>
  ): Promise<void>;
  abstract prepare(
    ...args: Parameters<ToolExecutionLifecycle<unknown>["prepare"]>
  ): Promise<void>;
  abstract markDispatched(
    ...args: Parameters<ToolExecutionLifecycle<unknown>["markDispatched"]>
  ): Promise<void>;
  abstract finish(
    ...args: Parameters<ToolExecutionLifecycle<unknown>["finish"]>
  ): Promise<void>;

  abstract recoverInterrupted(
    reason?: string,
  ): Promise<RuntimeLifecycleRecoveryReport>;
  abstract recoverySnapshot(
    signal?: AbortSignal,
  ): Promise<RuntimeLifecycleStartupSnapshot>;
  abstract resolveReconciliation(
    request: ResolveRuntimeReconciliationRequest,
  ): Promise<RuntimeReconciliationCommit>;
  abstract readEvents(
    runId?: string,
    signal?: AbortSignal,
  ): Promise<readonly DurableRuntimeLifecycleEvent[]>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    runtimeLifecycle: RuntimeLifecycleAuthorityService;
  }
}

export default RuntimeLifecycleAuthorityService;
