import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type {
  ToolResultArchiveInput,
  ToolResultArchiveReference,
} from "../types.js";
import type { ToolResult } from "../../../core/tools/scheduler.js";
import type { BlobReference, BlobStorageBackend } from "../../../storage/blob.js";
import type { StorageBackendResolver } from "../../../storage/backend.js";
import {
  StorageClosedError,
  StorageConflictError,
  StorageCorruptionError,
} from "../../../storage/errors.js";
import type { KvStorageBackend } from "../../../storage/kv.js";
import type {
  OpenToolResultArchiveRequest,
  ToolResultArchive,
  ToolResultArchiveHandle,
  ToolResultArchiveRecord,
} from "../service.js";
import { ToolResultArchiveService } from "../service.js";

const BLOB_NAMESPACE = "tool-results/records";
const INDEX_NAMESPACE = "tool-results/index";
const LOCATOR_PREFIX = "wish-tool-result:v2:";

interface StoredBlobToolResultRecord extends ToolResultArchiveRecord {
  readonly schemaVersion: 2;
  readonly type: "wish_tool_result_archive";
}

interface StoredToolResultIndex {
  readonly schemaVersion: 1;
  readonly type: "wish_tool_result_archive_index";
  readonly identity: ToolResultIdentity;
  readonly resultSha256: string;
  readonly blob: BlobReference;
  readonly createdAt: string;
}

interface ToolResultIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly toolCallId: string;
}

interface ToolResultSnapshot extends ToolResultIdentity {
  readonly result: ToolResult;
}

export interface BlobToolResultArchiveOptions {
  readonly storage: StorageBackendResolver;
  readonly backendId: string;
  readonly legacyLocatorRoot?: string;
  readonly now?: () => Date;
}

/** Tool Result Archive adapter over provider-neutral Blob plus a KV identity index. */
export class BlobToolResultArchive implements ToolResultArchive {
  private readonly backendId: string;
  private readonly blob: BlobStorageBackend;
  private readonly kv: KvStorageBackend;
  private readonly legacyLocatorRoot: string | undefined;
  private readonly now: () => Date;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: BlobToolResultArchiveOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("BlobToolResultArchive options must be an object");
    }
    this.backendId = requireIdentifier(
      options.backendId,
      "Tool Result Archive backendId",
    );
    const backend = options.storage.backend(this.backendId, {
      kv: { list: false },
      blob: { contentAddressed: true },
    });
    if (backend.blob === undefined || backend.kv === undefined) {
      throw new Error("Tool Result Archive backend validation lost a facet");
    }
    this.blob = backend.blob;
    this.kv = backend.kv;
    this.legacyLocatorRoot = options.legacyLocatorRoot === undefined
      ? undefined
      : resolve(options.legacyLocatorRoot);
    this.now = options.now ?? (() => new Date());
  }

  async archive(
    input: ToolResultArchiveInput,
  ): Promise<ToolResultArchiveReference> {
    throwIfAborted(input.signal);
    const snapshot = snapshotInput(input);
    const identity = identityOf(snapshot);
    const identityKey = sha256(stableJson(identity));
    const resultSha256 = sha256(stableJson(snapshot.result));
    return this.serial(identityKey, async () => {
      throwIfAborted(input.signal);
      const existing = await this.loadIndex(identityKey, input.signal);
      if (existing !== undefined) {
        assertMatchingIndex(existing, identity, resultSha256, this.backendContext());
        const found = await this.blob.stat({
          reference: existing.blob,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (found === undefined) {
          throw new StorageCorruptionError(
            "Tool Result archive index references a missing Blob",
            this.backendContext(),
          );
        }
        return archiveReference(existing.blob, resultSha256);
      }

      const record: StoredBlobToolResultRecord = Object.freeze({
        schemaVersion: 2,
        type: "wish_tool_result_archive",
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        userTurnId: snapshot.userTurnId,
        stepId: snapshot.stepId,
        result: snapshot.result,
        resultSha256,
      });
      const blob = await this.blob.put({
        namespace: BLOB_NAMESPACE,
        value: new TextEncoder().encode(stableJson(record)),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const index: StoredToolResultIndex = Object.freeze({
        schemaVersion: 1,
        type: "wish_tool_result_archive_index",
        identity,
        resultSha256,
        blob,
        createdAt: timestamp(this.now()),
      });
      try {
        await this.kv.put({
          namespace: INDEX_NAMESPACE,
          key: identityKey,
          value: new TextEncoder().encode(stableJson(index)),
          precondition: { kind: "absent" },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error: unknown) {
        if (!(error instanceof StorageConflictError)) throw error;
        const raced = await this.loadIndex(identityKey, input.signal);
        if (raced === undefined) throw error;
        assertMatchingIndex(raced, identity, resultSha256, this.backendContext());
        return archiveReference(raced.blob, resultSha256);
      }
      throwIfAborted(input.signal);
      return archiveReference(blob, resultSha256);
    });
  }

  async read(
    reference: ToolResultArchiveReference,
    signal?: AbortSignal,
  ): Promise<ToolResultArchiveRecord> {
    const normalized = normalizeArchiveReference(reference);
    throwIfAborted(signal);
    if (normalized.locator.startsWith(LOCATOR_PREFIX)) {
      const blob = decodeBlobLocator(normalized.locator);
      const bytes = await this.blob.get({
        reference: blob,
        ...(signal === undefined ? {} : { signal }),
      });
      if (bytes === undefined) {
        throw new StorageCorruptionError(
          "Tool Result archive Blob is missing",
          this.backendContext(),
        );
      }
      const record = validateBlobRecord(
        bytes,
        normalized.hash,
        this.backendContext(),
      );
      const identity = Object.freeze({
        sessionId: record.sessionId,
        runId: record.runId,
        userTurnId: record.userTurnId,
        stepId: record.stepId,
        toolCallId: requireIdentifier(
          record.result.callId,
          "Stored Tool Result callId",
        ),
      });
      const index = await this.loadIndex(sha256(stableJson(identity)), signal);
      if (
        index === undefined || index.resultSha256 !== normalized.hash ||
        stableJson(index.identity) !== stableJson(identity) ||
        stableJson(index.blob) !== stableJson(blob)
      ) {
        throw new StorageCorruptionError(
          "Tool Result Blob has no matching identity index",
          this.backendContext(),
        );
      }
      return Object.freeze({ ...record, createdAt: index.createdAt });
    }
    return this.readLegacy(normalized, signal);
  }

  private async readLegacy(
    reference: ToolResultArchiveReference,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultArchiveRecord> {
    if (this.legacyLocatorRoot === undefined) {
      throw new StorageCorruptionError(
        "Legacy Tool Result locator has no configured locator root",
        this.backendContext(),
      );
    }
    const path = resolve(this.legacyLocatorRoot, reference.locator);
    const relativePath = relative(this.legacyLocatorRoot, path);
    if (
      relativePath.length === 0 || relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
    ) {
      throw new StorageCorruptionError(
        "Legacy Tool Result locator escapes its configured root",
        this.backendContext(),
      );
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      throw new StorageCorruptionError(
        "Legacy Tool Result archive cannot be read",
        this.backendContext(),
        { cause: error },
      );
    }
    throwIfAborted(signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new StorageCorruptionError(
        "Legacy Tool Result archive contains invalid JSON",
        this.backendContext(),
        { cause: error },
      );
    }
    return validateLegacyRecord(parsed, reference.hash, this.backendContext());
  }

  private async loadIndex(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<StoredToolResultIndex | undefined> {
    const stored = await this.kv.get({
      namespace: INDEX_NAMESPACE,
      key,
      ...(signal === undefined ? {} : { signal }),
    });
    if (stored === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(stored.value),
      ) as unknown;
    } catch (error: unknown) {
      throw new StorageCorruptionError(
        "Tool Result archive index is malformed",
        this.backendContext(),
        { cause: error },
      );
    }
    return validateIndex(parsed, this.backendContext());
  }

  private serial<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(identity) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(identity, settled);
    void settled.finally(() => {
      if (this.tails.get(identity) === settled) this.tails.delete(identity);
    });
    return result;
  }

  private backendContext() {
    return {
      backendId: this.backendId,
      facet: "blob" as const,
      namespace: BLOB_NAMESPACE,
    };
  }
}

function snapshotInput(input: ToolResultArchiveInput): ToolResultSnapshot {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Tool Result archive input must be an object");
  }
  const result = snapshotJsonValue(input.result, "Tool Result") as ToolResult;
  if (result === null || typeof result !== "object") {
    throw new TypeError("Tool Result archive requires a Tool Result");
  }
  const toolCallId = requireIdentifier(result.callId, "Tool Result callId");
  requireIdentifier(result.toolName, "Tool Result toolName");
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "Tool Result sessionId"),
    runId: requireIdentifier(input.runId, "Tool Result runId"),
    userTurnId: requireIdentifier(input.userTurnId, "Tool Result userTurnId"),
    stepId: requireIdentifier(input.stepId, "Tool Result stepId"),
    toolCallId,
    result,
  });
}

function identityOf(snapshot: ToolResultSnapshot): ToolResultIdentity {
  return Object.freeze({
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    userTurnId: snapshot.userTurnId,
    stepId: snapshot.stepId,
    toolCallId: snapshot.toolCallId,
  });
}

function archiveReference(
  blob: BlobReference,
  resultSha256: string,
): ToolResultArchiveReference {
  return Object.freeze({
    locator: encodeBlobLocator(blob),
    hash: resultSha256,
  });
}

function encodeBlobLocator(blob: BlobReference): string {
  return `${LOCATOR_PREFIX}${Buffer.from(stableJson(blob)).toString("base64url")}`;
}

function decodeBlobLocator(locator: string): BlobReference {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(locator.slice(LOCATOR_PREFIX.length), "base64url").toString("utf8"),
    ) as unknown;
  } catch (error: unknown) {
    throw new StorageCorruptionError(
      "Tool Result Blob locator is malformed",
      { facet: "blob", namespace: BLOB_NAMESPACE },
      { cause: error },
    );
  }
  return validateBlobReference(parsed, { facet: "blob", namespace: BLOB_NAMESPACE });
}

function validateBlobRecord(
  bytes: Uint8Array,
  expectedResultSha256: string,
  context: { readonly facet: "blob"; readonly namespace: string },
): ToolResultArchiveRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error: unknown) {
    throw new StorageCorruptionError(
      "Tool Result archive Blob is malformed",
      context,
      { cause: error },
    );
  }
  if (!isPlainRecord(parsed) || parsed.schemaVersion !== 2 ||
    parsed.type !== "wish_tool_result_archive") {
    throw new StorageCorruptionError(
      "Tool Result archive Blob schema is unsupported",
      context,
    );
  }
  return validateRecordFields(parsed, expectedResultSha256, context);
}

function validateLegacyRecord(
  parsed: unknown,
  expectedResultSha256: string,
  context: { readonly facet: "blob"; readonly namespace: string },
): ToolResultArchiveRecord {
  if (!isPlainRecord(parsed) || parsed.schemaVersion !== 1 ||
    parsed.type !== "tool_result_archive") {
    throw new StorageCorruptionError(
      "Legacy Tool Result archive schema is unsupported",
      context,
    );
  }
  return validateRecordFields(parsed, expectedResultSha256, context);
}

function validateRecordFields(
  record: Record<string, unknown>,
  expectedResultSha256: string,
  context: { readonly facet: "blob"; readonly namespace: string },
): ToolResultArchiveRecord {
  let result: ToolResult;
  try {
    result = snapshotJsonValue(record.result, "Stored Tool Result") as ToolResult;
  } catch (error: unknown) {
    throw new StorageCorruptionError(
      "Stored Tool Result is malformed",
      context,
      { cause: error },
    );
  }
  const actualResultSha256 = sha256(stableJson(result));
  if (
    record.resultSha256 !== expectedResultSha256 ||
    actualResultSha256 !== expectedResultSha256
  ) {
    throw new StorageCorruptionError(
      "Stored Tool Result content hash does not match its reference",
      context,
    );
  }
  const createdAt = record.createdAt;
  if (createdAt !== undefined && typeof createdAt !== "string") {
    throw new StorageCorruptionError(
      "Stored Tool Result createdAt is invalid",
      context,
    );
  }
  return Object.freeze({
    sessionId: storedIdentifier(record.sessionId, "sessionId", context),
    runId: storedIdentifier(record.runId, "runId", context),
    userTurnId: storedIdentifier(record.userTurnId, "userTurnId", context),
    stepId: storedIdentifier(record.stepId, "stepId", context),
    result,
    resultSha256: expectedResultSha256,
    ...(createdAt === undefined ? {} : { createdAt }),
  });
}

function validateIndex(
  value: unknown,
  context: { readonly facet: "blob"; readonly namespace: string },
): StoredToolResultIndex {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 ||
    value.type !== "wish_tool_result_archive_index" ||
    !isPlainRecord(value.identity)) {
    throw new StorageCorruptionError("Tool Result archive index is invalid", context);
  }
  const identity: ToolResultIdentity = Object.freeze({
    sessionId: storedIdentifier(value.identity.sessionId, "sessionId", context),
    runId: storedIdentifier(value.identity.runId, "runId", context),
    userTurnId: storedIdentifier(value.identity.userTurnId, "userTurnId", context),
    stepId: storedIdentifier(value.identity.stepId, "stepId", context),
    toolCallId: storedIdentifier(value.identity.toolCallId, "toolCallId", context),
  });
  const resultSha256 = storedSha256(value.resultSha256, context);
  const blob = validateBlobReference(value.blob, context);
  return Object.freeze({
    schemaVersion: 1,
    type: "wish_tool_result_archive_index",
    identity,
    resultSha256,
    blob,
    createdAt: storedIdentifier(value.createdAt, "createdAt", context),
  });
}

function validateBlobReference(
  value: unknown,
  context: { readonly facet: "blob"; readonly namespace: string },
): BlobReference {
  if (!isPlainRecord(value)) {
    throw new StorageCorruptionError("Tool Result Blob reference is invalid", context);
  }
  const namespace = storedIdentifier(value.namespace, "Blob namespace", context);
  const locator = storedIdentifier(value.locator, "Blob locator", context);
  const sha256 = storedSha256(value.sha256, context);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw new StorageCorruptionError("Tool Result Blob size is invalid", context);
  }
  if (namespace !== BLOB_NAMESPACE) {
    throw new StorageCorruptionError("Tool Result Blob namespace is invalid", context);
  }
  return Object.freeze({
    namespace,
    locator,
    sha256,
    size: value.size as number,
  });
}

function assertMatchingIndex(
  stored: StoredToolResultIndex,
  identity: ToolResultIdentity,
  resultSha256: string,
  context: { readonly facet: "blob"; readonly namespace: string },
): void {
  if (
    stableJson(stored.identity) !== stableJson(identity) ||
    stored.resultSha256 !== resultSha256
  ) {
    throw new StorageConflictError(
      "Tool Result archive identity was already committed with different content",
      context,
    );
  }
}

function normalizeArchiveReference(
  value: ToolResultArchiveReference,
): ToolResultArchiveReference {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Tool Result archive reference must be an object");
  }
  return Object.freeze({
    locator: requireIdentifier(value.locator, "Tool Result archive locator"),
    hash: requireIdentifier(value.hash, "Tool Result archive hash"),
  });
}

function snapshotJsonValue(
  value: unknown,
  label: string,
  ancestors = new Set<object>(),
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} has invalid numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`);
    ancestors.add(value);
    const result = value.map((entry, index) => {
      if (entry === undefined) throw new TypeError(`${label}[${index}] is undefined`);
      return snapshotJsonValue(entry, `${label}[${index}]`, ancestors);
    });
    ancestors.delete(value);
    return Object.freeze(result);
  }
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`);
    ancestors.add(value);
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if (entry === undefined) throw new TypeError(`${label}.${key} is undefined`);
        return [key, snapshotJsonValue(entry, `${label}.${key}`, ancestors)] as const;
      });
    ancestors.delete(value);
    return Object.freeze(Object.fromEntries(entries));
  }
  throw new TypeError(`${label} must be JSON serializable`);
}

function stableJson(value: unknown): string {
  const json = JSON.stringify(snapshotJsonValue(value, "Archive value"));
  if (json === undefined) throw new TypeError("Archive value is not serializable");
  return json;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("BlobToolResultArchive clock returned an invalid Date");
  }
  return value.toISOString();
}

function storedIdentifier(
  value: unknown,
  label: string,
  context: { readonly facet: "blob"; readonly namespace: string },
): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new StorageCorruptionError(`Stored ${label} is invalid`, context);
  }
  return value;
}

function storedSha256(
  value: unknown,
  context: { readonly facet: "blob"; readonly namespace: string },
): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new StorageCorruptionError("Stored SHA-256 is invalid", context);
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export interface Config {
  readonly backendId?: string;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
});

/** Cordis Provider binding Tool Result Archive to one Storage Backend. */
export class BlobToolResultArchiveProvider extends ToolResultArchiveService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;

  readonly backendId: string;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.backendId = requireBackendId(config.backendId ?? "file");
    ctx.storageBackend.backend(this.backendId, {
      kv: { list: false },
      blob: { contentAddressed: true },
    });
  }

  open(request: OpenToolResultArchiveRequest = {}): ToolResultArchiveHandle {
    const lease = this.ctx.storageBackend.acquire(this.backendId, {
      kv: { list: false },
      blob: { contentAddressed: true },
    });
    try {
      const archive = new BlobToolResultArchive({
        storage: lease,
        backendId: this.backendId,
        ...(request.legacyLocatorRoot === undefined
          ? {}
          : { legacyLocatorRoot: request.legacyLocatorRoot }),
      });
      let released = false;
      const handle: ToolResultArchiveHandle = {
        get released(): boolean {
          return released;
        },
        archive(input: ToolResultArchiveInput) {
          if (released) throw new StorageClosedError(lease.id);
          return archive.archive(input);
        },
        read(
          reference: ToolResultArchiveReference,
          signal?: AbortSignal,
        ) {
          if (released) throw new StorageClosedError(lease.id);
          return archive.read(reference, signal);
        },
        release(): boolean {
          if (released) return false;
          released = true;
          return lease.release();
        },
      };
      return Object.freeze(handle);
    } catch (error: unknown) {
      lease.release();
      throw error;
    }
  }
}

function requireBackendId(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw new TypeError("Tool Result Archive backendId is invalid");
  return value;
}

export default BlobToolResultArchiveProvider;
