import type {
  ContextHistoryPolicy,
  ContextHistoryPolicyInput,
  ContextHistorySelection,
  ContextHistorySourceItem,
} from "../../core/context/projector.js";

export type ContextHistorySelectionStrategy =
  | "full_history"
  | "latest_checkpoint";

export interface ContextHistoryPolicyMetadata
  extends Readonly<Record<string, unknown>> {
  readonly strategy: ContextHistorySelectionStrategy;
  readonly selectedSummarySequence?: number;
  readonly coveredThroughSequence?: number;
  readonly protectedUserSequences: readonly number[];
  readonly recentHistorySequences: readonly number[];
}

/** Selects the latest valid checkpoint while retaining covered user text. */
export class LatestCheckpointHistoryPolicy implements ContextHistoryPolicy {
  select(input: ContextHistoryPolicyInput): ContextHistorySelection {
    throwIfAborted(input.signal);
    const items = orderedUniqueItems(input.items);
    const toolUnits = validateToolTranscript(items);
    const summaries = items.filter((item) => item.kind === "summary");
    validateCheckpointProgress(summaries, toolUnits);

    const latest = summaries.at(-1);
    if (latest === undefined) {
      const metadata: ContextHistoryPolicyMetadata = Object.freeze({
        strategy: "full_history",
        protectedUserSequences: Object.freeze([]),
        recentHistorySequences: Object.freeze(
          items.map((item) => item.sequence),
        ),
      });
      throwIfAborted(input.signal);
      return Object.freeze({ items, metadata });
    }

    const protectedUsers = items.filter(
      (item) =>
        item.kind === "history" &&
        item.sequence <= latest.coveredThroughSequence &&
        item.message.role === "user",
    );
    const recent = items.filter(
      (item) =>
        item.kind === "history" &&
        item.sequence > latest.coveredThroughSequence,
    );
    const selected = Object.freeze([latest, ...protectedUsers, ...recent]);
    const metadata: ContextHistoryPolicyMetadata = Object.freeze({
      strategy: "latest_checkpoint",
      selectedSummarySequence: latest.sequence,
      coveredThroughSequence: latest.coveredThroughSequence,
      protectedUserSequences: Object.freeze(
        protectedUsers.map((item) => item.sequence),
      ),
      recentHistorySequences: Object.freeze(
        recent.map((item) => item.sequence),
      ),
    });
    throwIfAborted(input.signal);
    return Object.freeze({ items: selected, metadata });
  }
}

interface ToolUnitRange {
  readonly start: number;
  readonly end: number;
}

function orderedUniqueItems(
  source: readonly ContextHistorySourceItem[],
): readonly ContextHistorySourceItem[] {
  const sequences = new Set<number>();
  const items = [...source].sort((left, right) => left.sequence - right.sequence);
  for (const item of items) {
    if (!Number.isSafeInteger(item.sequence) || item.sequence < 1) {
      throw new Error("Context history sequence must be a positive safe integer");
    }
    if (sequences.has(item.sequence)) {
      throw new Error(`Duplicate Context history sequence: ${item.sequence}`);
    }
    sequences.add(item.sequence);
    if (item.kind !== "summary") continue;
    if (
      !Number.isSafeInteger(item.coveredThroughSequence) ||
      item.coveredThroughSequence < 0 ||
      item.coveredThroughSequence >= item.sequence
    ) {
      throw new Error(
        "Context history summary has invalid coveredThroughSequence",
      );
    }
  }
  return Object.freeze(items);
}

function validateCheckpointProgress(
  summaries: readonly Extract<
    ContextHistorySourceItem,
    { readonly kind: "summary" }
  >[],
  toolUnits: readonly ToolUnitRange[],
): void {
  let previousCoverage = -1;
  for (const summary of summaries) {
    if (summary.coveredThroughSequence < previousCoverage) {
      throw new Error(
        "Context history checkpoint coverage must not move backwards",
      );
    }
    for (const unit of toolUnits) {
      if (
        summary.coveredThroughSequence >= unit.start &&
        summary.coveredThroughSequence < unit.end
      ) {
        throw new Error(
          `Context history checkpoint at ${summary.sequence} splits ` +
            `Tool Call unit starting at ${unit.start}`,
        );
      }
    }
    previousCoverage = summary.coveredThroughSequence;
  }
}

function validateToolTranscript(
  items: readonly ContextHistorySourceItem[],
): readonly ToolUnitRange[] {
  const units: ToolUnitRange[] = [];
  let pending: Set<string> | undefined;
  let unitStart = 0;
  let unitEnd = 0;

  for (const item of items) {
    const message = item.message;
    if (message.role === "tool") {
      if (
        pending === undefined ||
        message.toolCallId === undefined ||
        !pending.delete(message.toolCallId)
      ) {
        throw new Error(
          `Orphan or mismatched Tool Result at history sequence ${item.sequence}`,
        );
      }
      unitEnd = item.sequence;
      if (pending.size === 0) {
        units.push(Object.freeze({ start: unitStart, end: unitEnd }));
        pending = undefined;
      }
      continue;
    }
    if (pending !== undefined) {
      throw new Error(
        `Tool Call unit at history sequence ${unitStart} is incomplete`,
      );
    }
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      pending = new Set(message.toolCalls?.map((call) => call.id));
      if (pending.size !== message.toolCalls?.length) {
        throw new Error(
          `Tool Call unit at history sequence ${item.sequence} has duplicate call ids`,
        );
      }
      unitStart = item.sequence;
      unitEnd = item.sequence;
    }
  }
  if (pending !== undefined) {
    throw new Error(
      `Tool Call unit at history sequence ${unitStart} is incomplete`,
    );
  }
  return Object.freeze(units);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Context history operation was aborted", {
    cause: signal.reason,
  });
}
