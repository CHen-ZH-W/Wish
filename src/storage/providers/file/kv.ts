import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  StorageClosedError,
  StorageConflictError,
  StorageCorruptionError,
  StorageError,
  StorageUnavailableError,
} from "../../errors.js";
import type {
  KvAddress,
  KvDeleteRequest,
  KvDeleteResult,
  KvListEntry,
  KvListRequest,
  KvPrecondition,
  KvPutRequest,
  KvReadRequest,
  KvReadResult,
  KvStorageBackend,
  KvWriteResult,
} from "../../kv.js";
import {
  digest,
  fileKvKeyPath,
  fileKvNamespaceDirectory,
  fileKvTemporaryPath,
} from "./paths.js";

interface StoredKvEnvelope {
  readonly schemaVersion: 1;
  readonly type: "wish_storage_kv";
  readonly namespace: string;
  readonly key: string;
  readonly revision: string;
  readonly valueBase64: string;
}

interface NormalizedAddress {
  readonly namespace: string;
  readonly key: string;
}

export interface FileKvStorageBackendOptions {
  readonly backendId: string;
  readonly rootDirectory: string;
  readonly revision?: () => string;
  readonly temporaryId?: () => string;
}

/** Durable atomic file implementation of the byte KV contract. */
export class FileKvStorageBackend implements KvStorageBackend {
  readonly facet = "kv" as const;
  readonly rootDirectory: string;

  private readonly revision: () => string;
  private readonly temporaryId: () => string;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<Promise<unknown>>();
  private state: "open" | "closing" | "closed" = "open";

  constructor(private readonly options: FileKvStorageBackendOptions) {
    requireBackendId(options.backendId);
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.length === 0 ||
      options.rootDirectory !== options.rootDirectory.trim()
    ) throw new TypeError("File KV rootDirectory must be a non-empty trimmed path");
    this.rootDirectory = resolve(options.rootDirectory);
    this.revision = options.revision ?? (() => `kv-revision:${randomUUID()}`);
    this.temporaryId = options.temporaryId ?? (() => randomUUID());
  }

  async get(request: KvReadRequest): Promise<KvReadResult | undefined> {
    this.assertOpen();
    const address = normalizeAddress(request);
    const signal = request.signal;
    return this.track((async () => {
      throwIfAborted(signal);
      const envelope = await this.read(address, signal);
      throwIfAborted(signal);
      if (envelope === undefined) return undefined;
      return Object.freeze({
        value: Uint8Array.from(decodeBase64(envelope.valueBase64, this.context(address))),
        revision: envelope.revision,
      });
    })());
  }

  async put(request: KvPutRequest): Promise<KvWriteResult> {
    const address = normalizeAddress(request);
    const value = copyBytes(request.value);
    const precondition = normalizePrecondition(request.precondition);
    const signal = request.signal;
    return this.serial(address, async () => {
      throwIfAborted(signal);
      const current = await this.read(address, signal);
      assertPrecondition(this.options.backendId, address, precondition, current);
      const revision = requireRevision(this.revision(), "File KV revision factory");
      const envelope: StoredKvEnvelope = Object.freeze({
        schemaVersion: 1,
        type: "wish_storage_kv",
        namespace: address.namespace,
        key: address.key,
        revision,
        valueBase64: Buffer.from(value).toString("base64"),
      });
      await this.write(address, envelope, signal);
      return Object.freeze({ revision });
    });
  }

  async delete(request: KvDeleteRequest): Promise<KvDeleteResult> {
    const address = normalizeAddress(request);
    const precondition = normalizePrecondition(request.precondition);
    const signal = request.signal;
    return this.serial(address, async () => {
      throwIfAborted(signal);
      const current = await this.read(address, signal);
      assertPrecondition(this.options.backendId, address, precondition, current);
      if (current === undefined) return Object.freeze({ deleted: false });
      const targetPath = fileKvKeyPath(
        this.rootDirectory,
        address.namespace,
        address.key,
      );
      try {
        throwIfAborted(signal);
        await unlink(targetPath);
        await syncDirectory(dirname(targetPath));
      } catch (error: unknown) {
        throw mapFileFailure(error, this.options.backendId, address);
      }
      return Object.freeze({ deleted: true });
    });
  }

  async list(request: KvListRequest): Promise<readonly KvListEntry[]> {
    this.assertOpen();
    const namespace = requireLogicalIdentity(request.namespace, "KV namespace");
    const signal = request.signal;
    return this.track((async () => {
      throwIfAborted(signal);
      const directory = fileKvNamespaceDirectory(this.rootDirectory, namespace);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error: unknown) {
        if (isNodeError(error, "ENOENT")) return Object.freeze([]);
        throw mapFileFailure(error, this.options.backendId, { namespace });
      }
      const entries: KvListEntry[] = [];
      const keys = new Set<string>();
      for (const name of names.sort()) {
        throwIfAborted(signal);
        if (!/^key-[a-f0-9]{64}\.json$/u.test(name)) continue;
        const path = join(directory, name);
        const envelope = await this.readPath(path, { namespace }, signal);
        if (envelope === undefined) continue;
        if (
          envelope.namespace !== namespace ||
          fileKvKeyPath(this.rootDirectory, namespace, envelope.key) !== path
        ) {
          throw new StorageCorruptionError(
            "File KV entry does not match its hashed logical identity",
            this.context({ namespace, key: envelope.key }),
          );
        }
        if (keys.has(envelope.key)) {
          throw new StorageCorruptionError(
            "File KV namespace contains a duplicate logical key",
            this.context({ namespace, key: envelope.key }),
          );
        }
        keys.add(envelope.key);
        entries.push(Object.freeze({
          key: envelope.key,
          revision: envelope.revision,
        }));
      }
      entries.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
      return Object.freeze(entries);
    })());
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "open") this.state = "closing";
    await Promise.allSettled([...this.active]);
    this.state = "closed";
  }

  private async read(
    address: NormalizedAddress,
    signal: AbortSignal | undefined,
  ): Promise<StoredKvEnvelope | undefined> {
    return this.readPath(
      fileKvKeyPath(this.rootDirectory, address.namespace, address.key),
      address,
      signal,
    );
  }

  private async readPath(
    path: string,
    expected: { readonly namespace: string; readonly key?: string },
    signal: AbortSignal | undefined,
  ): Promise<StoredKvEnvelope | undefined> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw mapFileFailure(error, this.options.backendId, expected);
    }
    throwIfAborted(signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new StorageCorruptionError(
        "File KV entry contains invalid JSON",
        this.context(expected),
        { cause: error },
      );
    }
    const envelope = validateEnvelope(parsed, this.context(expected));
    if (
      envelope.namespace !== expected.namespace ||
      (expected.key !== undefined && envelope.key !== expected.key)
    ) {
      throw new StorageCorruptionError(
        "File KV envelope identity does not match its requested address",
        this.context(expected),
      );
    }
    return envelope;
  }

  private async write(
    address: NormalizedAddress,
    envelope: StoredKvEnvelope,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const targetPath = fileKvKeyPath(
      this.rootDirectory,
      address.namespace,
      address.key,
    );
    const directory = dirname(targetPath);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error: unknown) {
      throw mapFileFailure(error, this.options.backendId, address);
    }
    throwIfAborted(signal);
    const temporaryPath = fileKvTemporaryPath(
      targetPath,
      requireTemporaryId(this.temporaryId()),
    );
    let temporaryExists = false;
    let failure: unknown;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryExists = true;
      let writeFailure: unknown;
      try {
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
        await handle.sync();
      } catch (error: unknown) {
        writeFailure = error;
        throw error;
      } finally {
        try {
          await handle.close();
        } catch (error: unknown) {
          if (writeFailure === undefined) throw error;
        }
      }
      throwIfAborted(signal);
      await rename(temporaryPath, targetPath);
      temporaryExists = false;
      await syncDirectory(directory);
    } catch (error: unknown) {
      failure = error;
      throw mapFileFailure(error, this.options.backendId, address);
    } finally {
      if (temporaryExists) {
        try {
          await rm(temporaryPath, { force: true });
        } catch (error: unknown) {
          if (failure === undefined) {
            throw mapFileFailure(error, this.options.backendId, address);
          }
        }
      }
    }
  }

  private serial<T>(
    address: NormalizedAddress,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const identity = `${address.namespace.length}:${address.namespace}${address.key}`;
    const previous = this.tails.get(identity) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
      this.assertOpen();
      return operation();
    });
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(identity, settled);
    void settled.finally(() => {
      if (this.tails.get(identity) === settled) this.tails.delete(identity);
    });
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
      throw new StorageClosedError(this.options.backendId, "kv");
    }
  }

  private context(address: {
    readonly namespace?: string;
    readonly key?: string;
  }) {
    return {
      backendId: this.options.backendId,
      facet: "kv" as const,
      ...address,
    };
  }
}

function validateEnvelope(
  value: unknown,
  context: {
    readonly backendId: string;
    readonly facet: "kv";
    readonly namespace?: string;
    readonly key?: string;
  },
): StoredKvEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageCorruptionError("File KV envelope must be an object", context);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.type !== "wish_storage_kv") {
    throw new StorageCorruptionError("File KV envelope schema is unsupported", context);
  }
  const namespace = storedIdentity(record.namespace, "namespace", context);
  const key = storedIdentity(record.key, "key", context);
  const revision = storedRevision(record.revision, context);
  if (typeof record.valueBase64 !== "string") {
    throw new StorageCorruptionError("File KV envelope value is not base64 text", context);
  }
  decodeBase64(record.valueBase64, context);
  return Object.freeze({
    schemaVersion: 1,
    type: "wish_storage_kv",
    namespace,
    key,
    revision,
    valueBase64: record.valueBase64,
  });
}

function assertPrecondition(
  backendId: string,
  address: NormalizedAddress,
  precondition: KvPrecondition,
  current: StoredKvEnvelope | undefined,
): void {
  const context = {
    backendId,
    facet: "kv" as const,
    namespace: address.namespace,
    key: address.key,
  };
  if (precondition.kind === "any") return;
  if (precondition.kind === "absent") {
    if (current === undefined) return;
    throw new StorageConflictError("KV value already exists", context);
  }
  if (current?.revision === precondition.revision) return;
  throw new StorageConflictError("KV revision precondition failed", context);
}

function normalizeAddress(value: KvAddress): NormalizedAddress {
  if (value === null || typeof value !== "object") {
    throw new TypeError("KV request must be an object");
  }
  return Object.freeze({
    namespace: requireLogicalIdentity(value.namespace, "KV namespace"),
    key: requireLogicalIdentity(value.key, "KV key"),
  });
}

function normalizePrecondition(value: KvPrecondition): KvPrecondition {
  if (value === null || typeof value !== "object") {
    throw new TypeError("KV precondition must be an object");
  }
  if (value.kind === "any") return Object.freeze({ kind: "any" });
  if (value.kind === "absent") return Object.freeze({ kind: "absent" });
  if (value.kind === "revision") {
    return Object.freeze({
      kind: "revision",
      revision: requireRevision(value.revision, "KV precondition revision"),
    });
  }
  throw new TypeError("KV precondition kind is invalid");
}

function copyBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("KV value must be a Uint8Array");
  }
  return Uint8Array.from(value);
}

function requireLogicalIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBackendId(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw new TypeError("File KV backendId must be a valid identifier");
  return value;
}

function requireRevision(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) throw new TypeError(`${label} must be non-empty trimmed text`);
  return value;
}

function requireTemporaryId(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("File KV temporaryId factory must return a non-empty string");
  }
  return value;
}

function storedIdentity(
  value: unknown,
  label: string,
  context: Parameters<typeof validateEnvelope>[1],
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StorageCorruptionError(
      `File KV envelope ${label} is invalid`,
      context,
    );
  }
  return value;
}

function storedRevision(
  value: unknown,
  context: Parameters<typeof validateEnvelope>[1],
): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new StorageCorruptionError("File KV envelope revision is invalid", context);
  }
  return value;
}

function decodeBase64(
  value: string,
  context: Parameters<typeof validateEnvelope>[1],
): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) {
    throw new StorageCorruptionError("File KV envelope value is invalid base64", context);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new StorageCorruptionError("File KV envelope value is invalid base64", context);
  }
  return decoded;
}

function mapFileFailure(
  error: unknown,
  backendId: string,
  address: { readonly namespace?: string; readonly key?: string },
): Error {
  if (error instanceof StorageError || isAbortError(error)) return error;
  return new StorageUnavailableError(
    "File KV operation failed",
    { backendId, facet: "kv", ...address },
    { cause: error },
  );
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

export function fileKvStoragePath(
  backend: FileKvStorageBackend,
  namespace: string,
  key: string,
): string {
  return fileKvKeyPath(
    backend.rootDirectory,
    requireLogicalIdentity(namespace, "KV namespace"),
    requireLogicalIdentity(key, "KV key"),
  );
}

export function fileKvLogicalDigest(value: string): string {
  return digest(value);
}
