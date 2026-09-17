import { randomUUID } from "node:crypto";
import {
  allocateCheckpointRecord,
  allocateMessageRecords,
  archiveSessionSnapshot,
  assertExpectedRevision,
  createSessionDescriptor,
  findCheckpointReplay,
  findMessageReplay,
  normalizeAppendSessionCheckpointInput,
  normalizeAppendSessionMessagesInput,
  normalizeArchiveSessionInput,
  normalizeCreateSessionInput,
  normalizeGetSessionInput,
  normalizeListSessionsInput,
  normalizeReadSessionHistoryInput,
  normalizeUpdateSessionMetadataInput,
  snapshotHistory,
  snapshotHistoryRecords,
  snapshotSession,
  updateSessionMetadataSnapshot,
} from "./transcript.js";
import {
  SessionAlreadyExistsError,
  SessionArchivedError,
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
  type SessionHistoryRecord,
  type SessionStore,
  type UpdateSessionMetadataInput,
} from "./types.js";

interface MutableMemorySession {
  session: Session;
  records: readonly SessionHistoryRecord[];
}

export interface InMemorySessionStoreOptions {
  readonly now?: () => Date | string;
  readonly recordId?: () => string;
  readonly revision?: () => string;
}

/** Deterministic-friendly fake Store with the same transaction rules as files. */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, MutableMemorySession>();
  private readonly deleted = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly now: () => Date | string;
  private readonly recordId: () => string;
  private readonly revision: () => string;

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.recordId = options.recordId ?? (() => randomUUID());
    this.revision = options.revision ?? (() => randomUUID());
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const normalized = normalizeCreateSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      if (this.sessions.has(normalized.sessionId) || this.deleted.has(normalized.sessionId)) {
        throw new SessionAlreadyExistsError(normalized.sessionId);
      }
      const session = createSessionDescriptor({
        create: normalized,
        createdAt: this.timestamp(),
        historyRevision: this.newRevision(),
      });
      this.sessions.set(normalized.sessionId, {
        session,
        records: Object.freeze([]),
      });
      return snapshotSession(session);
    });
  }

  async get(input: GetSessionInput): Promise<Session | undefined> {
    const normalized = normalizeGetSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = this.sessions.get(normalized.sessionId);
      return state === undefined ? undefined : snapshotSession(state.session);
    });
  }

  async list(input?: ListSessionsInput): Promise<readonly Session[]> {
    const normalized = normalizeListSessionsInput(input);
    throwIfAborted(normalized.signal);
    await Promise.all([...this.tails.values()]);
    throwIfAborted(normalized.signal);
    const sessions = [...this.sessions.values()]
      .map((state) => snapshotSession(state.session))
      .filter((session) =>
        (normalized.agentId === undefined || session.agentId === normalized.agentId) &&
        (normalized.status === undefined || session.status === normalized.status)
      )
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.sessionId.localeCompare(right.sessionId)
      );
    return Object.freeze(sessions);
  }

  async updateMetadata(input: UpdateSessionMetadataInput): Promise<Session> {
    const normalized = normalizeUpdateSessionMetadataInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = this.requireState(normalized.sessionId);
      state.session = updateSessionMetadataSnapshot({
        session: state.session,
        title: normalized.title,
        updatedAt: this.timestamp(),
      });
      return snapshotSession(state.session);
    });
  }

  async archive(input: ArchiveSessionInput): Promise<Session> {
    const normalized = normalizeArchiveSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = this.requireState(normalized.sessionId);
      state.session = archiveSessionSnapshot({
        session: state.session,
        updatedAt: this.timestamp(),
      });
      return snapshotSession(state.session);
    });
  }

  async restore(input: RestoreSessionInput): Promise<Session> {
    const normalized = normalizeGetSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = this.requireState(normalized.sessionId);
      if (state.session.status !== "active") state.session = snapshotSession({ ...state.session, status: "active", updatedAt: this.timestamp() });
      return snapshotSession(state.session);
    });
  }

  async delete(input: DeleteSessionInput): Promise<void> {
    const normalized = normalizeGetSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      if (this.deleted.has(normalized.sessionId)) return;
      this.requireState(normalized.sessionId);
      this.deleted.add(normalized.sessionId);
      this.sessions.delete(normalized.sessionId);
    });
  }

  async wasDeleted(input: GetSessionInput): Promise<boolean> {
    const normalized = normalizeGetSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      return this.deleted.has(normalized.sessionId);
    });
  }

  async readHistory(
    input: ReadSessionHistoryInput,
  ): Promise<ReturnType<typeof snapshotHistory>> {
    const normalized = normalizeReadSessionHistoryInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = this.requireState(normalized.sessionId);
      return snapshotHistory({
        sessionId: state.session.sessionId,
        historyRevision: state.session.historyRevision,
        records: state.records,
      });
    });
  }

  async appendMessages(
    input: AppendSessionMessagesInput,
  ): Promise<AppendSessionMessagesResult> {
    const normalized = normalizeAppendSessionMessagesInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = this.requireActiveState(normalized.sessionId);
      const existing = findMessageReplay(
        normalized.sessionId,
        state.records,
        normalized.messages,
      );
      if (existing !== undefined) {
        return Object.freeze({
          records: existing,
          historyRevision: state.session.historyRevision,
          replayed: true,
        });
      }
      assertExpectedRevision({
        sessionId: normalized.sessionId,
        expectedRevision: normalized.expectedRevision,
        actualRevision: state.session.historyRevision,
      });
      const appended = allocateMessageRecords({
        sessionId: normalized.sessionId,
        records: state.records,
        drafts: normalized.messages,
        allocation: {
          recordId: this.recordId,
          createdAt: () => this.timestamp(),
        },
      });
      this.commitHistory(state, [...state.records, ...appended]);
      return Object.freeze({
        records: appended,
        historyRevision: state.session.historyRevision,
        replayed: false,
      });
    });
  }

  async appendCheckpoint(
    input: AppendSessionCheckpointInput,
  ): Promise<AppendSessionCheckpointResult> {
    const normalized = normalizeAppendSessionCheckpointInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = this.requireActiveState(normalized.sessionId);
      const existing = findCheckpointReplay(
        normalized.sessionId,
        state.records,
        normalized.checkpoint,
      );
      if (existing !== undefined) {
        return Object.freeze({
          record: existing,
          historyRevision: state.session.historyRevision,
          replayed: true,
        });
      }
      assertExpectedRevision({
        sessionId: normalized.sessionId,
        expectedRevision: normalized.expectedRevision,
        actualRevision: state.session.historyRevision,
      });
      const record = allocateCheckpointRecord({
        sessionId: normalized.sessionId,
        records: state.records,
        draft: normalized.checkpoint,
        allocation: {
          recordId: this.recordId,
          createdAt: () => this.timestamp(),
        },
      });
      this.commitHistory(state, [...state.records, record]);
      return Object.freeze({
        record,
        historyRevision: state.session.historyRevision,
        replayed: false,
      });
    });
  }

  private commitHistory(
    state: MutableMemorySession,
    records: readonly SessionHistoryRecord[],
  ): void {
    const historyRevision = this.newRevision(state.session.historyRevision);
    state.records = snapshotHistoryRecords(records, state.session.sessionId);
    state.session = snapshotSession({
      ...state.session,
      updatedAt: this.timestamp(),
      historyRevision,
    });
  }

  private requireState(sessionId: string): MutableMemorySession {
    const state = this.sessions.get(sessionId);
    if (state === undefined) throw new SessionNotFoundError(sessionId);
    return state;
  }

  private requireActiveState(sessionId: string): MutableMemorySession {
    const state = this.requireState(sessionId);
    if (state.session.status !== "active") {
      throw new SessionArchivedError(sessionId);
    }
    return state;
  }

  private timestamp(): string {
    const value = this.now();
    const timestamp = value instanceof Date ? value.toISOString() : value;
    if (typeof timestamp !== "string" || timestamp.trim().length === 0) {
      throw new Error("InMemorySessionStore clock returned an invalid timestamp");
    }
    return timestamp;
  }

  private newRevision(previous?: string): string {
    const revision = this.revision();
    if (
      typeof revision !== "string" ||
      revision.length === 0 ||
      revision !== revision.trim() ||
      revision === previous
    ) {
      throw new Error("InMemorySessionStore revision generator returned an invalid revision");
    }
    return revision;
  }

  private serial<Value>(sessionId: string, operation: () => Promise<Value>): Promise<Value> {
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    return result.finally(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Session operation was aborted", { cause: signal.reason });
}
