import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
} from "../../transcript.js";
import {
  SessionAlreadyExistsError,
  SessionArchivedError,
  SessionCorruptionError,
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
  type SessionHistorySnapshot,
  type SessionStore,
  type UpdateSessionMetadataInput,
} from "../../types.js";

const SESSION_FILE = "session.json";
const HISTORY_FILE = "history.jsonl";

interface StoredSessionDocument {
  readonly schemaVersion: 1;
  readonly historyBaseRevision: string;
  readonly session: Session;
}

interface StoredHistoryTransaction {
  readonly schemaVersion: 1;
  readonly type: "history_transaction";
  readonly previousRevision: string;
  readonly historyRevision: string;
  readonly committedAt: string;
  readonly records: readonly SessionHistoryRecord[];
}

interface LoadedHistory {
  readonly records: readonly SessionHistoryRecord[];
  readonly historyRevision: string;
  readonly updatedAt: string;
}

interface LoadedSessionState {
  readonly directory: string;
  readonly document: StoredSessionDocument;
  readonly records: readonly SessionHistoryRecord[];
}

export interface FileSessionStoreWarning {
  readonly code:
    | "truncated_history_tail_ignored"
    | "history_tail_newline_repaired"
    | "session_revision_repaired";
  readonly sessionId: string;
  readonly path: string;
  readonly message: string;
}

export interface FileSessionStoreOptions {
  readonly rootDirectory: string;
  readonly now?: () => Date | string;
  readonly recordId?: () => string;
  readonly revision?: () => string;
  readonly temporaryId?: () => string;
  readonly onWarning?: (warning: FileSessionStoreWarning) => void;
}

/**
 * JSONL Session Store with process-local per-Session serialization.
 * Cross-process writers require a different Store or an external lock.
 */
export class FileSessionStore implements SessionStore {
  readonly rootDirectory: string;
  private readonly now: () => Date | string;
  private readonly recordId: () => string;
  private readonly revision: () => string;
  private readonly temporaryId: () => string;
  private readonly onWarning: (warning: FileSessionStoreWarning) => void;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<Promise<unknown>>();
  private state: "open" | "closing" | "closed" = "open";

  constructor(options: FileSessionStoreOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.trim().length === 0
    ) {
      throw new Error("FileSessionStore requires a rootDirectory");
    }
    this.rootDirectory = resolve(options.rootDirectory);
    this.now = options.now ?? (() => new Date());
    this.recordId = options.recordId ?? (() => randomUUID());
    this.revision = options.revision ?? (() => randomUUID());
    this.temporaryId = options.temporaryId ?? (() => randomUUID());
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const normalized = normalizeCreateSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      await this.ensureRootDirectory();
      const directory = this.sessionDirectory(normalized.sessionId);
      if (await pathExists(directory) || await pathExists(this.deletedDirectory(normalized.sessionId))) {
        throw new SessionAlreadyExistsError(normalized.sessionId);
      }

      const baseRevision = this.newRevision();
      const session = createSessionDescriptor({
        create: normalized,
        createdAt: this.timestamp(),
        historyRevision: baseRevision,
      });
      const document: StoredSessionDocument = Object.freeze({
        schemaVersion: 1 as const,
        historyBaseRevision: baseRevision,
        session,
      });
      const temporaryDirectory = join(
        this.rootDirectory,
        `.tmp-${sessionStorageKey(normalized.sessionId)}-${this.safeTemporaryId()}`,
      );
      let temporaryExists = false;
      try {
        await mkdir(temporaryDirectory, { mode: 0o700 });
        temporaryExists = true;
        await this.writeSessionDocumentAtomic(temporaryDirectory, document);
        await createEmptyDurableFile(join(temporaryDirectory, HISTORY_FILE));
        await syncDirectory(temporaryDirectory);
        try {
          await rename(temporaryDirectory, directory);
        } catch (error: unknown) {
          if (isFileError(error, "EEXIST") || isFileError(error, "ENOTEMPTY")) {
            throw new SessionAlreadyExistsError(normalized.sessionId);
          }
          throw error;
        }
        temporaryExists = false;
        await syncDirectory(this.rootDirectory);
        return snapshotSession(session);
      } finally {
        if (temporaryExists) {
          try {
            await rm(temporaryDirectory, { recursive: true, force: true });
          } catch {
            // Preserve the authoritative create failure.
          }
        }
      }
    });
  }

  async get(input: GetSessionInput): Promise<Session | undefined> {
    const normalized = normalizeGetSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      if (!await pathExists(this.sessionDirectory(normalized.sessionId))) {
        return undefined;
      }
      return snapshotSession((await this.loadState(normalized.sessionId)).document.session);
    });
  }

  list(input?: ListSessionsInput): Promise<readonly Session[]> {
    this.assertOpen();
    return this.track(this.listOpen(input));
  }

  private async listOpen(
    input?: ListSessionsInput,
  ): Promise<readonly Session[]> {
    const normalized = normalizeListSessionsInput(input);
    throwIfAborted(normalized.signal);
    let entries;
    try {
      entries = await readdir(this.rootDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isFileError(error, "ENOENT")) return Object.freeze([]);
      throw error;
    }
    const sessions: Session[] = [];
    for (const entry of entries) {
      throwIfAborted(normalized.signal);
      if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
      const directory = join(this.rootDirectory, entry.name);
      let document: StoredSessionDocument;
      try { document = await this.readSessionDocument(directory, "unknown"); }
      catch (error) { if (!await pathExists(directory)) continue; throw error; }
      const sessionId = document.session.sessionId;
      if (this.sessionDirectory(sessionId) !== directory) {
        throw new SessionCorruptionError(
          sessionId,
          "Session directory key does not match session.json identity",
        );
      }
      const session = await this.serial(sessionId, async () => {
        if (!await pathExists(directory)) return undefined;
        return (await this.loadState(sessionId)).document.session;
      }, true);
      if (!session) continue;
      if (
        (normalized.agentId === undefined || session.agentId === normalized.agentId) &&
        (normalized.status === undefined || session.status === normalized.status)
      ) {
        sessions.push(snapshotSession(session));
      }
    }
    sessions.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.sessionId.localeCompare(right.sessionId)
    );
    return Object.freeze(sessions);
  }

  /** Stop admitting work and drain operations accepted before close(). */
  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "open") this.state = "closing";
    await Promise.allSettled([...this.tails.values(), ...this.active]);
    this.state = "closed";
  }

  async updateMetadata(input: UpdateSessionMetadataInput): Promise<Session> {
    const normalized = normalizeUpdateSessionMetadataInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = await this.loadState(normalized.sessionId);
      const session = updateSessionMetadataSnapshot({
        session: state.document.session,
        title: normalized.title,
        updatedAt: this.timestamp(),
      });
      if (session !== state.document.session) {
        await this.writeSessionDocumentAtomic(state.directory, {
          ...state.document,
          session,
        });
      }
      return snapshotSession(session);
    });
  }

  async archive(input: ArchiveSessionInput): Promise<Session> {
    const normalized = normalizeArchiveSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = await this.loadState(normalized.sessionId);
      const session = archiveSessionSnapshot({
        session: state.document.session,
        updatedAt: this.timestamp(),
      });
      if (session !== state.document.session) {
        await this.writeSessionDocumentAtomic(state.directory, {
          ...state.document,
          session,
        });
      }
      return snapshotSession(session);
    });
  }

  async restore(input: RestoreSessionInput): Promise<Session> {
    const normalized = normalizeGetSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = await this.loadState(normalized.sessionId);
      const session = state.document.session.status === "active" ? state.document.session
        : snapshotSession({ ...state.document.session, status: "active", updatedAt: this.timestamp() });
      if (session !== state.document.session) await this.writeSessionDocumentAtomic(state.directory, { ...state.document, session });
      return snapshotSession(session);
    });
  }

  async delete(input: DeleteSessionInput): Promise<void> {
    const normalized = normalizeGetSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const tombstone = this.deletedDirectory(normalized.sessionId);
      if (!await pathExists(tombstone)) {
        const state = await this.loadState(normalized.sessionId);
        await rename(state.directory, tombstone);
        await syncDirectory(this.rootDirectory);
      }
      // Hide atomically before purging. Keep the empty directory to reserve the ID,
      // since other domains can retain records referencing this Session.
      for (const entry of await readdir(tombstone)) {
        await rm(join(tombstone, entry), { recursive: true, force: true });
      }
      await syncDirectory(tombstone);
    });
  }

  async wasDeleted(input: GetSessionInput): Promise<boolean> {
    const normalized = normalizeGetSessionInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      return pathExists(this.deletedDirectory(normalized.sessionId));
    });
  }

  async readHistory(input: ReadSessionHistoryInput): Promise<SessionHistorySnapshot> {
    const normalized = normalizeReadSessionHistoryInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = await this.loadState(normalized.sessionId);
      return snapshotHistory({
        sessionId: normalized.sessionId,
        historyRevision: state.document.session.historyRevision,
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
      const state = await this.loadActiveState(normalized.sessionId);
      const replay = findMessageReplay(
        normalized.sessionId,
        state.records,
        normalized.messages,
      );
      if (replay !== undefined) {
        return Object.freeze({
          records: replay,
          historyRevision: state.document.session.historyRevision,
          replayed: true,
        });
      }
      assertExpectedRevision({
        sessionId: normalized.sessionId,
        expectedRevision: normalized.expectedRevision,
        actualRevision: state.document.session.historyRevision,
      });
      const committedAt = this.timestamp();
      const records = allocateMessageRecords({
        sessionId: normalized.sessionId,
        records: state.records,
        drafts: normalized.messages,
        allocation: {
          recordId: this.recordId,
          createdAt: () => committedAt,
        },
      });
      snapshotHistoryRecords([...state.records, ...records], normalized.sessionId);
      const historyRevision = this.newRevision(
        state.document.session.historyRevision,
      );
      await this.commitTransaction(state, {
        schemaVersion: 1,
        type: "history_transaction",
        previousRevision: state.document.session.historyRevision,
        historyRevision,
        committedAt,
        records,
      });
      return Object.freeze({ records, historyRevision, replayed: false });
    });
  }

  async appendCheckpoint(
    input: AppendSessionCheckpointInput,
  ): Promise<AppendSessionCheckpointResult> {
    const normalized = normalizeAppendSessionCheckpointInput(input);
    return this.serial(normalized.sessionId, async () => {
      throwIfAborted(normalized.signal);
      const state = await this.loadActiveState(normalized.sessionId);
      const replay = findCheckpointReplay(
        normalized.sessionId,
        state.records,
        normalized.checkpoint,
      );
      if (replay !== undefined) {
        return Object.freeze({
          record: replay,
          historyRevision: state.document.session.historyRevision,
          replayed: true,
        });
      }
      assertExpectedRevision({
        sessionId: normalized.sessionId,
        expectedRevision: normalized.expectedRevision,
        actualRevision: state.document.session.historyRevision,
      });
      const committedAt = this.timestamp();
      const record = allocateCheckpointRecord({
        sessionId: normalized.sessionId,
        records: state.records,
        draft: normalized.checkpoint,
        allocation: {
          recordId: this.recordId,
          createdAt: () => committedAt,
        },
      });
      snapshotHistoryRecords([...state.records, record], normalized.sessionId);
      const historyRevision = this.newRevision(
        state.document.session.historyRevision,
      );
      await this.commitTransaction(state, {
        schemaVersion: 1,
        type: "history_transaction",
        previousRevision: state.document.session.historyRevision,
        historyRevision,
        committedAt,
        records: Object.freeze([record]),
      });
      return Object.freeze({ record, historyRevision, replayed: false });
    });
  }

  private async loadActiveState(sessionId: string): Promise<LoadedSessionState> {
    const state = await this.loadState(sessionId);
    if (state.document.session.status !== "active") {
      throw new SessionArchivedError(sessionId);
    }
    return state;
  }

  private async loadState(sessionId: string): Promise<LoadedSessionState> {
    const directory = this.sessionDirectory(sessionId);
    if (!await pathExists(directory)) throw new SessionNotFoundError(sessionId);
    let document = await this.readSessionDocument(directory, sessionId);
    if (document.session.sessionId !== sessionId) {
      throw new SessionCorruptionError(
        sessionId,
        "session.json identity does not match its storage key",
      );
    }
    const history = await this.readHistoryFile(directory, document, sessionId);
    if (document.session.historyRevision !== history.historyRevision) {
      document = Object.freeze({
        ...document,
        session: snapshotSession({
          ...document.session,
          historyRevision: history.historyRevision,
          updatedAt: history.updatedAt,
        }),
      });
      await this.writeSessionDocumentAtomic(directory, document);
      this.warn({
        code: "session_revision_repaired",
        sessionId,
        path: join(directory, SESSION_FILE),
        message: "Reconciled session.json with the durable history transaction chain",
      });
    }
    return Object.freeze({
      directory,
      document,
      records: history.records,
    });
  }

  private async commitTransaction(
    state: LoadedSessionState,
    transaction: StoredHistoryTransaction,
  ): Promise<void> {
    await appendDurableLine(
      join(state.directory, HISTORY_FILE),
      JSON.stringify(transaction),
    );
    const session = snapshotSession({
      ...state.document.session,
      historyRevision: transaction.historyRevision,
      updatedAt: transaction.committedAt,
    });
    await this.writeSessionDocumentAtomic(state.directory, {
      ...state.document,
      session,
    });
  }

  private async readHistoryFile(
    directory: string,
    document: StoredSessionDocument,
    sessionId: string,
  ): Promise<LoadedHistory> {
    const path = join(directory, HISTORY_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      throw new SessionCorruptionError(
        sessionId,
        `Unable to read Session history: ${path}`,
        { cause: error },
      );
    }
    let records: readonly SessionHistoryRecord[] = Object.freeze([]);
    let historyRevision = document.historyBaseRevision;
    let updatedAt = document.session.createdAt;
    let truncatedTailRemoved = false;
    const lines = text.split("\n");
    const finalPhysicalIndex = lines.length - 1;
    for (const [index, line] of lines.entries()) {
      if (line.length === 0 && index === finalPhysicalIndex) continue;
      if (line.trim().length === 0) {
        throw new SessionCorruptionError(
          sessionId,
          `Session history contains a blank middle line at ${index + 1}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error: unknown) {
        const isTruncatedTail = index === finalPhysicalIndex && !text.endsWith("\n");
        if (isTruncatedTail) {
          const validPrefix = lines.slice(0, index).join("\n") +
            (index === 0 ? "" : "\n");
          await truncateDurableFile(path, Buffer.byteLength(validPrefix, "utf8"));
          truncatedTailRemoved = true;
          this.warn({
            code: "truncated_history_tail_ignored",
            sessionId,
            path,
            message: `Removed truncated final history line ${index + 1}`,
          });
          break;
        }
        throw new SessionCorruptionError(
          sessionId,
          `Session history contains invalid JSON at line ${index + 1}`,
          { cause: error },
        );
      }
      const transaction = parseHistoryTransaction(
        parsed,
        sessionId,
        index + 1,
      );
      if (transaction.previousRevision !== historyRevision) {
        throw new SessionCorruptionError(
          sessionId,
          `Session history revision chain breaks at line ${index + 1}`,
        );
      }
      if (transaction.historyRevision === transaction.previousRevision) {
        throw new SessionCorruptionError(
          sessionId,
          `Session history revision did not advance at line ${index + 1}`,
        );
      }
      let next: readonly SessionHistoryRecord[];
      try {
        next = snapshotHistoryRecords(
          [...records, ...transaction.records],
          sessionId,
        );
        validateCommittedTransaction(transaction.records, sessionId);
      } catch (error: unknown) {
        if (error instanceof SessionCorruptionError) throw error;
        throw new SessionCorruptionError(
          sessionId,
          `Session history transaction is invalid at line ${index + 1}`,
          { cause: error },
        );
      }
      records = next;
      historyRevision = transaction.historyRevision;
      updatedAt = transaction.committedAt;
    }
    if (!truncatedTailRemoved && text.length > 0 && !text.endsWith("\n")) {
      await appendDurableText(path, "\n");
      this.warn({
        code: "history_tail_newline_repaired",
        sessionId,
        path,
        message: "Restored the missing newline after a complete final transaction",
      });
    }
    return Object.freeze({ records, historyRevision, updatedAt });
  }

  private async readSessionDocument(
    directory: string,
    sessionId: string,
  ): Promise<StoredSessionDocument> {
    const path = join(directory, SESSION_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      throw new SessionCorruptionError(
        sessionId,
        `Unable to read Session metadata: ${path}`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new SessionCorruptionError(
        sessionId,
        `Session metadata contains invalid JSON: ${path}`,
        { cause: error },
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("schemaVersion" in parsed) ||
      parsed.schemaVersion !== 1 ||
      !("historyBaseRevision" in parsed) ||
      typeof parsed.historyBaseRevision !== "string" ||
      !("session" in parsed)
    ) {
      throw new SessionCorruptionError(
        sessionId,
        `Unknown Session metadata schema: ${path}`,
      );
    }
    let session: Session;
    try {
      session = snapshotSession(parsed.session as Session);
    } catch (error: unknown) {
      throw new SessionCorruptionError(
        sessionId,
        `Session metadata record is invalid: ${path}`,
        { cause: error },
      );
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      historyBaseRevision: requireStoredIdentifier(
        parsed.historyBaseRevision,
        sessionId,
        "historyBaseRevision",
      ),
      session,
    });
  }

  private async writeSessionDocumentAtomic(
    directory: string,
    document: StoredSessionDocument,
  ): Promise<void> {
    const path = join(directory, SESSION_FILE);
    const temporaryPath = `${path}.tmp-${this.safeTemporaryId()}`;
    let temporaryExists = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryExists = true;
      try {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, path);
      temporaryExists = false;
      await syncDirectory(directory);
    } finally {
      if (temporaryExists) {
        try {
          await unlink(temporaryPath);
        } catch {
          // Preserve the authoritative metadata write failure.
        }
      }
    }
  }

  private async ensureRootDirectory(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await syncDirectory(dirname(this.rootDirectory));
    await syncDirectory(this.rootDirectory);
  }

  private sessionDirectory(sessionId: string): string {
    return join(this.rootDirectory, `session-${sessionStorageKey(sessionId)}`);
  }

  private deletedDirectory(sessionId: string): string {
    return join(this.rootDirectory, `.deleted-session-${sessionStorageKey(sessionId)}`);
  }

  private timestamp(): string {
    const value = this.now();
    const timestamp = value instanceof Date ? value.toISOString() : value;
    if (typeof timestamp !== "string" || timestamp.trim().length === 0) {
      throw new Error("FileSessionStore clock returned an invalid timestamp");
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
      throw new Error("FileSessionStore revision generator returned an invalid revision");
    }
    return revision;
  }

  private safeTemporaryId(): string {
    return createHash("sha256").update(String(this.temporaryId())).digest("hex");
  }

  private warn(warning: FileSessionStoreWarning): void {
    try {
      this.onWarning(Object.freeze({ ...warning }));
    } catch {
      // Diagnostics cannot change transaction outcomes.
    }
  }

  private serial<Value>(
    sessionId: string,
    operation: () => Promise<Value>,
    allowClosing = false,
  ): Promise<Value> {
    if (!allowClosing) this.assertOpen();
    else if (this.state === "closed") this.assertOpen();
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    return this.track(result.finally(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }));
  }

  private track<Value>(operation: Promise<Value>): Promise<Value> {
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation),
    );
    return operation;
  }

  private assertOpen(): void {
    if (this.state !== "open") {
      throw Object.assign(new Error("File Session Store is closed"), {
        code: "session_persistence_closed",
      });
    }
  }
}

/** Stable path-safe key; the raw Session id never becomes a path segment. */
export function sessionStorageKey(sessionId: string): string {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId !== sessionId.trim()
  ) {
    throw new Error("Session id must be a non-empty trimmed string");
  }
  return createHash("sha256").update(sessionId).digest("hex");
}

function parseHistoryTransaction(
  value: unknown,
  sessionId: string,
  line: number,
): StoredHistoryTransaction {
  if (
    value === null ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("type" in value) ||
    value.type !== "history_transaction" ||
    !("previousRevision" in value) ||
    !("historyRevision" in value) ||
    !("committedAt" in value) ||
    !("records" in value) ||
    !Array.isArray(value.records)
  ) {
    throw new SessionCorruptionError(
      sessionId,
      `Unknown Session history schema at line ${line}`,
    );
  }
  if (value.records.length === 0) {
    throw new SessionCorruptionError(
      sessionId,
      `Empty Session history transaction at line ${line}`,
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    type: "history_transaction" as const,
    previousRevision: requireStoredIdentifier(
      value.previousRevision,
      sessionId,
      `previousRevision at line ${line}`,
    ),
    historyRevision: requireStoredIdentifier(
      value.historyRevision,
      sessionId,
      `historyRevision at line ${line}`,
    ),
    committedAt: requireStoredIdentifier(
      value.committedAt,
      sessionId,
      `committedAt at line ${line}`,
    ),
    records: value.records as readonly SessionHistoryRecord[],
  });
}

function validateCommittedTransaction(
  records: readonly SessionHistoryRecord[],
  sessionId: string,
): void {
  if (records.every((record) => record.kind === "message")) {
    normalizeAppendSessionMessagesInput({
      sessionId,
      messages: records.map((record) => {
        if (record.kind !== "message") throw new Error("Unreachable record kind");
        return {
          idempotencyKey: record.idempotencyKey,
          runId: record.runId,
          userTurnId: record.userTurnId,
          stepId: record.stepId,
          origin: record.origin,
          ...(record.inputSource === undefined ? {} : { inputSource: record.inputSource }),
          message: record.message,
          ...(record.toolResultArchive === undefined
            ? {}
            : { toolResultArchive: record.toolResultArchive }),
        };
      }),
    });
    return;
  }
  if (records.length === 1 && records[0]?.kind === "checkpoint") return;
  throw new SessionCorruptionError(
    sessionId,
    "Session history transaction mixes incompatible record kinds",
  );
}

async function appendDurableLine(path: string, line: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${line}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createEmptyDurableFile(path: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateDurableFile(path: string, size: number): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(size);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendDurableText(path: string, text: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isFileError(error, "ENOENT")) return false;
    throw error;
  }
}

function requireStoredIdentifier(
  value: unknown,
  sessionId: string,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new SessionCorruptionError(
      sessionId,
      `Session storage ${label} must be a non-empty trimmed string`,
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Session operation was aborted", { cause: signal.reason });
}

function isFileError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && (error as { readonly code?: unknown }).code === code;
}
