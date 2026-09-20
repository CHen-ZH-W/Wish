import type { ContextHistorySummaryRecord } from "../context/types.js";
import { createCompactionPlan } from "./planner.js";
import type {
  CompactionCheckpointDraft,
  CompactionSessionSnapshot,
  ContextOverflowCompactionInput,
  ContextOverflowCompactionResult,
  ContextOverflowCompactor,
  SessionCompactorOptions,
} from "./types.js";

/** Coordinates one optimistic read, one summary, and one append-only write. */
export class SessionCompactor implements ContextOverflowCompactor {
  readonly keepRecentTokens: number;

  constructor(private readonly options: SessionCompactorOptions) {
    this.keepRecentTokens = positiveSafeInteger(
      options.configuration.keepRecentTokens,
      "Compaction keepRecentTokens",
    );
  }

  async compact(
    input: ContextOverflowCompactionInput,
  ): Promise<ContextOverflowCompactionResult> {
    throwIfAborted(input.signal);
    const sessionId = requireIdentifier(
      input.sessionId,
      "Compaction sessionId",
    );
    const snapshot = validateSessionSnapshot(await this.options.session.read({
      sessionId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }));
    throwIfAborted(input.signal);
    const planned = await createCompactionPlan({
      records: snapshot.records,
      model: input.model,
      counter: this.options.counter,
      keepRecentTokens: this.keepRecentTokens,
      preserveUserTurnId: input.preserveUserTurnId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (planned.status === "not_possible") return planned;

    const summary = await this.options.summarizer.summarize({
      oldEntries: planned.plan.oldEntries,
      ...(input.invocationScope === undefined
        ? {}
        : { invocationScope: input.invocationScope }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    throwIfAborted(input.signal);
    if (
      summary === null ||
      typeof summary !== "object" ||
      typeof summary.content !== "string" ||
      summary.content.trim().length === 0
    ) {
      throw new Error("Compaction summarizer must return non-empty content");
    }
    const checkpoint: CompactionCheckpointDraft = Object.freeze({
      reason: "context_over_budget" as const,
      coveredThroughSequence: planned.plan.coveredThroughSequence,
      sourceSequences: Object.freeze(
        planned.plan.oldEntries.map((record) => record.sequence),
      ),
      message: Object.freeze({
        role: "assistant" as const,
        content: summary.content,
      }),
      ...(summary.usage === undefined ? {} : { summaryUsage: summary.usage }),
    });
    const appended = validateAppendedCheckpoint(
      await this.options.session.appendCheckpoint({
        sessionId,
        expectedRevision: snapshot.revision,
        checkpoint,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
      checkpoint,
      Math.max(0, ...snapshot.records.map((record) => record.sequence)),
    );
    throwIfAborted(input.signal);
    return Object.freeze({
      status: "compacted" as const,
      checkpoint: appended,
      sourceRecordCount: planned.plan.oldEntries.length,
      recentRecordCount: planned.plan.recentEntries.length,
      recentInputTokens: planned.plan.recentInputTokens,
      countMethod: planned.plan.countMethod,
    });
  }
}

function validateSessionSnapshot(
  snapshot: CompactionSessionSnapshot,
): CompactionSessionSnapshot {
  if (snapshot === null || typeof snapshot !== "object") {
    throw new Error("Compaction Session Port must return a snapshot");
  }
  const revision = requireIdentifier(
    snapshot.revision,
    "Compaction Session revision",
  );
  if (!Array.isArray(snapshot.records)) {
    throw new Error("Compaction Session snapshot records must be an array");
  }
  return Object.freeze({
    revision,
    records: Object.freeze([...snapshot.records]),
  });
}

function validateAppendedCheckpoint(
  record: ContextHistorySummaryRecord,
  draft: CompactionCheckpointDraft,
  previousLastSequence: number,
): ContextHistorySummaryRecord {
  if (record === null || typeof record !== "object" || record.kind !== "summary") {
    throw new Error("Compaction Session append must return a summary record");
  }
  if (
    !Number.isSafeInteger(record.sequence) ||
    record.sequence <= draft.coveredThroughSequence ||
    record.sequence <= previousLastSequence
  ) {
    throw new Error("Compaction checkpoint sequence must follow its coverage");
  }
  if (record.coveredThroughSequence !== draft.coveredThroughSequence) {
    throw new Error("Compaction Session changed checkpoint coverage");
  }
  if (
    record.message.role !== "assistant" ||
    record.message.content !== draft.message.content ||
    record.message.contentParts !== undefined ||
    record.message.reasoningContent !== undefined ||
    record.message.toolCalls !== undefined ||
    record.message.toolCallId !== undefined
  ) {
    throw new Error("Compaction Session changed checkpoint message");
  }
  return Object.freeze({
    kind: "summary" as const,
    sequence: record.sequence,
    coveredThroughSequence: record.coveredThroughSequence,
    message: Object.freeze({
      role: "assistant" as const,
      content: record.message.content,
    }),
  });
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Session compaction was aborted", { cause: signal.reason });
}
