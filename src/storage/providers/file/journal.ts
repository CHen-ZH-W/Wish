import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  stat,
  truncate,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  StorageClosedError,
  StorageConflictError,
  StorageCorruptionError,
  StorageError,
  StorageUnavailableError,
} from "../../errors.js";
import type {
  Journal,
  JournalBatch,
  JournalCommit,
  JournalEntry,
  JournalPrecondition,
  JournalReadOptions,
  JournalStorageBackend,
  OpenJournalRequest,
} from "../../journal.js";
import { fileJournalPath } from "./paths.js";

const EMPTY_REVISION = "journal:empty";

interface StoredJournalTransactionCore {
  readonly schemaVersion: 1;
  readonly type: "wish_storage_journal_transaction";
  readonly namespace: string;
  readonly previousRevision: string;
  readonly revision: string;
  readonly idempotencyKey: string;
  readonly firstCursor: number;
  readonly entriesBase64: readonly string[];
  readonly batchSha256: string;
}

interface StoredJournalTransaction extends StoredJournalTransactionCore {
  readonly transactionSha256: string;
}

interface LoadedJournal {
  readonly transactions: readonly StoredJournalTransaction[];
  readonly revision: string;
  readonly lastCursor: number;
}

export type FileJournalTornTailRecovery = "fail" | "truncate";

export interface FileJournalWarning {
  readonly code: "torn_tail_truncated";
  readonly namespace: string;
  readonly path: string;
  readonly removedBytes: number;
}

export interface FileJournalStorageBackendOptions {
  readonly backendId: string;
  readonly rootDirectory: string;
  readonly revision?: (lastCursor: number) => string;
  readonly tornTailRecovery?: FileJournalTornTailRecovery;
  readonly onWarning?: (warning: FileJournalWarning) => void;
}

/** File-backed Journal factory with one process-local writer per namespace. */
export class FileJournalStorageBackend implements JournalStorageBackend {
  readonly facet = "journal" as const;
  readonly rootDirectory: string;

  private readonly journals = new Map<string, FileJournal>();
  private state: "open" | "closing" | "closed" = "open";

  constructor(private readonly options: FileJournalStorageBackendOptions) {
    requireBackendId(options.backendId);
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.length === 0 ||
      options.rootDirectory !== options.rootDirectory.trim()
    ) throw new TypeError("File Journal rootDirectory must be non-empty text");
    if (
      options.tornTailRecovery !== undefined &&
      options.tornTailRecovery !== "fail" &&
      options.tornTailRecovery !== "truncate"
    ) throw new TypeError("File Journal tornTailRecovery is invalid");
    this.rootDirectory = resolve(options.rootDirectory);
  }

  open(request: OpenJournalRequest): Journal {
    this.assertOpen();
    const namespace = requireIdentity(request?.namespace, "Journal namespace");
    let journal = this.journals.get(namespace);
    if (journal === undefined || !journal.open) {
      journal = new FileJournal({
        backendId: this.options.backendId,
        rootDirectory: this.rootDirectory,
        namespace,
        revision: this.options.revision ?? (() => randomUUID()),
        tornTailRecovery: this.options.tornTailRecovery ?? "fail",
        onWarning: this.options.onWarning ?? (() => undefined),
      });
      this.journals.set(namespace, journal);
    }
    return journal;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";
    await Promise.allSettled([...this.journals.values()].map((journal) =>
      journal.close()
    ));
    this.state = "closed";
  }

  private assertOpen(): void {
    if (this.state !== "open") {
      throw new StorageClosedError(this.options.backendId, "journal");
    }
  }
}

interface FileJournalOptions {
  readonly backendId: string;
  readonly rootDirectory: string;
  readonly namespace: string;
  readonly revision: (lastCursor: number) => string;
  readonly tornTailRecovery: FileJournalTornTailRecovery;
  readonly onWarning: (warning: FileJournalWarning) => void;
}

class FileJournal implements Journal {
  private readonly path: string;
  private tail: Promise<void> = Promise.resolve();
  private readonly active = new Set<Promise<unknown>>();
  private state: "open" | "closing" | "closed" = "open";

  get open(): boolean {
    return this.state === "open";
  }

  constructor(private readonly options: FileJournalOptions) {
    this.path = fileJournalPath(options.rootDirectory, options.namespace);
  }

  append(
    batch: JournalBatch,
    precondition: JournalPrecondition,
    signal?: AbortSignal,
  ): Promise<JournalCommit> {
    const normalized = normalizeBatch(batch);
    const expected = normalizePrecondition(precondition);
    return this.serial(async () => {
      throwIfAborted(signal);
      const loaded = await this.load(signal);
      const existing = loaded.transactions.find(
        (transaction) =>
          transaction.idempotencyKey === normalized.idempotencyKey,
      );
      const batchSha256 = digestBatch(normalized.entries);
      if (existing !== undefined) {
        if (existing.batchSha256 !== batchSha256) {
          throw new StorageConflictError(
            "Journal idempotency key was already used by another batch",
            this.context(),
          );
        }
        return commitOf(existing, true);
      }
      if (
        expected.kind === "revision" &&
        expected.revision !== loaded.revision
      ) {
        throw new StorageConflictError(
          "Journal revision precondition failed",
          this.context(),
        );
      }
      const firstCursor = loaded.lastCursor + 1;
      const lastCursor = firstCursor + normalized.entries.length - 1;
      const revisionSeed = requireRevision(
        this.options.revision(lastCursor),
        "File Journal revision factory",
      );
      const revision = `journal-revision:${String(lastCursor).padStart(16, "0")}:` +
        revisionSeed;
      if (revision === loaded.revision) {
        throw new TypeError("File Journal revision must change on append");
      }
      const core: StoredJournalTransactionCore = Object.freeze({
        schemaVersion: 1,
        type: "wish_storage_journal_transaction",
        namespace: this.options.namespace,
        previousRevision: loaded.revision,
        revision,
        idempotencyKey: normalized.idempotencyKey,
        firstCursor,
        entriesBase64: Object.freeze(normalized.entries.map((entry) =>
          Buffer.from(entry).toString("base64")
        )),
        batchSha256,
      });
      const transaction: StoredJournalTransaction = Object.freeze({
        ...core,
        transactionSha256: digestText(stableJson(core)),
      });
      await this.persist(transaction, signal);
      return commitOf(transaction, false);
    });
  }

  async *read(options: JournalReadOptions = {}): AsyncIterable<JournalEntry> {
    this.assertOpen();
    let finish!: () => void;
    const activity = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active.add(activity);
    try {
      const afterCursor = normalizeAfterCursor(options.afterCursor);
      const loaded = await this.load(options.signal);
      for (const transaction of loaded.transactions) {
        for (let index = 0; index < transaction.entriesBase64.length; index += 1) {
          throwIfAborted(options.signal);
          const cursor = transaction.firstCursor + index;
          if (cursor <= afterCursor) continue;
          yield Object.freeze({
            cursor,
            revision: transaction.revision,
            idempotencyKey: transaction.idempotencyKey,
            batchIndex: index,
            value: Uint8Array.from(
              decodeBase64(transaction.entriesBase64[index]!),
            ),
          });
        }
      }
    } finally {
      this.active.delete(activity);
      finish();
    }
  }

  flush(): Promise<void> {
    return this.serial(async () => {
      let exists = true;
      try {
        await stat(this.path);
      } catch (error: unknown) {
        if (isNodeError(error, "ENOENT")) exists = false;
        else throw mapFileFailure(error, this.options);
      }
      if (!exists) return;
      try {
        const handle = await open(this.path, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error: unknown) {
        throw mapFileFailure(error, this.options);
      }
    });
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "open") this.state = "closing";
    await this.tail.catch(() => undefined);
    await Promise.allSettled([...this.active]);
    this.state = "closed";
  }

  private async load(signal: AbortSignal | undefined): Promise<LoadedJournal> {
    throwIfAborted(signal);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return Object.freeze({
          transactions: Object.freeze([]),
          revision: EMPTY_REVISION,
          lastCursor: 0,
        });
      }
      throw mapFileFailure(error, this.options);
    }
    throwIfAborted(signal);
    let completeLength = bytes.length;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      const lastNewline = bytes.lastIndexOf(0x0a);
      completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
      if (this.options.tornTailRecovery === "fail") {
        throw new StorageCorruptionError(
          "File Journal contains a torn tail",
          this.context(),
        );
      }
      const removedBytes = bytes.length - completeLength;
      try {
        await truncate(this.path, completeLength);
        await syncFileAndDirectory(this.path);
      } catch (error: unknown) {
        throw mapFileFailure(error, this.options);
      }
      try {
        this.options.onWarning(Object.freeze({
          code: "torn_tail_truncated" as const,
          namespace: this.options.namespace,
          path: this.path,
          removedBytes,
        }));
      } catch {
        // Recovery is already durable; observers cannot reverse it.
      }
      bytes = bytes.subarray(0, completeLength);
    }
    const text = bytes.toString("utf8");
    const lines = text.length === 0
      ? []
      : text.slice(0, -1).split("\n");
    const transactions: StoredJournalTransaction[] = [];
    let revision = EMPTY_REVISION;
    let lastCursor = 0;
    const idempotency = new Set<string>();
    for (const line of lines) {
      throwIfAborted(signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error: unknown) {
        throw new StorageCorruptionError(
          "File Journal contains invalid JSON",
          this.context(),
          { cause: error },
        );
      }
      const transaction = validateTransaction(parsed, this.options);
      if (
        transaction.previousRevision !== revision ||
        transaction.firstCursor !== lastCursor + 1 ||
        idempotency.has(transaction.idempotencyKey)
      ) {
        throw new StorageCorruptionError(
          "File Journal transaction chain is inconsistent",
          this.context(),
        );
      }
      idempotency.add(transaction.idempotencyKey);
      transactions.push(transaction);
      revision = transaction.revision;
      lastCursor = transaction.firstCursor + transaction.entriesBase64.length - 1;
    }
    return Object.freeze({
      transactions: Object.freeze(transactions),
      revision,
      lastCursor,
    });
  }

  private async persist(
    transaction: StoredJournalTransaction,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const directory = dirname(this.path);
    let existed = true;
    try {
      await stat(this.path);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) existed = false;
      else throw mapFileFailure(error, this.options);
    }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      throwIfAborted(signal);
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(`${stableJson(transaction)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!existed) await syncDirectory(directory);
    } catch (error: unknown) {
      throw mapFileFailure(error, this.options);
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return this.track(result);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.assertOpen();
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation),
    );
    return operation;
  }

  private assertOpen(): void {
    if (this.state !== "open") {
      throw new StorageClosedError(this.options.backendId, "journal");
    }
  }

  private context() {
    return {
      backendId: this.options.backendId,
      facet: "journal" as const,
      namespace: this.options.namespace,
    };
  }
}

function normalizeBatch(batch: JournalBatch): JournalBatch {
  if (batch === null || typeof batch !== "object") {
    throw new TypeError("Journal batch must be an object");
  }
  const idempotencyKey = requireIdentity(
    batch.idempotencyKey,
    "Journal idempotencyKey",
  );
  if (!Array.isArray(batch.entries) || batch.entries.length === 0) {
    throw new TypeError("Journal batch entries must be a non-empty array");
  }
  return Object.freeze({
    idempotencyKey,
    entries: Object.freeze(batch.entries.map((entry) => {
      if (!(entry instanceof Uint8Array)) {
        throw new TypeError("Journal entries must be Uint8Array values");
      }
      return Uint8Array.from(entry);
    })),
  });
}

function normalizePrecondition(
  precondition: JournalPrecondition,
): JournalPrecondition {
  if (precondition === null || typeof precondition !== "object") {
    throw new TypeError("Journal precondition must be an object");
  }
  if (precondition.kind === "any") return Object.freeze({ kind: "any" });
  if (precondition.kind === "revision") {
    return Object.freeze({
      kind: "revision",
      revision: requireRevision(
        precondition.revision,
        "Journal precondition revision",
      ),
    });
  }
  throw new TypeError("Journal precondition kind is invalid");
}

function normalizeAfterCursor(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Journal afterCursor must be a non-negative integer");
  }
  return value;
}

function validateTransaction(
  value: unknown,
  options: FileJournalOptions,
): StoredJournalTransaction {
  const context = {
    backendId: options.backendId,
    facet: "journal" as const,
    namespace: options.namespace,
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageCorruptionError("File Journal entry must be an object", context);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.type !== "wish_storage_journal_transaction" ||
    record.namespace !== options.namespace ||
    typeof record.previousRevision !== "string" ||
    typeof record.revision !== "string" ||
    typeof record.idempotencyKey !== "string" ||
    !Number.isSafeInteger(record.firstCursor) ||
    (record.firstCursor as number) < 1 ||
    !Array.isArray(record.entriesBase64) ||
    record.entriesBase64.length === 0 ||
    typeof record.batchSha256 !== "string" ||
    typeof record.transactionSha256 !== "string"
  ) {
    throw new StorageCorruptionError(
      "File Journal transaction schema is invalid",
      context,
    );
  }
  let entriesBase64: readonly string[];
  try {
    entriesBase64 = Object.freeze(record.entriesBase64.map((entry) => {
      if (typeof entry !== "string") throw new TypeError("payload is not text");
      decodeBase64(entry);
      return entry;
    }));
  } catch (error: unknown) {
    throw new StorageCorruptionError(
      "File Journal transaction payload is invalid",
      context,
      { cause: error },
    );
  }
  let core: StoredJournalTransactionCore;
  try {
    core = Object.freeze({
      schemaVersion: 1,
      type: "wish_storage_journal_transaction",
      namespace: options.namespace,
      previousRevision: requireRevision(
        record.previousRevision,
        "Journal previousRevision",
      ),
      revision: requireRevision(record.revision, "Journal revision"),
      idempotencyKey: requireIdentity(
        record.idempotencyKey,
        "Journal idempotencyKey",
      ),
      firstCursor: record.firstCursor as number,
      entriesBase64,
      batchSha256: requireSha256(record.batchSha256, "Journal batchSha256"),
    });
  } catch (error: unknown) {
    throw new StorageCorruptionError(
      "File Journal transaction fields are invalid",
      context,
      { cause: error },
    );
  }
  if (digestBatch(entriesBase64.map(decodeBase64)) !== core.batchSha256) {
    throw new StorageCorruptionError(
      "File Journal batch checksum is invalid",
      context,
    );
  }
  let transactionSha256: string;
  try {
    transactionSha256 = requireSha256(
      record.transactionSha256,
      "Journal transactionSha256",
    );
  } catch (error: unknown) {
    throw new StorageCorruptionError(
      "File Journal transaction checksum field is invalid",
      context,
      { cause: error },
    );
  }
  if (digestText(stableJson(core)) !== transactionSha256) {
    throw new StorageCorruptionError(
      "File Journal transaction checksum is invalid",
      context,
    );
  }
  return Object.freeze({ ...core, transactionSha256 });
}

function commitOf(
  transaction: StoredJournalTransaction,
  replayed: boolean,
): JournalCommit {
  return Object.freeze({
    idempotencyKey: transaction.idempotencyKey,
    firstCursor: transaction.firstCursor,
    lastCursor: transaction.firstCursor + transaction.entriesBase64.length - 1,
    revision: transaction.revision,
    replayed,
  });
}

function digestBatch(entries: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(entry.byteLength));
    hash.update(length);
    hash.update(entry);
  }
  return hash.digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) throw new TypeError("invalid base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new TypeError("invalid base64");
  return Uint8Array.from(decoded);
}

function requireIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireRevision(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) throw new TypeError(`${label} must be non-empty trimmed text`);
  return value;
}

function requireSha256(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireBackendId(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw new TypeError("File Journal backendId must be a valid identifier");
  return value;
}

function mapFileFailure(error: unknown, options: FileJournalOptions): Error {
  if (error instanceof StorageError || isAbortError(error)) return error;
  return new StorageUnavailableError(
    "File Journal operation failed",
    {
      backendId: options.backendId,
      facet: "journal",
      namespace: options.namespace,
    },
    { cause: error },
  );
}

async function syncFileAndDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}

export function fileJournalStoragePath(
  backend: FileJournalStorageBackend,
  namespace: string,
): string {
  return fileJournalPath(
    backend.rootDirectory,
    requireIdentity(namespace, "Journal namespace"),
  );
}
