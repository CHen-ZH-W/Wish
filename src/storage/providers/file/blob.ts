import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  BlobPutRequest,
  BlobReadRequest,
  BlobReference,
  BlobStat,
  BlobStorageBackend,
} from "../../blob.js";
import {
  StorageClosedError,
  StorageConflictError,
  StorageError,
  StorageUnavailableError,
} from "../../errors.js";
import {
  fileBlobPath,
  fileBlobTemporaryPath,
} from "./paths.js";

const LOCATOR_PREFIX = "sha256-v1:";

export interface FileBlobStorageBackendOptions {
  readonly backendId: string;
  readonly rootDirectory: string;
  readonly temporaryId?: () => string;
}

/** Durable immutable content-addressed Blob implementation. */
export class FileBlobStorageBackend implements BlobStorageBackend {
  readonly facet = "blob" as const;
  readonly rootDirectory: string;

  private readonly temporaryId: () => string;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<Promise<unknown>>();
  private state: "open" | "closing" | "closed" = "open";

  constructor(private readonly options: FileBlobStorageBackendOptions) {
    requireBackendId(options.backendId);
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.length === 0 ||
      options.rootDirectory !== options.rootDirectory.trim()
    ) throw new TypeError("File Blob rootDirectory must be non-empty trimmed text");
    this.rootDirectory = resolve(options.rootDirectory);
    this.temporaryId = options.temporaryId ?? (() => randomUUID());
  }

  put(request: BlobPutRequest): Promise<BlobReference> {
    const namespace = requireIdentity(request?.namespace, "Blob namespace");
    const value = copyBytes(request?.value);
    const sha256 = digestBytes(value);
    const reference = freezeReference({
      namespace,
      locator: `${LOCATOR_PREFIX}${sha256}`,
      sha256,
      size: value.byteLength,
    });
    return this.serial(`${namespace.length}:${namespace}:${sha256}`, async () => {
      throwIfAborted(request.signal);
      const existing = await this.read(reference, request.signal);
      if (existing !== undefined) return reference;
      await this.write(reference, value, request.signal);
      return reference;
    });
  }

  async get(request: BlobReadRequest): Promise<Uint8Array | undefined> {
    this.assertOpen();
    const reference = normalizeReference(request?.reference);
    return this.track(this.read(reference, request.signal));
  }

  async stat(request: BlobReadRequest): Promise<BlobStat | undefined> {
    this.assertOpen();
    const reference = normalizeReference(request?.reference);
    const operation = this.read(reference, request.signal).then((value) =>
      value === undefined ? undefined : Object.freeze({ reference })
    );
    return this.track(operation);
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "open") this.state = "closing";
    await Promise.allSettled([...this.active]);
    this.state = "closed";
  }

  private async read(
    reference: BlobReference,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | undefined> {
    throwIfAborted(signal);
    const path = fileBlobPath(
      this.rootDirectory,
      reference.namespace,
      reference.sha256,
    );
    let value: Uint8Array;
    try {
      value = Uint8Array.from(await readFile(path));
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw mapFileFailure(error, this.options.backendId, reference.namespace);
    }
    throwIfAborted(signal);
    if (
      value.byteLength !== reference.size ||
      digestBytes(value) !== reference.sha256
    ) {
      throw new StorageConflictError(
        "File Blob content does not match its immutable reference",
        {
          backendId: this.options.backendId,
          facet: "blob",
          namespace: reference.namespace,
          key: reference.locator,
        },
      );
    }
    return value;
  }

  private async write(
    reference: BlobReference,
    value: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const targetPath = fileBlobPath(
      this.rootDirectory,
      reference.namespace,
      reference.sha256,
    );
    const directory = dirname(targetPath);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error: unknown) {
      throw mapFileFailure(error, this.options.backendId, reference.namespace);
    }
    throwIfAborted(signal);
    const temporaryPath = fileBlobTemporaryPath(
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
        await handle.writeFile(value);
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
      throw mapFileFailure(error, this.options.backendId, reference.namespace);
    } finally {
      if (temporaryExists) {
        try {
          await rm(temporaryPath, { force: true });
        } catch (error: unknown) {
          if (failure === undefined) {
            throw mapFileFailure(
              error,
              this.options.backendId,
              reference.namespace,
            );
          }
        }
      }
    }
  }

  private serial<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
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
      throw new StorageClosedError(this.options.backendId, "blob");
    }
  }
}

function normalizeReference(value: BlobReference): BlobReference {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Blob reference must be an object");
  }
  const namespace = requireIdentity(value.namespace, "Blob namespace");
  const sha256 = requireSha256(value.sha256);
  if (value.locator !== `${LOCATOR_PREFIX}${sha256}`) {
    throw new TypeError("File Blob locator is unsupported or inconsistent");
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0) {
    throw new TypeError("Blob size must be a non-negative safe integer");
  }
  return freezeReference({
    namespace,
    locator: value.locator,
    sha256,
    size: value.size,
  });
}

function freezeReference(value: BlobReference): BlobReference {
  return Object.freeze({ ...value });
}

function copyBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Blob value must be a Uint8Array");
  }
  return Uint8Array.from(value);
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireSha256(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Blob sha256 must be a lowercase SHA-256 digest");
  }
  return value;
}

function requireIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBackendId(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw new TypeError("File Blob backendId must be a valid identifier");
  return value;
}

function requireTemporaryId(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("File Blob temporaryId factory must return text");
  }
  return value;
}

function mapFileFailure(
  error: unknown,
  backendId: string,
  namespace: string,
): Error {
  if (error instanceof StorageError || isAbortError(error)) return error;
  return new StorageUnavailableError(
    "File Blob operation failed",
    { backendId, facet: "blob", namespace },
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

export function fileBlobStoragePath(
  backend: FileBlobStorageBackend,
  reference: BlobReference,
): string {
  const normalized = normalizeReference(reference);
  return fileBlobPath(
    backend.rootDirectory,
    normalized.namespace,
    normalized.sha256,
  );
}
