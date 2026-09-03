import type {
  ModelMessage,
  ModelMessageContentPart,
  ModelMessageToolCall,
  ModelUsage,
} from "../core/model/model.js";
import {
  SessionCorruptionError,
  SessionIdempotencyConflictError,
  SessionInvalidTranscriptError,
  SessionRevisionConflictError,
  type AppendSessionCheckpointInput,
  type AppendSessionMessagesInput,
  type ArchiveSessionInput,
  type CreateSessionInput,
  type GetSessionInput,
  type ListSessionsInput,
  type ReadSessionHistoryInput,
  type Session,
  type SessionCheckpointDraft,
  type SessionCheckpointProvenance,
  type SessionCheckpointRecord,
  type SessionHistoryRecord,
  type SessionHistoryRevision,
  type SessionHistorySnapshot,
  type SessionId,
  type SessionMessageDraft,
  type SessionMessageOrigin,
  type SessionMessageRecord,
  type SessionStatus,
  type SessionToolResultArchiveReceipt,
  type UpdateSessionMetadataInput,
} from "./types.js";

export interface SessionRecordAllocation {
  readonly recordId: () => string;
  readonly createdAt: () => string;
}

export function normalizeCreateSessionInput(
  input: CreateSessionInput,
): CreateSessionInput {
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "Session id"),
    agentId: requireIdentifier(input.agentId, "Session agentId"),
    scope: requireIdentifier(input.scope, "Session scope"),
    ...(input.title === undefined
      ? {}
      : { title: requireTitle(input.title) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function normalizeGetSessionInput(input: GetSessionInput): GetSessionInput {
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "Session id"),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function normalizeListSessionsInput(
  input: ListSessionsInput | undefined,
): ListSessionsInput {
  if (input === undefined) return Object.freeze({});
  return Object.freeze({
    ...(input.agentId === undefined
      ? {}
      : { agentId: requireIdentifier(input.agentId, "Session list agentId") }),
    ...(input.status === undefined
      ? {}
      : { status: requireStatus(input.status) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function normalizeUpdateSessionMetadataInput(
  input: UpdateSessionMetadataInput,
): UpdateSessionMetadataInput {
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "Session id"),
    ...(input.title === undefined
      ? {}
      : { title: input.title === null ? null : requireTitle(input.title) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function normalizeArchiveSessionInput(
  input: ArchiveSessionInput,
): ArchiveSessionInput {
  return normalizeGetSessionInput(input);
}

export function normalizeReadSessionHistoryInput(
  input: ReadSessionHistoryInput,
): ReadSessionHistoryInput {
  return normalizeGetSessionInput(input);
}

export function normalizeAppendSessionMessagesInput(
  input: AppendSessionMessagesInput,
): AppendSessionMessagesInput {
  const sessionId = requireIdentifier(input.sessionId, "Session id");
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw invalid("Session message append must contain at least one message", sessionId);
  }
  const messages = Object.freeze(input.messages.map((draft) =>
    snapshotMessageDraft(draft, sessionId)
  ));
  validateNewMessageBatch(messages, sessionId);
  return Object.freeze({
    sessionId,
    messages,
    ...(input.expectedRevision === undefined
      ? {}
      : {
          expectedRevision: requireIdentifier(
            input.expectedRevision,
            "Session expected revision",
          ),
        }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function normalizeAppendSessionCheckpointInput(
  input: AppendSessionCheckpointInput,
): AppendSessionCheckpointInput {
  const sessionId = requireIdentifier(input.sessionId, "Session id");
  return Object.freeze({
    sessionId,
    expectedRevision: requireIdentifier(
      input.expectedRevision,
      "Session expected revision",
    ),
    checkpoint: snapshotCheckpointDraft(input.checkpoint, sessionId),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function createSessionDescriptor(input: {
  readonly create: CreateSessionInput;
  readonly createdAt: string;
  readonly historyRevision: SessionHistoryRevision;
}): Session {
  const normalized = normalizeCreateSessionInput(input.create);
  const createdAt = requireTimestamp(input.createdAt, "Session createdAt");
  return Object.freeze({
    schemaVersion: 1 as const,
    sessionId: normalized.sessionId,
    agentId: normalized.agentId,
    scope: normalized.scope,
    status: "active" as const,
    createdAt,
    updatedAt: createdAt,
    historyRevision: requireIdentifier(
      input.historyRevision,
      "Session history revision",
    ),
    ...(normalized.title === undefined ? {} : { title: normalized.title }),
  });
}

export function snapshotSession(value: Session): Session {
  if (value === null || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new SessionCorruptionError(
      sessionIdFromUnknown(value),
      "Unknown Session schemaVersion",
    );
  }
  const sessionId = requireIdentifier(value.sessionId, "Session id");
  return Object.freeze({
    schemaVersion: 1 as const,
    sessionId,
    agentId: requireIdentifier(value.agentId, "Session agentId"),
    scope: requireIdentifier(value.scope, "Session scope"),
    status: requireStatus(value.status),
    createdAt: requireTimestamp(value.createdAt, "Session createdAt"),
    updatedAt: requireTimestamp(value.updatedAt, "Session updatedAt"),
    historyRevision: requireIdentifier(
      value.historyRevision,
      "Session history revision",
    ),
    ...(value.title === undefined ? {} : { title: requireTitle(value.title) }),
  });
}

export function snapshotHistoryRecords(
  records: readonly SessionHistoryRecord[],
  sessionId: SessionId,
): readonly SessionHistoryRecord[] {
  if (!Array.isArray(records)) {
    throw new SessionCorruptionError(
      sessionId,
      "Session history records must be an array",
    );
  }
  const copied = records.map((record) => snapshotHistoryRecord(record, sessionId));
  const recordIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const [index, record] of copied.entries()) {
    const expectedSequence = index + 1;
    if (record.sequence !== expectedSequence) {
      throw new SessionCorruptionError(
        sessionId,
        `Session history sequence must be continuous; expected ${expectedSequence}`,
      );
    }
    if (recordIds.has(record.recordId)) {
      throw new SessionCorruptionError(
        sessionId,
        `Duplicate Session recordId: ${record.recordId}`,
      );
    }
    if (idempotencyKeys.has(record.idempotencyKey)) {
      throw new SessionCorruptionError(
        sessionId,
        `Duplicate Session idempotency key: ${record.idempotencyKey}`,
      );
    }
    recordIds.add(record.recordId);
    idempotencyKeys.add(record.idempotencyKey);
  }
  validateStoredCheckpoints(copied, sessionId);
  return Object.freeze(copied);
}

export function snapshotHistory(input: SessionHistorySnapshot): SessionHistorySnapshot {
  const sessionId = requireIdentifier(input.sessionId, "Session id");
  return Object.freeze({
    sessionId,
    historyRevision: requireIdentifier(
      input.historyRevision,
      "Session history revision",
    ),
    records: snapshotHistoryRecords(input.records, sessionId),
  });
}

export function snapshotSessionMessageRecord(
  record: SessionMessageRecord,
  sessionId: SessionId,
): SessionMessageRecord {
  return snapshotMessageRecord(record, sessionId);
}

export function snapshotSessionCheckpointRecord(
  record: SessionCheckpointRecord,
  sessionId: SessionId,
): SessionCheckpointRecord {
  return snapshotCheckpointRecord(record, sessionId);
}

export function findMessageReplay(
  sessionId: SessionId,
  records: readonly SessionHistoryRecord[],
  drafts: readonly SessionMessageDraft[],
): readonly SessionMessageRecord[] | undefined {
  const byKey = new Map(records.map((record) => [record.idempotencyKey, record]));
  const matches: SessionMessageRecord[] = [];
  let found = 0;
  for (const draft of drafts) {
    const existing = byKey.get(draft.idempotencyKey);
    if (existing === undefined) continue;
    found += 1;
    if (existing.kind !== "message" || !sameMessageDraft(existing, draft)) {
      throw new SessionIdempotencyConflictError(
        sessionId,
        draft.idempotencyKey,
      );
    }
    matches.push(existing);
  }
  if (found === 0) return undefined;
  if (found !== drafts.length) {
    const conflict = drafts.find((draft) => !byKey.has(draft.idempotencyKey)) ??
      drafts[0];
    throw new SessionIdempotencyConflictError(
      sessionId,
      conflict?.idempotencyKey ?? "unknown",
    );
  }
  return Object.freeze(matches.map((record) => snapshotMessageRecord(record, sessionId)));
}

export function findCheckpointReplay(
  sessionId: SessionId,
  records: readonly SessionHistoryRecord[],
  draft: SessionCheckpointDraft,
): SessionCheckpointRecord | undefined {
  const existing = records.find(
    (record) => record.idempotencyKey === draft.idempotencyKey,
  );
  if (existing === undefined) return undefined;
  if (existing.kind !== "checkpoint" || !sameCheckpointDraft(existing, draft)) {
    throw new SessionIdempotencyConflictError(sessionId, draft.idempotencyKey);
  }
  return snapshotCheckpointRecord(existing, sessionId);
}

export function assertExpectedRevision(input: {
  readonly sessionId: SessionId;
  readonly expectedRevision: SessionHistoryRevision | undefined;
  readonly actualRevision: SessionHistoryRevision;
}): void {
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== input.actualRevision
  ) {
    throw new SessionRevisionConflictError(
      input.sessionId,
      input.expectedRevision,
      input.actualRevision,
    );
  }
}

export function allocateMessageRecords(input: {
  readonly sessionId: SessionId;
  readonly records: readonly SessionHistoryRecord[];
  readonly drafts: readonly SessionMessageDraft[];
  readonly allocation: SessionRecordAllocation;
}): readonly SessionMessageRecord[] {
  validateNewMessageBatch(input.drafts, input.sessionId);
  const start = input.records.length + 1;
  return Object.freeze(input.drafts.map((draft, index) => Object.freeze({
    schemaVersion: 1 as const,
    kind: "message" as const,
    recordId: requireIdentifier(
      input.allocation.recordId(),
      "Session recordId",
    ),
    sequence: start + index,
    idempotencyKey: draft.idempotencyKey,
    runId: draft.runId,
    userTurnId: draft.userTurnId,
    stepId: draft.stepId,
    origin: draft.origin,
    createdAt: requireTimestamp(
      input.allocation.createdAt(),
      "Session record createdAt",
    ),
    message: snapshotModelMessage(draft.message),
    ...(draft.toolResultArchive === undefined
      ? {}
      : { toolResultArchive: snapshotArchive(draft.toolResultArchive) }),
  })));
}

export function allocateCheckpointRecord(input: {
  readonly sessionId: SessionId;
  readonly records: readonly SessionHistoryRecord[];
  readonly draft: SessionCheckpointDraft;
  readonly allocation: SessionRecordAllocation;
}): SessionCheckpointRecord {
  validateCheckpointAgainstHistory(input.draft, input.records, input.sessionId);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "checkpoint" as const,
    recordId: requireIdentifier(
      input.allocation.recordId(),
      "Session recordId",
    ),
    sequence: input.records.length + 1,
    idempotencyKey: input.draft.idempotencyKey,
    createdAt: requireTimestamp(
      input.allocation.createdAt(),
      "Session record createdAt",
    ),
    coveredThroughSequence: input.draft.coveredThroughSequence,
    sourceSequences: Object.freeze([...input.draft.sourceSequences]),
    reason: input.draft.reason,
    message: snapshotModelMessage(input.draft.message) as ModelMessage & {
      readonly role: "assistant";
    },
    ...(input.draft.provenance === undefined
      ? {}
      : { provenance: snapshotProvenance(input.draft.provenance) }),
    ...(input.draft.summaryUsage === undefined
      ? {}
      : { summaryUsage: snapshotUsage(input.draft.summaryUsage) }),
  });
}

export function validateCheckpointAgainstHistory(
  draft: SessionCheckpointDraft,
  records: readonly SessionHistoryRecord[],
  sessionId: SessionId,
): void {
  const bySequence = new Map(records.map((record) => [record.sequence, record]));
  const boundary = bySequence.get(draft.coveredThroughSequence);
  if (boundary === undefined || boundary.kind !== "message") {
    throw invalid(
      "Session checkpoint coverage must identify an existing message",
      sessionId,
    );
  }
  for (const sequence of draft.sourceSequences) {
    if (!bySequence.has(sequence) || sequence > draft.coveredThroughSequence) {
      throw invalid(
        `Session checkpoint source sequence does not belong to its covered prefix: ${sequence}`,
        sessionId,
      );
    }
  }
  const latestCoverage = records.reduce(
    (coverage, record) => record.kind === "checkpoint"
      ? Math.max(coverage, record.coveredThroughSequence)
      : coverage,
    0,
  );
  if (draft.coveredThroughSequence < latestCoverage) {
    throw invalid("Session checkpoint coverage must not move backwards", sessionId);
  }
  assertCoverageDoesNotSplitToolUnit(
    draft.coveredThroughSequence,
    records,
    sessionId,
  );
}

export function updateSessionMetadataSnapshot(input: {
  readonly session: Session;
  readonly title: string | null | undefined;
  readonly updatedAt: string;
}): Session {
  const session = snapshotSession(input.session);
  if (input.title === undefined) return session;
  return Object.freeze({
    ...session,
    updatedAt: requireTimestamp(input.updatedAt, "Session updatedAt"),
    ...(input.title === null ? { title: undefined } : { title: requireTitle(input.title) }),
  }) as Session;
}

export function archiveSessionSnapshot(input: {
  readonly session: Session;
  readonly updatedAt: string;
}): Session {
  const session = snapshotSession(input.session);
  if (session.status === "archived") return session;
  return Object.freeze({
    ...session,
    status: "archived" as const,
    updatedAt: requireTimestamp(input.updatedAt, "Session updatedAt"),
  });
}

function snapshotMessageDraft(
  draft: SessionMessageDraft,
  sessionId: SessionId,
): SessionMessageDraft {
  if (draft === null || typeof draft !== "object") {
    throw invalid("Session message draft must be an object", sessionId);
  }
  const message = snapshotModelMessage(draft.message);
  const origin = requireOrigin(draft.origin);
  validateOriginRole(origin, message, sessionId);
  const archive = draft.toolResultArchive === undefined
    ? undefined
    : snapshotArchive(draft.toolResultArchive);
  if (archive !== undefined) {
    if (message.role !== "tool" || message.toolCallId !== archive.toolCallId) {
      throw invalid(
        "Session Tool Result archive receipt must match its Tool message",
        sessionId,
      );
    }
  }
  return Object.freeze({
    idempotencyKey: requireIdentifier(
      draft.idempotencyKey,
      "Session idempotency key",
    ),
    runId: requireIdentifier(draft.runId, "Session message runId"),
    userTurnId: requireIdentifier(
      draft.userTurnId,
      "Session message userTurnId",
    ),
    stepId: requireIdentifier(draft.stepId, "Session message stepId"),
    origin,
    message,
    ...(archive === undefined ? {} : { toolResultArchive: archive }),
  });
}

function snapshotCheckpointDraft(
  draft: SessionCheckpointDraft,
  sessionId: SessionId,
): SessionCheckpointDraft {
  if (draft === null || typeof draft !== "object") {
    throw invalid("Session checkpoint draft must be an object", sessionId);
  }
  const message = snapshotModelMessage(draft.message);
  if (
    message.role !== "assistant" ||
    message.content.trim().length === 0 ||
    message.contentParts !== undefined ||
    message.reasoningContent !== undefined ||
    message.toolCalls !== undefined ||
    message.toolCallId !== undefined
  ) {
    throw invalid(
      "Session checkpoint must contain one plain non-empty Assistant summary",
      sessionId,
    );
  }
  const sourceSequences = snapshotPositiveSequences(
    draft.sourceSequences,
    "Session checkpoint sourceSequences",
    sessionId,
  );
  if (sourceSequences.length === 0) {
    throw invalid("Session checkpoint sourceSequences must not be empty", sessionId);
  }
  return Object.freeze({
    idempotencyKey: requireIdentifier(
      draft.idempotencyKey,
      "Session checkpoint idempotency key",
    ),
    coveredThroughSequence: positiveSafeInteger(
      draft.coveredThroughSequence,
      "Session checkpoint coverage",
      sessionId,
    ),
    sourceSequences,
    reason: requireIdentifier(draft.reason, "Session checkpoint reason"),
    message: message as ModelMessage & { readonly role: "assistant" },
    ...(draft.provenance === undefined
      ? {}
      : { provenance: snapshotProvenance(draft.provenance) }),
    ...(draft.summaryUsage === undefined
      ? {}
      : { summaryUsage: snapshotUsage(draft.summaryUsage) }),
  });
}

function validateNewMessageBatch(
  drafts: readonly SessionMessageDraft[],
  sessionId: SessionId,
): void {
  const idempotencyKeys = new Set<string>();
  for (const draft of drafts) {
    if (idempotencyKeys.has(draft.idempotencyKey)) {
      throw invalid(
        `Duplicate Session idempotency key in append: ${draft.idempotencyKey}`,
        sessionId,
      );
    }
    idempotencyKeys.add(draft.idempotencyKey);
  }

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    if (draft === undefined) continue;
    const message = draft.message;
    if (message.role === "tool") {
      throw invalid("A new Session append cannot start with an orphan Tool Result", sessionId);
    }
    if (message.role !== "assistant" || (message.toolCalls?.length ?? 0) === 0) {
      continue;
    }

    const calls = message.toolCalls ?? [];
    const callIds = new Set(calls.map((call) => call.id));
    const results = drafts.slice(index + 1, index + 1 + calls.length);
    if (results.length !== calls.length || results.some((result) => result.message.role !== "tool")) {
      throw invalid(
        "Assistant Tool Calls and all Tool Results must be one atomic batch",
        sessionId,
      );
    }
    const resultIds = new Set<string>();
    for (const result of results) {
      if (
        result.runId !== draft.runId ||
        result.userTurnId !== draft.userTurnId ||
        result.stepId !== draft.stepId
      ) {
        throw invalid(
          "Assistant Tool Call and Tool Result provenance must match",
          sessionId,
        );
      }
      const callId = result.message.toolCallId;
      if (
        callId === undefined ||
        !callIds.has(callId) ||
        resultIds.has(callId)
      ) {
        throw invalid("Tool Result does not match its Assistant Tool Call", sessionId);
      }
      resultIds.add(callId);
    }
    if (resultIds.size !== callIds.size) {
      throw invalid("Every Assistant Tool Call must have one Tool Result", sessionId);
    }
    index += results.length;
  }
}

function validateOriginRole(
  origin: SessionMessageOrigin,
  message: ModelMessage,
  sessionId: SessionId,
): void {
  if (message.role === "system" || message.role === "developer") {
    throw invalid(
      "Session transcript must not persist Context system/developer instructions",
      sessionId,
    );
  }
  if (
    (origin === "user_input" || origin === "steering") &&
    message.role !== "user"
  ) {
    throw invalid(`${origin} must persist a User message`, sessionId);
  }
  if (origin === "assistant" && message.role !== "assistant") {
    throw invalid("assistant origin must persist an Assistant message", sessionId);
  }
  if (origin === "tool" && message.role !== "tool") {
    throw invalid("tool origin must persist a Tool message", sessionId);
  }
}

function snapshotHistoryRecord(
  record: SessionHistoryRecord,
  sessionId: SessionId,
): SessionHistoryRecord {
  if (record === null || typeof record !== "object" || record.schemaVersion !== 1) {
    throw new SessionCorruptionError(
      sessionId,
      "Unknown Session history record schemaVersion",
    );
  }
  if (record.kind === "message") return snapshotMessageRecord(record, sessionId);
  if (record.kind === "checkpoint") {
    return snapshotCheckpointRecord(record, sessionId);
  }
  throw new SessionCorruptionError(sessionId, "Unknown Session history record kind");
}

function snapshotMessageRecord(
  record: SessionMessageRecord,
  sessionId: SessionId,
): SessionMessageRecord {
  const draft = snapshotMessageDraft(record, sessionId);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "message" as const,
    recordId: requireIdentifier(record.recordId, "Session recordId"),
    sequence: positiveSafeInteger(record.sequence, "Session sequence", sessionId),
    ...draft,
    createdAt: requireTimestamp(record.createdAt, "Session record createdAt"),
  });
}

function snapshotCheckpointRecord(
  record: SessionCheckpointRecord,
  sessionId: SessionId,
): SessionCheckpointRecord {
  const draft = snapshotCheckpointDraft(record, sessionId);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "checkpoint" as const,
    recordId: requireIdentifier(record.recordId, "Session recordId"),
    sequence: positiveSafeInteger(record.sequence, "Session sequence", sessionId),
    ...draft,
    createdAt: requireTimestamp(record.createdAt, "Session record createdAt"),
  });
}

function validateStoredCheckpoints(
  records: readonly SessionHistoryRecord[],
  sessionId: SessionId,
): void {
  let previousCoverage = 0;
  const prior: SessionHistoryRecord[] = [];
  for (const record of records) {
    if (record.kind === "checkpoint") {
      if (record.coveredThroughSequence < previousCoverage) {
        throw new SessionCorruptionError(
          sessionId,
          "Session checkpoint coverage moved backwards",
        );
      }
      try {
        validateCheckpointAgainstHistory(record, prior, sessionId);
      } catch (error: unknown) {
        throw error instanceof SessionCorruptionError
          ? error
          : new SessionCorruptionError(
              sessionId,
              error instanceof Error
                ? error.message
                : "Session checkpoint is corrupt",
              { cause: error },
            );
      }
      previousCoverage = record.coveredThroughSequence;
    }
    prior.push(record);
  }
}

function assertCoverageDoesNotSplitToolUnit(
  coverage: number,
  records: readonly SessionHistoryRecord[],
  sessionId: SessionId,
): void {
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
      if (candidate.kind !== "message" || candidate.message.role !== "tool") break;
      const callId = candidate.message.toolCallId;
      if (callId === undefined || !pending.delete(callId)) break;
      end = candidate.sequence;
      if (pending.size === 0) break;
    }
    if (
      coverage >= record.sequence &&
      (coverage < end || pending.size > 0)
    ) {
      throw invalid(
        `Session checkpoint coverage splits Tool Call unit at ${record.sequence}`,
        sessionId,
      );
    }
  }
}

function snapshotModelMessage(message: ModelMessage): ModelMessage {
  if (message === null || typeof message !== "object") {
    throw new SessionInvalidTranscriptError("Session ModelMessage must be an object");
  }
  if (
    message.role !== "system" &&
    message.role !== "developer" &&
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool"
  ) {
    throw new SessionInvalidTranscriptError("Unknown Session ModelMessage role");
  }
  if (typeof message.content !== "string") {
    throw new SessionInvalidTranscriptError("Session message content must be a string");
  }
  const contentParts = message.contentParts === undefined
    ? undefined
    : snapshotContentParts(message.contentParts);
  const toolCalls = message.toolCalls === undefined
    ? undefined
    : snapshotToolCalls(message.toolCalls);
  if (
    message.reasoningContent !== undefined &&
    typeof message.reasoningContent !== "string"
  ) {
    throw new SessionInvalidTranscriptError(
      "Session reasoningContent must be a string",
    );
  }
  if (message.toolCallId !== undefined) {
    requireIdentifier(message.toolCallId, "Session message toolCallId");
  }
  if (message.role === "tool") {
    if (message.toolCallId === undefined || toolCalls !== undefined) {
      throw new SessionInvalidTranscriptError(
        "Session Tool message requires toolCallId and cannot declare Tool Calls",
      );
    }
  } else if (message.toolCallId !== undefined) {
    throw new SessionInvalidTranscriptError(
      "Only a Session Tool message may carry toolCallId",
    );
  }
  if (message.role !== "assistant" && toolCalls !== undefined) {
    throw new SessionInvalidTranscriptError(
      "Only a Session Assistant message may declare Tool Calls",
    );
  }
  return Object.freeze({
    role: message.role,
    content: message.content,
    ...(contentParts === undefined ? {} : { contentParts }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(message.reasoningContent === undefined
      ? {}
      : { reasoningContent: message.reasoningContent }),
  });
}

function snapshotContentParts(
  parts: readonly ModelMessageContentPart[],
): readonly ModelMessageContentPart[] {
  if (!Array.isArray(parts)) {
    throw new SessionInvalidTranscriptError("Session contentParts must be an array");
  }
  return Object.freeze(parts.map((part) => {
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new SessionInvalidTranscriptError(
          "Session text content part must contain text",
        );
      }
      return Object.freeze({ type: "text" as const, text: part.text });
    }
    if (
      part.type !== "image_url" ||
      part.imageUrl === null ||
      typeof part.imageUrl !== "object" ||
      typeof part.imageUrl.url !== "string" ||
      (part.imageUrl.detail !== undefined &&
        part.imageUrl.detail !== "auto" &&
        part.imageUrl.detail !== "low" &&
        part.imageUrl.detail !== "high")
    ) {
      throw new SessionInvalidTranscriptError("Invalid Session image content part");
    }
    return Object.freeze({
      type: "image_url" as const,
      imageUrl: Object.freeze({
        url: part.imageUrl.url,
        ...(part.imageUrl.detail === undefined
          ? {}
          : { detail: part.imageUrl.detail }),
      }),
    });
  }));
}

function snapshotToolCalls(
  calls: readonly ModelMessageToolCall[],
): readonly ModelMessageToolCall[] {
  if (!Array.isArray(calls)) {
    throw new SessionInvalidTranscriptError("Session toolCalls must be an array");
  }
  const ids = new Set<string>();
  return Object.freeze(calls.map((call) => {
    const id = requireIdentifier(call.id, "Session Tool Call id");
    if (ids.has(id)) {
      throw new SessionInvalidTranscriptError(
        `Duplicate Tool Call id in one Assistant message: ${id}`,
      );
    }
    ids.add(id);
    if (typeof call.argumentsJson !== "string") {
      throw new SessionInvalidTranscriptError(
        "Session Tool Call argumentsJson must be a string",
      );
    }
    return Object.freeze({
      id,
      name: requireIdentifier(call.name, "Session Tool Call name"),
      argumentsJson: call.argumentsJson,
    });
  }));
}

function snapshotArchive(
  receipt: SessionToolResultArchiveReceipt,
): SessionToolResultArchiveReceipt {
  if (receipt === null || typeof receipt !== "object" || receipt.schemaVersion !== 1) {
    throw new SessionInvalidTranscriptError(
      "Unknown Session Tool Result archive receipt schemaVersion",
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    toolCallId: requireIdentifier(
      receipt.toolCallId,
      "Session archive toolCallId",
    ),
    locator: requireIdentifier(receipt.locator, "Session archive locator"),
    hash: requireIdentifier(receipt.hash, "Session archive hash"),
  });
}

function snapshotUsage(usage: ModelUsage): ModelUsage {
  if (usage === null || typeof usage !== "object") {
    throw new SessionInvalidTranscriptError("Session summary usage must be an object");
  }
  tokenCount(usage.inputTokens, "inputTokens");
  tokenCount(usage.outputTokens, "outputTokens");
  tokenCount(usage.totalTokens, "totalTokens");
  if (usage.cachedInputTokens !== undefined) {
    tokenCount(usage.cachedInputTokens, "cachedInputTokens");
  }
  if (usage.cacheWriteInputTokens !== undefined) {
    tokenCount(usage.cacheWriteInputTokens, "cacheWriteInputTokens");
  }
  if (
    usage.source !== "provider" &&
    usage.source !== "estimated" &&
    usage.source !== "mixed"
  ) {
    throw new SessionInvalidTranscriptError("Unknown Session summary usage source");
  }
  return Object.freeze({ ...usage });
}

function snapshotProvenance(
  provenance: SessionCheckpointProvenance,
): SessionCheckpointProvenance {
  if (!isPlainRecord(provenance)) {
    throw new SessionInvalidTranscriptError(
      "Session checkpoint provenance must be a plain record",
    );
  }
  return cloneSerializable(provenance, new Set()) as SessionCheckpointProvenance;
}

function cloneSerializable(value: unknown, seen: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SessionInvalidTranscriptError(
        "Session checkpoint provenance numbers must be finite",
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new SessionInvalidTranscriptError(
      "Session checkpoint provenance must be JSON-compatible",
    );
  }
  if (seen.has(value)) {
    throw new SessionInvalidTranscriptError(
      "Session checkpoint provenance must not contain cycles",
    );
  }
  seen.add(value);
  const cloned = Array.isArray(value)
    ? Object.freeze(value.map((entry) => cloneSerializable(entry, seen)))
    : isPlainRecord(value)
      ? Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [
          key,
          cloneSerializable(entry, seen),
        ])))
      : (() => {
          throw new SessionInvalidTranscriptError(
            "Session checkpoint provenance must contain only plain values",
          );
        })();
  seen.delete(value);
  return cloned;
}

function sameMessageDraft(
  record: SessionMessageRecord,
  draft: SessionMessageDraft,
): boolean {
  return JSON.stringify({
    runId: record.runId,
    userTurnId: record.userTurnId,
    stepId: record.stepId,
    origin: record.origin,
    message: record.message,
    ...(record.toolResultArchive === undefined
      ? {}
      : { toolResultArchive: record.toolResultArchive }),
  }) === JSON.stringify({
    runId: draft.runId,
    userTurnId: draft.userTurnId,
    stepId: draft.stepId,
    origin: draft.origin,
    message: draft.message,
    ...(draft.toolResultArchive === undefined
      ? {}
      : { toolResultArchive: draft.toolResultArchive }),
  });
}

function sameCheckpointDraft(
  record: SessionCheckpointRecord,
  draft: SessionCheckpointDraft,
): boolean {
  return JSON.stringify({
    coveredThroughSequence: record.coveredThroughSequence,
    sourceSequences: record.sourceSequences,
    reason: record.reason,
    message: record.message,
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    ...(record.summaryUsage === undefined
      ? {}
      : { summaryUsage: record.summaryUsage }),
  }) === JSON.stringify({
    coveredThroughSequence: draft.coveredThroughSequence,
    sourceSequences: draft.sourceSequences,
    reason: draft.reason,
    message: draft.message,
    ...(draft.provenance === undefined ? {} : { provenance: draft.provenance }),
    ...(draft.summaryUsage === undefined ? {} : { summaryUsage: draft.summaryUsage }),
  });
}

function snapshotPositiveSequences(
  value: readonly number[],
  label: string,
  sessionId: SessionId,
): readonly number[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`, sessionId);
  const sequences = value.map((sequence) =>
    positiveSafeInteger(sequence, label, sessionId)
  );
  const unique = new Set(sequences);
  if (unique.size !== sequences.length) {
    throw invalid(`${label} must not contain duplicates`, sessionId);
  }
  for (let index = 1; index < sequences.length; index += 1) {
    if ((sequences[index - 1] ?? 0) >= (sequences[index] ?? 0)) {
      throw invalid(`${label} must be strictly increasing`, sessionId);
    }
  }
  return Object.freeze(sequences);
}

function requireOrigin(value: SessionMessageOrigin): SessionMessageOrigin {
  if (
    value !== "user_input" &&
    value !== "steering" &&
    value !== "assistant" &&
    value !== "tool" &&
    value !== "imported"
  ) {
    throw new SessionInvalidTranscriptError("Unknown Session message origin");
  }
  return value;
}

function requireStatus(value: SessionStatus): SessionStatus {
  if (value !== "active" && value !== "archived") {
    throw new SessionInvalidTranscriptError("Unknown Session status");
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new SessionInvalidTranscriptError(
      `${label} must be a non-empty trimmed string`,
    );
  }
  return value;
}

function requireTitle(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SessionInvalidTranscriptError("Session title must be non-empty");
  }
  return value;
}

function requireTimestamp(value: string, label: string): string {
  return requireIdentifier(value, label);
}

function positiveSafeInteger(
  value: number,
  label: string,
  sessionId?: SessionId,
): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${label} must be a positive safe integer`, sessionId);
  }
  return value;
}

function tokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionInvalidTranscriptError(
      `Session summary usage ${label} must be a non-negative safe integer`,
    );
  }
}

function invalid(message: string, sessionId?: SessionId): SessionInvalidTranscriptError {
  return new SessionInvalidTranscriptError(message, sessionId);
}

function sessionIdFromUnknown(value: unknown): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "sessionId" in value &&
    typeof value.sessionId === "string"
  ) {
    return value.sessionId;
  }
  return "unknown";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
