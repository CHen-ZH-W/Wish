import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ListModelAttemptsInput,
  ModelAttemptFinish,
  ModelAttemptLedger,
  ModelAttemptRecord,
  ModelAttemptStart,
} from "./attempts.js";

/** Cordis lifecycle owner for the durable side of the existing Pricing capability. */
export abstract class ModelAttemptLedgerService extends Service
  implements ModelAttemptLedger {
  abstract readonly currency: string;

  constructor(ctx: Context) {
    super(ctx, "modelAttemptLedger");
  }

  abstract start(input: ModelAttemptStart, signal?: AbortSignal): Promise<void>;
  abstract finish(input: ModelAttemptFinish, signal?: AbortSignal): Promise<void>;
  abstract get(attemptId: string, signal?: AbortSignal): Promise<ModelAttemptRecord | undefined>;
  abstract list(input?: ListModelAttemptsInput, signal?: AbortSignal): Promise<readonly ModelAttemptRecord[]>;
  abstract recoverInterrupted(endedAt: string, signal?: AbortSignal): Promise<number>;
  abstract close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    modelAttemptLedger: ModelAttemptLedgerService;
  }
}

export default ModelAttemptLedgerService;
