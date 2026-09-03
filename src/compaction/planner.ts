import type {
  ModelMessage,
  ModelRef,
} from "../core/model/model.js";
import type {
  ContextHistoryMessageRecord,
  ContextHistoryRecord,
  ContextHistorySummaryRecord,
  ContextToolResultArchiveReceipt,
  ModelInputTokenCount,
  ModelInputTokenCounter,
} from "../context/types.js";
import type { CompactionNotPossibleReason } from "./types.js";

export interface CompactionPlan {
  readonly oldEntries: readonly ContextHistoryRecord[];
  readonly recentEntries: readonly ContextHistoryRecord[];
  readonly coveredThroughSequence: number;
  readonly recentInputTokens: number;
  readonly countMethod: string;
}

export type CompactionPlanResult =
  | { readonly status: "ready"; readonly plan: CompactionPlan }
  | {
      readonly status: "not_possible";
      readonly reason: CompactionNotPossibleReason;
    };

export interface CompactionPlanInput {
  readonly records: readonly ContextHistoryRecord[];
  readonly model: ModelRef;
  readonly counter: ModelInputTokenCounter;
  readonly keepRecentTokens: number;
  readonly preserveUserTurnId: string;
  readonly signal?: AbortSignal;
}

interface HistoryUnit {
  readonly records: readonly ContextHistoryRecord[];
  readonly preservesCurrentTurn: boolean;
}

/** Selects one historical prefix without cutting an assistant/Tool unit. */
export async function createCompactionPlan(
  input: CompactionPlanInput,
): Promise<CompactionPlanResult> {
  throwIfAborted(input.signal);
  const keepRecentTokens = positiveSafeInteger(
    input.keepRecentTokens,
    "Compaction keepRecentTokens",
  );
  const preserveUserTurnId = requireIdentifier(
    input.preserveUserTurnId,
    "Compaction preserveUserTurnId",
  );
  const model = snapshotModelRef(input.model);
  const records = normalizeRecords(input.records);
  const active = activeRecords(records);
  const units = createHistoryUnits(active, preserveUserTurnId);

  let boundary = units.findIndex((unit) => unit.preservesCurrentTurn);
  if (boundary < 0) boundary = units.length;

  let recentCount: ModelInputTokenCount = Object.freeze({
    inputTokens: 0,
    method: "empty_history",
  });
  if (boundary < units.length) {
    const counted = await countRecords(
      units.slice(boundary).flatMap((unit) => unit.records),
      model,
      input.counter,
      input.signal,
    );
    if (counted === undefined) {
      return notPossible("input_token_count_unavailable");
    }
    recentCount = counted;
  }

  while (boundary > 0 && recentCount.inputTokens < keepRecentTokens) {
    boundary -= 1;
    const counted = await countRecords(
      units.slice(boundary).flatMap((unit) => unit.records),
      model,
      input.counter,
      input.signal,
    );
    if (counted === undefined) {
      return notPossible("input_token_count_unavailable");
    }
    recentCount = counted;
  }

  const oldEntries = Object.freeze(
    units.slice(0, boundary).flatMap((unit) => unit.records),
  );
  const newlyCovered = oldEntries.filter(
    (record): record is ContextHistoryMessageRecord => record.kind === "message",
  );
  if (newlyCovered.length === 0) {
    return notPossible("no_compactable_history");
  }
  const previousCoverage = oldEntries.reduce(
    (coverage, record) => record.kind === "summary"
      ? Math.max(coverage, record.coveredThroughSequence)
      : coverage,
    0,
  );
  const coveredThroughSequence = Math.max(
    previousCoverage,
    ...newlyCovered.map((record) => record.sequence),
  );
  const recentEntries = Object.freeze(
    units.slice(boundary).flatMap((unit) => unit.records),
  );
  throwIfAborted(input.signal);
  return Object.freeze({
    status: "ready" as const,
    plan: Object.freeze({
      oldEntries,
      recentEntries,
      coveredThroughSequence,
      recentInputTokens: recentCount.inputTokens,
      countMethod: recentCount.method,
    }),
  });
}

function activeRecords(
  records: readonly ContextHistoryRecord[],
): readonly ContextHistoryRecord[] {
  const latestSummary = records
    .filter((record): record is ContextHistorySummaryRecord =>
      record.kind === "summary"
    )
    .at(-1);
  if (latestSummary === undefined) {
    return Object.freeze(records.filter((record) => record.kind === "message"));
  }
  return Object.freeze([
    latestSummary,
    ...records.filter(
      (record) =>
        record.kind === "message" &&
        record.sequence > latestSummary.coveredThroughSequence,
    ),
  ]);
}

function createHistoryUnits(
  records: readonly ContextHistoryRecord[],
  preserveUserTurnId: string,
): readonly HistoryUnit[] {
  const units: HistoryUnit[] = [];
  let index = 0;
  while (index < records.length) {
    const first = records[index];
    if (first === undefined) break;
    const grouped: ContextHistoryRecord[] = [first];
    index += 1;

    if (
      first.kind === "message" &&
      first.message.role === "assistant" &&
      (first.message.toolCalls?.length ?? 0) > 0
    ) {
      const pending = new Set(first.message.toolCalls?.map((call) => call.id));
      while (index < records.length) {
        const candidate = records[index];
        if (
          candidate === undefined ||
          candidate.kind !== "message" ||
          candidate.message.role !== "tool" ||
          candidate.message.toolCallId === undefined ||
          !pending.has(candidate.message.toolCallId)
        ) {
          break;
        }
        pending.delete(candidate.message.toolCallId);
        grouped.push(candidate);
        index += 1;
      }
    }

    units.push(Object.freeze({
      records: Object.freeze(grouped),
      preservesCurrentTurn: grouped.some(
        (record) =>
          record.kind === "message" &&
          record.userTurnId === preserveUserTurnId,
      ),
    }));
  }
  return Object.freeze(units);
}

async function countRecords(
  records: readonly ContextHistoryRecord[],
  model: ModelRef,
  counter: ModelInputTokenCounter,
  signal: AbortSignal | undefined,
): Promise<ModelInputTokenCount | undefined> {
  throwIfAborted(signal);
  const count = await counter.count({
    request: Object.freeze({
      model,
      messages: Object.freeze(records.map((record) => record.message)),
      tools: Object.freeze([]),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  throwIfAborted(signal);
  if (count === undefined) return undefined;
  if (!Number.isSafeInteger(count.inputTokens) || count.inputTokens < 0) {
    throw new Error(
      "Compaction token counter inputTokens must be a non-negative safe integer",
    );
  }
  return Object.freeze({
    inputTokens: count.inputTokens,
    method: requireIdentifier(count.method, "Compaction token count method"),
  });
}

function normalizeRecords(
  source: readonly ContextHistoryRecord[],
): readonly ContextHistoryRecord[] {
  if (!Array.isArray(source)) {
    throw new Error("Compaction Session records must be an array");
  }
  const sequences = new Set<number>();
  const records = source.map((record) => {
    if (record === null || typeof record !== "object") {
      throw new Error("Compaction Session records must contain objects");
    }
    const sequence = positiveSafeInteger(
      record.sequence,
      "Compaction Session sequence",
    );
    if (sequences.has(sequence)) {
      throw new Error(`Duplicate Compaction Session sequence: ${sequence}`);
    }
    sequences.add(sequence);
    const message = snapshotMessage(record.message);

    if (record.kind === "message") {
      return Object.freeze({
        kind: "message" as const,
        sequence,
        ...(record.userTurnId === undefined
          ? {}
          : {
              userTurnId: requireIdentifier(
                record.userTurnId,
                "Compaction Session userTurnId",
              ),
            }),
        message,
        ...(record.toolResultArchive === undefined
          ? {}
          : { toolResultArchive: snapshotArchive(record.toolResultArchive) }),
      });
    }
    if (record.kind !== "summary") {
      throw new Error("Unknown Compaction Session record kind");
    }
    if (message.role !== "assistant") {
      throw new Error("Compaction checkpoint message must use assistant role");
    }
    const coverage = nonNegativeSafeInteger(
      record.coveredThroughSequence,
      "Compaction checkpoint coverage",
    );
    if (coverage >= sequence) {
      throw new Error("Compaction checkpoint coverage must precede its sequence");
    }
    return Object.freeze({
      kind: "summary" as const,
      sequence,
      coveredThroughSequence: coverage,
      message: message as ModelMessage & { readonly role: "assistant" },
    });
  });
  records.sort((left, right) => left.sequence - right.sequence);
  const toolUnits = sourceToolUnitRanges(records);
  let previousCoverage = -1;
  for (const record of records) {
    if (record.kind !== "summary") continue;
    if (record.coveredThroughSequence < previousCoverage) {
      throw new Error("Compaction checkpoint coverage must not move backwards");
    }
    for (const unit of toolUnits) {
      if (
        record.coveredThroughSequence >= unit.start &&
        record.coveredThroughSequence < unit.end
      ) {
        throw new Error(
          `Compaction checkpoint at ${record.sequence} splits ` +
            `Tool Call unit starting at ${unit.start}`,
        );
      }
    }
    previousCoverage = record.coveredThroughSequence;
  }
  return Object.freeze(records);
}

function sourceToolUnitRanges(
  records: readonly ContextHistoryRecord[],
): readonly { readonly start: number; readonly end: number }[] {
  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  for (const [index, record] of records.entries()) {
    if (
      record.kind !== "message" ||
      record.message.role !== "assistant" ||
      (record.message.toolCalls?.length ?? 0) === 0
    ) {
      continue;
    }
    const pending = new Set(record.message.toolCalls?.map((call) => call.id));
    let end = record.sequence;
    for (const candidate of records.slice(index + 1)) {
      if (candidate.kind !== "message" || candidate.message.role !== "tool") {
        break;
      }
      const callId = candidate.message.toolCallId;
      if (callId === undefined || !pending.delete(callId)) break;
      end = candidate.sequence;
      if (pending.size === 0) break;
    }
    ranges.push(Object.freeze({ start: record.sequence, end }));
  }
  return Object.freeze(ranges);
}

function snapshotMessage(message: ModelMessage): ModelMessage {
  if (message === null || typeof message !== "object") {
    throw new Error("Compaction record must contain a ModelMessage");
  }
  if (
    message.role !== "system" &&
    message.role !== "developer" &&
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool"
  ) {
    throw new Error("Compaction record contains an unknown message role");
  }
  if (typeof message.content !== "string") {
    throw new Error("Compaction record message content must be a string");
  }
  if (message.toolCallId !== undefined && message.role !== "tool") {
    throw new Error("Compaction toolCallId requires a Tool Result message");
  }
  if (message.role === "tool" && message.toolCallId === undefined) {
    throw new Error("Compaction Tool Result message requires toolCallId");
  }
  if (message.toolCalls !== undefined && message.role !== "assistant") {
    throw new Error("Compaction toolCalls require an assistant message");
  }
  if (message.reasoningContent !== undefined && message.role !== "assistant") {
    throw new Error("Compaction reasoningContent requires an assistant message");
  }
  if (
    message.reasoningContent !== undefined &&
    typeof message.reasoningContent !== "string"
  ) {
    throw new Error("Compaction reasoningContent must be a string");
  }
  const toolCallIds = new Set<string>();
  return Object.freeze({
    role: message.role,
    content: message.content,
    ...(message.contentParts === undefined
      ? {}
      : {
          contentParts: Object.freeze(message.contentParts.map((part) =>
            part.type === "text"
              ? Object.freeze({ type: "text" as const, text: part.text })
              : Object.freeze({
                  type: "image_url" as const,
                  imageUrl: Object.freeze({ ...part.imageUrl }),
                })
          )),
        }),
    ...(message.toolCallId === undefined
      ? {}
      : {
          toolCallId: requireIdentifier(
            message.toolCallId,
            "Compaction Tool Result call id",
          ),
        }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: Object.freeze(message.toolCalls.map((call) => {
            const id = requireIdentifier(call.id, "Compaction Tool Call id");
            if (toolCallIds.has(id)) {
              throw new Error(`Duplicate Compaction Tool Call id: ${id}`);
            }
            toolCallIds.add(id);
            return Object.freeze({
              id,
              name: requireIdentifier(call.name, "Compaction Tool name"),
              argumentsJson: typeof call.argumentsJson === "string"
                ? call.argumentsJson
                : (() => {
                    throw new Error(
                      "Compaction Tool Call argumentsJson must be a string",
                    );
                  })(),
            });
          })),
        }),
    ...(message.reasoningContent === undefined
      ? {}
      : { reasoningContent: message.reasoningContent }),
  });
}

function snapshotArchive(
  archive: ContextToolResultArchiveReceipt,
): ContextToolResultArchiveReceipt {
  if (archive === null || typeof archive !== "object" || archive.schemaVersion !== 1) {
    throw new Error("Compaction Tool Result archive receipt is invalid");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    toolCallId: requireIdentifier(
      archive.toolCallId,
      "Compaction archive Tool Call id",
    ),
    locator: requireIdentifier(archive.locator, "Compaction archive locator"),
    hash: requireIdentifier(archive.hash, "Compaction archive hash"),
  });
}

function snapshotModelRef(model: ModelRef): ModelRef {
  if (model === null || typeof model !== "object") {
    throw new Error("Compaction model reference must be an object");
  }
  return Object.freeze({
    provider: requireIdentifier(model.provider, "Compaction Model Provider id"),
    model: requireIdentifier(model.model, "Compaction Model id"),
  });
}

function notPossible(
  reason: CompactionNotPossibleReason,
): CompactionPlanResult {
  return Object.freeze({ status: "not_possible" as const, reason });
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

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Compaction planning was aborted", { cause: signal.reason });
}
