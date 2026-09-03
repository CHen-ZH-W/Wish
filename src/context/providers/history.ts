import type {
  ContextHistoryItem,
  ContextItem,
  ContextProvider,
  ContextSummaryItem,
} from "../../core/context/projector.js";
import type {
  ModelMessage,
  ModelMessageContentPart,
  ModelMessageToolCall,
} from "../../core/model/model.js";
import type {
  ContextHistoryRecord,
  ContextHistorySource,
  ContextInput,
  ContextToolResultArchiveReceipt,
} from "../types.js";
import {
  withContextToolResultArchiveReceipt,
} from "../services/tool-results.js";

const DEFAULT_PROVIDER_ID = "history";

export interface HistoryContextProviderOptions {
  readonly source: ContextHistorySource;
  readonly id?: string;
}

interface NormalizedMessageRecord {
  readonly kind: "message";
  readonly sourceSequence: number;
  readonly message: ModelMessage;
}

interface NormalizedSummaryRecord {
  readonly kind: "summary";
  readonly sourceSequence: number;
  readonly sourceCoveredThroughSequence: number;
  readonly message: ModelMessage;
}

interface SyntheticToolResultRecord {
  readonly kind: "message";
  readonly sourceSequence: number;
  readonly syntheticToolCallId: string;
  readonly message: ModelMessage;
}

type NormalizedRecord = NormalizedMessageRecord | NormalizedSummaryRecord;
type RepairedRecord = NormalizedRecord | SyntheticToolResultRecord;

/** Maps normalized Session records to legal, deterministic Core history items. */
export class HistoryContextProvider implements ContextProvider<ContextInput> {
  readonly id: string;

  constructor(private readonly options: HistoryContextProviderOptions) {
    this.id = requireIdentifier(
      options.id ?? DEFAULT_PROVIDER_ID,
      "History provider id",
    );
  }

  async provide(
    input: ContextInput,
    signal?: AbortSignal,
  ): Promise<readonly ContextItem[]> {
    throwIfAborted(signal);
    const sessionId = requireIdentifier(input.sessionId, "Context session id");
    const currentUserTurnId = requireIdentifier(
      input.userTurnId,
      "Current Context userTurnId",
    );
    const records = await this.options.source.read({
      sessionId,
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    if (!Array.isArray(records)) {
      throw new Error("ContextHistorySource must return an array");
    }

    const normalized = normalizeRecords(records, currentUserTurnId, signal);
    const repaired = repairToolTranscript(normalized, signal);
    const sessionKey = encodeURIComponent(sessionId);
    const items = repaired.map((record, index) =>
      toContextItem(record, index, repaired, sessionKey)
    );
    throwIfAborted(signal);
    return Object.freeze(items);
  }
}

function normalizeRecords(
  records: readonly ContextHistoryRecord[],
  currentUserTurnId: string,
  signal: AbortSignal | undefined,
): readonly NormalizedRecord[] {
  const sequences = new Set<number>();
  const normalized: NormalizedRecord[] = [];

  for (const record of records) {
    throwIfAborted(signal);
    if (record === null || typeof record !== "object") {
      throw new Error("Context history records must be objects");
    }
    const sequence = positiveSafeInteger(
      record.sequence,
      "Context history source sequence",
    );
    if (sequences.has(sequence)) {
      throw new Error(`Duplicate Context history source sequence: ${sequence}`);
    }
    sequences.add(sequence);

    if (record.kind === "message") {
      if (
        record.userTurnId !== undefined &&
        requireIdentifier(record.userTurnId, "Context history userTurnId") ===
          currentUserTurnId
      ) {
        continue;
      }
      normalized.push(Object.freeze({
        kind: "message" as const,
        sourceSequence: sequence,
        message: copyModelMessage(
          record.message,
          record.toolResultArchive,
        ),
      }));
      continue;
    }
    if (record.kind !== "summary") {
      throw new Error("Unknown Context history record kind");
    }
    const coverage = nonNegativeSafeInteger(
      record.coveredThroughSequence,
      "coveredThroughSequence",
    );
    if (coverage >= sequence) {
      throw new Error("coveredThroughSequence must precede summary sequence");
    }
    normalized.push(Object.freeze({
      kind: "summary" as const,
      sourceSequence: sequence,
      sourceCoveredThroughSequence: coverage,
      message: copyModelMessage(record.message),
    }));
  }

  normalized.sort((left, right) => left.sourceSequence - right.sourceSequence);
  validateCheckpointProgress(normalized);
  validateSourceCoverageDoesNotSplitToolUnits(normalized);
  return Object.freeze(normalized);
}

function validateCheckpointProgress(records: readonly NormalizedRecord[]): void {
  let previousCoverage = -1;
  for (const record of records) {
    if (record.kind !== "summary") continue;
    if (record.sourceCoveredThroughSequence < previousCoverage) {
      throw new Error(
        "Context history checkpoint coverage must not move backwards",
      );
    }
    previousCoverage = record.sourceCoveredThroughSequence;
  }
}

function validateSourceCoverageDoesNotSplitToolUnits(
  records: readonly NormalizedRecord[],
): void {
  for (const summary of records) {
    if (summary.kind !== "summary") continue;
    for (const [index, record] of records.entries()) {
      if (record.kind !== "message") continue;
      const calls = assistantToolCalls(record.message);
      if (calls.length === 0) continue;
      const resultSequences = collectFollowingToolResults(
        records,
        index,
        calls,
      ).results;
      const unitSequences = [
        record.sourceSequence,
        ...calls.flatMap((call) => {
          const result = resultSequences.get(call.id);
          return result === undefined ? [] : [result.sourceSequence];
        }),
      ];
      const startsAt = Math.min(...unitSequences);
      const endsAt = Math.max(...unitSequences);
      if (
        summary.sourceCoveredThroughSequence >= startsAt &&
        summary.sourceCoveredThroughSequence < endsAt
      ) {
        throw new Error(
          `Context history checkpoint at ${summary.sourceSequence} splits ` +
            `Tool Call unit starting at ${record.sourceSequence}`,
        );
      }
    }
  }
}

function repairToolTranscript(
  records: readonly NormalizedRecord[],
  signal: AbortSignal | undefined,
): readonly RepairedRecord[] {
  const repaired: RepairedRecord[] = [];
  const consumed = new Set<number>();

  for (const [index, record] of records.entries()) {
    throwIfAborted(signal);
    if (
      consumed.has(index) ||
      record.kind === "message" && record.message.role === "tool"
    ) {
      continue;
    }
    repaired.push(record);
    if (record.kind !== "message") continue;

    const calls = assistantToolCalls(record.message);
    if (calls.length === 0) continue;
    const following = collectFollowingToolResults(records, index, calls);
    for (const call of calls) {
      const result = following.results.get(call.id);
      if (result === undefined) {
        repaired.push(missingToolResultRecord(record.sourceSequence, call));
        continue;
      }
      const resultIndex = following.indexes.get(call.id);
      if (resultIndex !== undefined) consumed.add(resultIndex);
      repaired.push(result);
    }
  }
  return Object.freeze(repaired);
}

function collectFollowingToolResults(
  records: readonly NormalizedRecord[],
  assistantIndex: number,
  calls: readonly ModelMessageToolCall[],
): {
  readonly results: ReadonlyMap<string, NormalizedMessageRecord>;
  readonly indexes: ReadonlyMap<string, number>;
} {
  const expected = new Set(calls.map((call) => call.id));
  const results = new Map<string, NormalizedMessageRecord>();
  const indexes = new Map<string, number>();

  for (let index = assistantIndex + 1; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.kind === "summary") break;
    if (assistantToolCalls(record.message).length > 0) break;
    if (
      record.message.role === "tool" &&
      record.message.toolCallId !== undefined &&
      expected.has(record.message.toolCallId) &&
      !results.has(record.message.toolCallId)
    ) {
      results.set(record.message.toolCallId, record);
      indexes.set(record.message.toolCallId, index);
    }
    if (results.size === expected.size) break;
  }
  return { results, indexes };
}

function missingToolResultRecord(
  sourceSequence: number,
  call: ModelMessageToolCall,
): SyntheticToolResultRecord {
  return Object.freeze({
    kind: "message" as const,
    sourceSequence,
    syntheticToolCallId: call.id,
    message: Object.freeze({
      role: "tool" as const,
      toolCallId: call.id,
      content: JSON.stringify({
        ok: false,
        callId: call.id,
        toolName: call.name,
        error: {
          code: "missing_tool_result",
          message:
            `Tool result for "${call.name}" was not recorded before the ` +
            "conversation continued. Treat this tool call as interrupted.",
          retryable: false,
        },
      }),
    }),
  });
}

function toContextItem(
  record: RepairedRecord,
  index: number,
  records: readonly RepairedRecord[],
  sessionKey: string,
): ContextHistoryItem | ContextSummaryItem {
  const sequence = index + 1;
  if (record.kind === "summary") {
    return Object.freeze({
      id: `history:${sessionKey}:${record.sourceSequence}`,
      kind: "summary" as const,
      placement: "history" as const,
      sequence,
      coveredThroughSequence: projectedCoverage(
        records,
        record.sourceCoveredThroughSequence,
      ),
      message: record.message,
    });
  }
  const suffix = "syntheticToolCallId" in record
    ? `:missing-tool-result:${encodeURIComponent(record.syntheticToolCallId)}`
    : "";
  return Object.freeze({
    id: `history:${sessionKey}:${record.sourceSequence}${suffix}`,
    kind: "history" as const,
    placement: "history" as const,
    sequence,
    message: record.message,
  });
}

function projectedCoverage(
  records: readonly RepairedRecord[],
  sourceCoverage: number,
): number {
  let coverage = 0;
  for (const [index, record] of records.entries()) {
    if (record.sourceSequence <= sourceCoverage) coverage = index + 1;
  }
  return coverage;
}

function assistantToolCalls(
  message: ModelMessage,
): readonly ModelMessageToolCall[] {
  return message.role === "assistant" ? message.toolCalls ?? [] : [];
}

function copyModelMessage(
  message: ModelMessage,
  toolResultArchive?: ContextToolResultArchiveReceipt,
): ModelMessage {
  if (message === null || typeof message !== "object") {
    throw new Error("Context history record must contain a ModelMessage");
  }
  if (
    message.role !== "system" &&
    message.role !== "developer" &&
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool"
  ) {
    throw new Error("Context history record has an unknown message role");
  }
  if (typeof message.content !== "string") {
    throw new Error("Context history message content must be a string");
  }
  const contentParts = message.contentParts === undefined
    ? undefined
    : copyContentParts(message.contentParts);
  const toolCalls = message.toolCalls === undefined
    ? undefined
    : copyToolCalls(message.toolCalls);
  if (
    message.reasoningContent !== undefined &&
    typeof message.reasoningContent !== "string"
  ) {
    throw new Error("Context history reasoningContent must be a string");
  }
  if (
    message.reasoningContent !== undefined &&
    message.role !== "assistant"
  ) {
    throw new Error("Context history reasoningContent requires assistant role");
  }
  if (toolCalls !== undefined && message.role !== "assistant") {
    throw new Error("Context history toolCalls require assistant role");
  }
  if (message.toolCallId !== undefined) {
    if (message.role !== "tool") {
      throw new Error("Context history toolCallId requires tool role");
    }
    requireIdentifier(message.toolCallId, "Context history toolCallId");
  } else if (message.role === "tool") {
    throw new Error("Context history Tool Result requires toolCallId");
  }
  const copied = Object.freeze({
    role: message.role,
    content: message.content,
    ...(contentParts === undefined ? {} : { contentParts }),
    ...(message.reasoningContent === undefined
      ? {}
      : { reasoningContent: message.reasoningContent }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  });
  if (toolResultArchive === undefined) return copied;
  if (copied.role !== "tool") {
    throw new Error("Context history archive receipt requires a Tool Result");
  }
  return withContextToolResultArchiveReceipt(copied, toolResultArchive);
}

function copyContentParts(
  parts: readonly ModelMessageContentPart[],
): readonly ModelMessageContentPart[] {
  if (!Array.isArray(parts)) {
    throw new Error("Context history contentParts must be an array");
  }
  return Object.freeze(parts.map((part) => {
    if (part === null || typeof part !== "object") {
      throw new Error("Context history contains an invalid content part");
    }
    if (part.type === "text" && typeof part.text === "string") {
      return Object.freeze({ type: "text" as const, text: part.text });
    }
    if (
      part.type === "image_url" &&
      part.imageUrl !== null &&
      typeof part.imageUrl === "object" &&
      typeof part.imageUrl.url === "string" &&
      (part.imageUrl.detail === undefined ||
        part.imageUrl.detail === "auto" ||
        part.imageUrl.detail === "low" ||
        part.imageUrl.detail === "high")
    ) {
      return Object.freeze({
        type: "image_url" as const,
        imageUrl: Object.freeze({
          url: part.imageUrl.url,
          ...(part.imageUrl.detail === undefined ? {} : { detail: part.imageUrl.detail }),
        }),
      });
    }
    throw new Error("Context history contains an invalid content part");
  }));
}

function copyToolCalls(
  calls: readonly ModelMessageToolCall[],
): readonly ModelMessageToolCall[] {
  if (!Array.isArray(calls)) {
    throw new Error("Context history toolCalls must be an array");
  }
  const ids = new Set<string>();
  return Object.freeze(calls.map((call) => {
    if (call === null || typeof call !== "object") {
      throw new Error("Context history contains an invalid Tool Call");
    }
    const id = requireIdentifier(call.id, "Context history Tool Call id");
    const name = requireIdentifier(call.name, "Context history Tool Call name");
    if (typeof call.argumentsJson !== "string") {
      throw new Error("Context history Tool Call argumentsJson must be a string");
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate Context history Tool Call id: ${id}`);
    }
    ids.add(id);
    return Object.freeze({ id, name, argumentsJson: call.argumentsJson });
  }));
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
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
  throw new Error("Context history operation was aborted", { cause: signal.reason });
}
