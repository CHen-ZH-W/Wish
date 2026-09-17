import {
  normalizeAppendSessionCheckpointInput,
  normalizeAppendSessionMessagesInput,
  normalizeArchiveSessionInput,
  normalizeCreateSessionInput,
  normalizeGetSessionInput,
  normalizeListSessionsInput,
  normalizeReadSessionHistoryInput,
  normalizeUpdateSessionMetadataInput,
  snapshotHistory,
  snapshotSession,
  snapshotSessionCheckpointRecord,
  snapshotSessionMessageRecord,
} from "./transcript.js";
import {
  SessionNotFoundError,
  type AppendSessionCheckpointInput,
  type AppendSessionCheckpointResult,
  type AppendSessionMessagesInput,
  type AppendSessionMessagesResult,
  type ArchiveSessionInput,
  type RestoreSessionInput,
  type DeleteSessionInput,
  type CreateSessionInput,
  type GetSessionInput,
  type ListSessionsInput,
  type ReadSessionHistoryInput,
  type Session,
  type SessionHistorySnapshot,
  type SessionStore,
  type UpdateSessionMetadataInput,
} from "./types.js";

/** Public Session facade; concrete persistence stays behind SessionStore. */
export class SessionManager {
  constructor(readonly store: SessionStore) {
    if (store === null || typeof store !== "object") {
      throw new Error("SessionManager requires a SessionStore");
    }
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const normalized = normalizeCreateSessionInput(input);
    const session = snapshotSession(await this.store.create(normalized));
    assertSessionIdentity(session, normalized.sessionId);
    return session;
  }

  async get(input: GetSessionInput): Promise<Session> {
    const normalized = normalizeGetSessionInput(input);
    const stored = await this.store.get(normalized);
    if (stored === undefined) {
      throw new SessionNotFoundError(normalized.sessionId);
    }
    const session = snapshotSession(stored);
    assertSessionIdentity(session, normalized.sessionId);
    return session;
  }

  async list(input?: ListSessionsInput): Promise<readonly Session[]> {
    const normalized = normalizeListSessionsInput(input);
    const sessions = await this.store.list(normalized);
    if (!Array.isArray(sessions)) {
      throw new Error("SessionStore.list must return an array");
    }
    return Object.freeze(sessions.map(snapshotSession));
  }

  async updateMetadata(input: UpdateSessionMetadataInput): Promise<Session> {
    const normalized = normalizeUpdateSessionMetadataInput(input);
    const session = snapshotSession(
      await this.store.updateMetadata(normalized),
    );
    assertSessionIdentity(session, normalized.sessionId);
    return session;
  }

  async archive(input: ArchiveSessionInput): Promise<Session> {
    const normalized = normalizeArchiveSessionInput(input);
    const session = snapshotSession(await this.store.archive(normalized));
    assertSessionIdentity(session, normalized.sessionId);
    return session;
  }

  async restore(input: RestoreSessionInput): Promise<Session> {
    const normalized = normalizeGetSessionInput(input);
    const session = snapshotSession(await this.store.restore(normalized));
    assertSessionIdentity(session, normalized.sessionId);
    return session;
  }

  delete(input: DeleteSessionInput): Promise<void> {
    return this.store.delete(normalizeGetSessionInput(input));
  }

  async wasDeleted(input: GetSessionInput): Promise<boolean> {
    const deleted = await this.store.wasDeleted(normalizeGetSessionInput(input));
    if (typeof deleted !== "boolean") {
      throw new Error("SessionStore.wasDeleted must return a boolean");
    }
    return deleted;
  }

  async readHistory(
    input: ReadSessionHistoryInput,
  ): Promise<SessionHistorySnapshot> {
    const normalized = normalizeReadSessionHistoryInput(input);
    const snapshot = snapshotHistory(await this.store.readHistory(normalized));
    if (snapshot.sessionId !== normalized.sessionId) {
      throw new Error("SessionStore returned history for the wrong Session");
    }
    return snapshot;
  }

  async appendMessages(
    input: AppendSessionMessagesInput,
  ): Promise<AppendSessionMessagesResult> {
    const normalized = normalizeAppendSessionMessagesInput(input);
    const result = await this.store.appendMessages(normalized);
    if (result === null || typeof result !== "object") {
      throw new Error("SessionStore.appendMessages must return a result");
    }
    const records = Object.freeze(result.records.map((record) =>
      snapshotSessionMessageRecord(record, normalized.sessionId)
    ));
    if (records.length !== normalized.messages.length) {
      throw new Error("SessionStore changed the Session message batch size");
    }
    return Object.freeze({
      records,
      historyRevision: requireRevision(result.historyRevision),
      replayed: result.replayed === true,
    });
  }

  async appendCheckpoint(
    input: AppendSessionCheckpointInput,
  ): Promise<AppendSessionCheckpointResult> {
    const normalized = normalizeAppendSessionCheckpointInput(input);
    const result = await this.store.appendCheckpoint(normalized);
    if (result === null || typeof result !== "object") {
      throw new Error("SessionStore.appendCheckpoint must return a result");
    }
    return Object.freeze({
      record: snapshotSessionCheckpointRecord(
        result.record,
        normalized.sessionId,
      ),
      historyRevision: requireRevision(result.historyRevision),
      replayed: result.replayed === true,
    });
  }
}

function assertSessionIdentity(session: Session, expected: string): void {
  if (session.sessionId !== expected) {
    throw new Error("SessionStore returned the wrong Session identity");
  }
}

function requireRevision(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("SessionStore returned an invalid history revision");
  }
  return value;
}
