import type {
  ModelError,
  ModelInvocationScope,
  ModelRef,
  ModelUsage,
} from "../../core/model/model.js";
import type { ModelPriceQuote } from "../pricing.js";
import type { ModelCost } from "../usage.js";

export type ModelAttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export interface ModelAttemptStart extends ModelInvocationScope {
  readonly attemptId: string;
  readonly requestedAt: string;
  readonly requestedModel: ModelRef;
}

export interface ModelAttemptFinish {
  readonly attemptId: string;
  readonly status: Exclude<ModelAttemptStatus, "running">;
  readonly endedAt: string;
  readonly billedModel?: ModelRef;
  readonly usage?: ModelUsage;
  readonly quote?: ModelPriceQuote;
  readonly cost?: ModelCost;
  readonly error?: ModelError;
}

/** Durable, reconstructed view of exactly one Provider request attempt. */
export interface ModelAttemptRecord extends ModelAttemptStart {
  readonly schemaVersion: 1;
  readonly status: ModelAttemptStatus;
  readonly endedAt?: string;
  readonly billedModel?: ModelRef;
  readonly usage?: ModelUsage;
  readonly quote?: ModelPriceQuote;
  readonly cost?: ModelCost;
  readonly error?: ModelError;
}

export interface ListModelAttemptsInput {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly userTurnId?: string;
  readonly stepId?: string;
  readonly status?: ModelAttemptStatus;
}

/** Pricing-owned persistence Port; concrete Storage remains replaceable. */
export interface ModelAttemptLedger {
  start(input: ModelAttemptStart, signal?: AbortSignal): Promise<void>;
  finish(input: ModelAttemptFinish, signal?: AbortSignal): Promise<void>;
  get(attemptId: string, signal?: AbortSignal): Promise<ModelAttemptRecord | undefined>;
  list(input?: ListModelAttemptsInput, signal?: AbortSignal): Promise<readonly ModelAttemptRecord[]>;
  recoverInterrupted(endedAt: string, signal?: AbortSignal): Promise<number>;
  close(): Promise<void>;
}
