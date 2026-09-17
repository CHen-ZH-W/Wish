import type { ModelRef } from "../model/model.js";

export interface RunCompletionHold {
  readonly reason: string;
  release(): void;
}

export interface RunContinuationReceipt {
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface RunFollowUp {
  readonly source: string;
  readonly text: string;
  readonly reserveCapacity?: boolean;
}

/** Run-bound continuation Port; Consumers cannot address another Run through it. */
export interface RunContinuation {
  deferCompletion(reason: string): RunCompletionHold | undefined;
  followUp(input: RunFollowUp): RunContinuationReceipt;
}

/** Resolve one continuation against immutable facts for the current Runtime Step. */
export interface RunContinuationFactory {
  resolve(input: {
    readonly agentId: string;
    readonly runId: string;
    readonly model: ModelRef;
  }): RunContinuation;
}
