import type {
  AgentId,
  AgentRunId,
  UserTurnId,
} from "../core/agent/agent.js";
import type {
  ModelMessage,
  ModelUsage,
} from "../core/model/model.js";
import type { AgentStepId } from "../core/runtime/runtime.js";

export type SessionId = string;
export type SessionHistoryRevision = string;
export type SessionStatus = "active" | "archived";

/** Durable identity and display metadata for one conversation. */
export interface Session {
  readonly schemaVersion: 1;
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly scope: string;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Opaque optimistic-concurrency token for transcript changes only. */
  readonly historyRevision: SessionHistoryRevision;
  readonly title?: string;
}

export type SessionMessageOrigin =
  | "user_input"
  | "steering"
  | "assistant"
  | "tool"
  | "imported";

/** Receipt for a complete Tool Result archived outside the transcript. */
export interface SessionToolResultArchiveReceipt {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly locator: string;
  readonly hash: string;
}

export interface SessionMessageRecord {
  readonly schemaVersion: 1;
  readonly kind: "message";
  readonly recordId: string;
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly runId: AgentRunId;
  readonly userTurnId: UserTurnId;
  readonly stepId: AgentStepId;
  readonly origin: SessionMessageOrigin;
  readonly createdAt: string;
  readonly message: ModelMessage;
  /** Structural metadata; never part of the model-visible message body. */
  readonly toolResultArchive?: SessionToolResultArchiveReceipt;
}

export type SessionCheckpointProvenance = Readonly<Record<string, unknown>>;

export interface SessionCheckpointRecord {
  readonly schemaVersion: 1;
  readonly kind: "checkpoint";
  readonly recordId: string;
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly coveredThroughSequence: number;
  readonly sourceSequences: readonly number[];
  readonly reason: string;
  readonly message: ModelMessage & { readonly role: "assistant" };
  readonly provenance?: SessionCheckpointProvenance;
  readonly summaryUsage?: ModelUsage;
}

export type SessionHistoryRecord =
  | SessionMessageRecord
  | SessionCheckpointRecord;

/** Immutable, storage-neutral transcript view. */
export interface SessionHistorySnapshot {
  readonly sessionId: SessionId;
  readonly historyRevision: SessionHistoryRevision;
  readonly records: readonly SessionHistoryRecord[];
}

export interface CreateSessionInput {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly scope: string;
  readonly title?: string;
  readonly signal?: AbortSignal;
}

export interface GetSessionInput {
  readonly sessionId: SessionId;
  readonly signal?: AbortSignal;
}

export interface ListSessionsInput {
  readonly agentId?: AgentId;
  readonly status?: SessionStatus;
  readonly signal?: AbortSignal;
}

export interface UpdateSessionMetadataInput {
  readonly sessionId: SessionId;
  /** `null` clears the stored title; `undefined` leaves it unchanged. */
  readonly title?: string | null;
  readonly signal?: AbortSignal;
}

export interface ArchiveSessionInput {
  readonly sessionId: SessionId;
  readonly signal?: AbortSignal;
}

export interface ReadSessionHistoryInput {
  readonly sessionId: SessionId;
  readonly signal?: AbortSignal;
}

/** Unsequenced message submitted to one atomic append transaction. */
export interface SessionMessageDraft {
  readonly idempotencyKey: string;
  readonly runId: AgentRunId;
  readonly userTurnId: UserTurnId;
  readonly stepId: AgentStepId;
  readonly origin: SessionMessageOrigin;
  readonly message: ModelMessage;
  readonly toolResultArchive?: SessionToolResultArchiveReceipt;
}

export interface AppendSessionMessagesInput {
  readonly sessionId: SessionId;
  readonly messages: readonly SessionMessageDraft[];
  /** Optional CAS guard. Idempotent replay is recognized before this check. */
  readonly expectedRevision?: SessionHistoryRevision;
  readonly signal?: AbortSignal;
}

export interface AppendSessionMessagesResult {
  readonly records: readonly SessionMessageRecord[];
  readonly historyRevision: SessionHistoryRevision;
  readonly replayed: boolean;
}

export interface SessionCheckpointDraft {
  readonly idempotencyKey: string;
  readonly coveredThroughSequence: number;
  readonly sourceSequences: readonly number[];
  readonly reason: string;
  readonly message: ModelMessage & { readonly role: "assistant" };
  readonly provenance?: SessionCheckpointProvenance;
  readonly summaryUsage?: ModelUsage;
}

export interface AppendSessionCheckpointInput {
  readonly sessionId: SessionId;
  /** Mandatory CAS guard for compaction planning and commit. */
  readonly expectedRevision: SessionHistoryRevision;
  readonly checkpoint: SessionCheckpointDraft;
  readonly signal?: AbortSignal;
}

export interface AppendSessionCheckpointResult {
  readonly record: SessionCheckpointRecord;
  readonly historyRevision: SessionHistoryRevision;
  readonly replayed: boolean;
}

/** Storage Port. Implementations own atomicity, locking and durable layout. */
export interface SessionStore {
  create(input: CreateSessionInput): Promise<Session>;
  get(input: GetSessionInput): Promise<Session | undefined>;
  list(input?: ListSessionsInput): Promise<readonly Session[]>;
  updateMetadata(input: UpdateSessionMetadataInput): Promise<Session>;
  archive(input: ArchiveSessionInput): Promise<Session>;
  readHistory(input: ReadSessionHistoryInput): Promise<SessionHistorySnapshot>;
  appendMessages(
    input: AppendSessionMessagesInput,
  ): Promise<AppendSessionMessagesResult>;
  appendCheckpoint(
    input: AppendSessionCheckpointInput,
  ): Promise<AppendSessionCheckpointResult>;
}

export type SessionErrorCode =
  | "session_not_found"
  | "session_already_exists"
  | "session_archived"
  | "session_revision_conflict"
  | "session_idempotency_conflict"
  | "session_corruption"
  | "session_invalid_transcript";

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    readonly sessionId?: SessionId,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionError";
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: SessionId) {
    super("session_not_found", `Unknown Session: ${sessionId}`, sessionId);
    this.name = "SessionNotFoundError";
  }
}

export class SessionAlreadyExistsError extends SessionError {
  constructor(sessionId: SessionId) {
    super(
      "session_already_exists",
      `Session already exists: ${sessionId}`,
      sessionId,
    );
    this.name = "SessionAlreadyExistsError";
  }
}

export class SessionArchivedError extends SessionError {
  constructor(sessionId: SessionId) {
    super("session_archived", `Session is archived: ${sessionId}`, sessionId);
    this.name = "SessionArchivedError";
  }
}

export class SessionRevisionConflictError extends SessionError {
  constructor(
    sessionId: SessionId,
    readonly expectedRevision: SessionHistoryRevision,
    readonly actualRevision: SessionHistoryRevision,
  ) {
    super(
      "session_revision_conflict",
      `Session history revision conflict for ${sessionId}`,
      sessionId,
    );
    this.name = "SessionRevisionConflictError";
  }
}

export class SessionIdempotencyConflictError extends SessionError {
  constructor(sessionId: SessionId, readonly idempotencyKey: string) {
    super(
      "session_idempotency_conflict",
      `Session idempotency key was reused with different content: ${idempotencyKey}`,
      sessionId,
    );
    this.name = "SessionIdempotencyConflictError";
  }
}

export class SessionCorruptionError extends SessionError {
  constructor(sessionId: SessionId, message: string, options?: ErrorOptions) {
    super("session_corruption", message, sessionId, options);
    this.name = "SessionCorruptionError";
  }
}

export class SessionInvalidTranscriptError extends SessionError {
  constructor(message: string, sessionId?: SessionId, options?: ErrorOptions) {
    super("session_invalid_transcript", message, sessionId, options);
    this.name = "SessionInvalidTranscriptError";
  }
}
