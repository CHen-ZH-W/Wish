import { createHash } from "node:crypto";
import type {
  CompactionCheckpointAppendInput,
  CompactionSessionPort,
  CompactionSessionSnapshot,
} from "../../compaction/types.js";
import type {
  ContextHistoryReadInput,
  ContextHistoryRecord,
  ContextHistorySource,
} from "../../context/types.js";
import type {
  AppendSessionCheckpointInput,
  AppendSessionCheckpointResult,
  ReadSessionHistoryInput,
  SessionHistoryRecord,
  SessionHistorySnapshot,
} from "../types.js";

export interface SessionHistoryAccess {
  readHistory(input: ReadSessionHistoryInput): Promise<SessionHistorySnapshot>;
  appendCheckpoint(
    input: AppendSessionCheckpointInput,
  ): Promise<AppendSessionCheckpointResult>;
}

export interface SessionHistoryAdapterOptions {
  readonly sessions: SessionHistoryAccess;
}

/**
 * One adapter with two narrow views. The properties avoid the existing Port
 * name collision: both ContextHistorySource and CompactionSessionPort call
 * their incompatible operation `read`.
 */
export class SessionHistoryAdapter {
  readonly context: ContextHistorySource;
  readonly compaction: CompactionSessionPort;

  constructor(private readonly options: SessionHistoryAdapterOptions) {
    this.context = Object.freeze({
      read: async (input: ContextHistoryReadInput) => {
        const snapshot = await this.options.sessions.readHistory({
          sessionId: input.sessionId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return mapHistory(snapshot.records);
      },
    });
    this.compaction = Object.freeze({
      read: async (input: ContextHistoryReadInput): Promise<CompactionSessionSnapshot> => {
        const snapshot = await this.options.sessions.readHistory({
          sessionId: input.sessionId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return Object.freeze({
          revision: snapshot.historyRevision,
          records: mapHistory(snapshot.records),
        });
      },
      appendCheckpoint: async (input: CompactionCheckpointAppendInput) => {
        const committed = await this.options.sessions.appendCheckpoint({
          sessionId: input.sessionId,
          expectedRevision: input.expectedRevision,
          checkpoint: {
            idempotencyKey: checkpointIdempotencyKey(input),
            coveredThroughSequence: input.checkpoint.coveredThroughSequence,
            sourceSequences: input.checkpoint.sourceSequences,
            reason: input.checkpoint.reason,
            message: input.checkpoint.message,
            ...(input.checkpoint.summaryUsage === undefined
              ? {}
              : { summaryUsage: input.checkpoint.summaryUsage }),
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const record = committed.record;
        return Object.freeze({
          kind: "summary" as const,
          sequence: record.sequence,
          coveredThroughSequence: record.coveredThroughSequence,
          message: copyMessage(record.message) as typeof record.message,
        });
      },
    });
  }
}

function mapHistory(
  records: readonly SessionHistoryRecord[],
): readonly ContextHistoryRecord[] {
  return Object.freeze(records.map((record): ContextHistoryRecord => {
    if (record.kind === "message") {
      return Object.freeze({
        kind: "message" as const,
        sequence: record.sequence,
        userTurnId: record.userTurnId,
        message: copyMessage(record.message),
        ...(record.toolResultArchive === undefined
          ? {}
          : {
              toolResultArchive: Object.freeze({
                schemaVersion: 1 as const,
                toolCallId: record.toolResultArchive.toolCallId,
                locator: record.toolResultArchive.locator,
                hash: record.toolResultArchive.hash,
              }),
            }),
      });
    }
    return Object.freeze({
      kind: "summary" as const,
      sequence: record.sequence,
      coveredThroughSequence: record.coveredThroughSequence,
      message: copyMessage(record.message) as typeof record.message,
    });
  }));
}

function checkpointIdempotencyKey(
  input: Parameters<CompactionSessionPort["appendCheckpoint"]>[0],
): string {
  const identity = stableJson({
    expectedRevision: input.expectedRevision,
    coveredThroughSequence: input.checkpoint.coveredThroughSequence,
    sourceSequences: input.checkpoint.sourceSequences,
    reason: input.checkpoint.reason,
    message: input.checkpoint.message,
    ...(input.checkpoint.summaryUsage === undefined
      ? {}
      : { summaryUsage: input.checkpoint.summaryUsage }),
  });
  return `compaction:${createHash("sha256").update(identity).digest("hex")}`;
}

function copyMessage<Message extends SessionHistoryRecord["message"]>(
  message: Message,
): Message {
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
      : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: Object.freeze(
            message.toolCalls.map((call) => Object.freeze({ ...call })),
          ),
        }),
    ...(message.reasoningContent === undefined
      ? {}
      : { reasoningContent: message.reasoningContent }),
  }) as Message;
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortValue(value));
  if (serialized === undefined) {
    throw new Error("Compaction checkpoint identity is not serializable");
  }
  return serialized;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}
