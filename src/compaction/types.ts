import type {
  ModelMessage,
  ModelRef,
  ModelUsage,
} from "../core/model/model.js";
import type {
  ContextHistoryRecord,
  ContextHistorySummaryRecord,
  ContextSessionId,
  ModelInputTokenCounter,
} from "../context/types.js";

export type CompactionReason = "context_over_budget";

/** Immutable Session view used to plan one optimistic append. */
export interface CompactionSessionSnapshot {
  readonly revision: string;
  readonly records: readonly ContextHistoryRecord[];
}

export interface CompactionCheckpointDraft {
  readonly reason: CompactionReason;
  readonly coveredThroughSequence: number;
  readonly sourceSequences: readonly number[];
  readonly message: ModelMessage & { readonly role: "assistant" };
  readonly summaryUsage?: ModelUsage;
}

export interface CompactionCheckpointAppendInput {
  readonly sessionId: ContextSessionId;
  /** The append must fail if Session changed after the planning read. */
  readonly expectedRevision: string;
  readonly checkpoint: CompactionCheckpointDraft;
  readonly signal?: AbortSignal;
}

/**
 * Transactional, append-only Session Port. Concrete files or databases remain
 * outside Compaction and allocate the checkpoint sequence atomically.
 */
export interface CompactionSessionPort {
  read(input: {
    readonly sessionId: ContextSessionId;
    readonly signal?: AbortSignal;
  }): Promise<CompactionSessionSnapshot> | CompactionSessionSnapshot;

  appendCheckpoint(
    input: CompactionCheckpointAppendInput,
  ):
    | Promise<ContextHistorySummaryRecord>
    | ContextHistorySummaryRecord;
}

export interface CompactionSummaryInput {
  /** Only the selected historical prefix; never the final Agent request. */
  readonly oldEntries: readonly ContextHistoryRecord[];
  readonly signal?: AbortSignal;
}

export interface CompactionSummary {
  readonly content: string;
  readonly usage?: ModelUsage;
}

/** Summary generation Port; it cannot see recent history or Agent state. */
export interface CompactionSummarizer {
  summarize(
    input: CompactionSummaryInput,
  ): Promise<CompactionSummary> | CompactionSummary;
}

export interface CompactionConfiguration {
  /** Exact-token target for the recent history suffix. */
  readonly keepRecentTokens: number;
}

export interface ContextOverflowCompactionInput {
  readonly sessionId: ContextSessionId;
  /** The model whose Agent request overflowed; used only to size history. */
  readonly model: ModelRef;
  readonly preserveUserTurnId: string;
  readonly signal?: AbortSignal;
}

export type CompactionNotPossibleReason =
  | "input_token_count_unavailable"
  | "no_compactable_history";

export type ContextOverflowCompactionResult =
  | {
      readonly status: "compacted";
      readonly checkpoint: ContextHistorySummaryRecord;
      readonly sourceRecordCount: number;
      readonly recentRecordCount: number;
      readonly recentInputTokens: number;
      readonly countMethod: string;
    }
  | {
      readonly status: "not_possible";
      readonly reason: CompactionNotPossibleReason;
    };

export interface ContextOverflowCompactor {
  compact(
    input: ContextOverflowCompactionInput,
  ):
    | Promise<ContextOverflowCompactionResult>
    | ContextOverflowCompactionResult;
}

export interface SessionCompactorOptions {
  readonly session: CompactionSessionPort;
  readonly summarizer: CompactionSummarizer;
  readonly counter: ModelInputTokenCounter;
  readonly configuration: CompactionConfiguration;
}

