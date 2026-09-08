import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  ToolResultArchiveInput,
  ToolResultArchivePort,
  ToolResultArchiveReference,
} from "../../context/types.js";
import type { ToolResult } from "../../core/tools/scheduler.js";

interface StoredToolResultArchiveRecord {
  readonly schemaVersion: 1;
  readonly type: "tool_result_archive";
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly result: ToolResult;
  readonly resultSha256: string;
  readonly createdAt: string;
}

export interface FileToolResultArchiveOptions {
  /** Directory containing hashed per-Session archive directories. */
  readonly directory: string;
  /** Base used to produce portable slash-separated locators. Defaults to directory. */
  readonly locatorRoot?: string;
  readonly now?: () => Date;
  readonly temporaryId?: () => string;
}

/** Durable, content-addressed storage for complete pre-render Tool Results. */
export class FileToolResultArchive implements ToolResultArchivePort {
  private readonly directory: string;
  private readonly locatorRoot: string;
  private readonly now: () => Date;
  private readonly temporaryId: () => string;

  constructor(options: FileToolResultArchiveOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.directory !== "string" ||
      options.directory.trim().length === 0
    ) {
      throw new Error("FileToolResultArchive requires a directory");
    }
    this.directory = resolve(options.directory);
    this.locatorRoot = resolve(options.locatorRoot ?? options.directory);
    const relativeDirectory = relative(this.locatorRoot, this.directory);
    if (
      relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${sep}`) ||
      isAbsolute(relativeDirectory)
    ) {
      throw new Error("Tool Result archive directory must be inside locatorRoot");
    }
    this.now = options.now ?? (() => new Date());
    this.temporaryId = options.temporaryId ?? (() => randomUUID());
  }

  async archive(
    input: ToolResultArchiveInput,
  ): Promise<ToolResultArchiveReference> {
    throwIfAborted(input.signal);
    const snapshot = snapshotInput(input);
    const serializedResult = stableJson(snapshot.result);
    const resultSha256 = sha256(serializedResult);
    const sessionDirectory = join(
      this.directory,
      `session-${sha256(snapshot.sessionId)}`,
    );
    const callIdentity = sha256(stableJson({
      runId: snapshot.runId,
      userTurnId: snapshot.userTurnId,
      stepId: snapshot.stepId,
      toolCallId: snapshot.result.callId,
    }));
    const filePath = join(
      sessionDirectory,
      `${callIdentity}-${resultSha256}.json`,
    );
    const reference = Object.freeze({
      locator: archiveLocator(this.locatorRoot, filePath),
      hash: resultSha256,
    });

    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    throwIfAborted(input.signal);
    if (await validateExisting(filePath, snapshot, serializedResult, resultSha256)) {
      throwIfAborted(input.signal);
      return reference;
    }

    const createdAt = timestamp(this.now());
    const record: StoredToolResultArchiveRecord = Object.freeze({
      schemaVersion: 1,
      type: "tool_result_archive",
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      userTurnId: snapshot.userTurnId,
      stepId: snapshot.stepId,
      result: snapshot.result,
      resultSha256,
      createdAt,
    });
    const temporaryPath = join(
      sessionDirectory,
      `.tmp-${safeTemporaryId(this.temporaryId())}.json`,
    );
    let temporaryExists = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryExists = true;
      try {
        await handle.writeFile(`${stableJson(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      throwIfAborted(input.signal);
      await rename(temporaryPath, filePath);
      temporaryExists = false;
      await syncDirectory(sessionDirectory);
    } finally {
      if (temporaryExists) {
        try {
          await rm(temporaryPath, { force: true });
        } catch {
          // Preserve the authoritative archive failure.
        }
      }
    }
    throwIfAborted(input.signal);
    return reference;
  }
}

interface ToolResultArchiveSnapshot {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly result: ToolResult;
}

function snapshotInput(input: ToolResultArchiveInput): ToolResultArchiveSnapshot {
  if (input === null || typeof input !== "object") {
    throw new Error("Tool Result archive input must be an object");
  }
  const result = snapshotJsonValue(input.result, "Tool Result") as ToolResult;
  if (result === null || typeof result !== "object") {
    throw new Error("Tool Result archive requires a Tool Result");
  }
  requireIdentifier(result.callId, "Tool Result callId");
  requireIdentifier(result.toolName, "Tool Result toolName");
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "Tool Result sessionId"),
    runId: requireIdentifier(input.runId, "Tool Result runId"),
    userTurnId: requireIdentifier(input.userTurnId, "Tool Result userTurnId"),
    stepId: requireIdentifier(input.stepId, "Tool Result stepId"),
    result,
  });
}

async function validateExisting(
  filePath: string,
  expected: ToolResultArchiveSnapshot,
  serializedResult: string,
  resultSha256: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error("Existing Tool Result archive is corrupted", { cause: error });
  }
  if (!isPlainRecord(parsed)) {
    throw new Error("Existing Tool Result archive is not an object");
  }
  if (
    parsed.schemaVersion !== 1 ||
    parsed.type !== "tool_result_archive" ||
    parsed.sessionId !== expected.sessionId ||
    parsed.runId !== expected.runId ||
    parsed.userTurnId !== expected.userTurnId ||
    parsed.stepId !== expected.stepId ||
    parsed.resultSha256 !== resultSha256 ||
    stableJson(parsed.result) !== serializedResult ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Existing Tool Result archive does not match its identity");
  }
  return true;
}

function archiveLocator(locatorRoot: string, filePath: string): string {
  const locator = relative(locatorRoot, filePath);
  if (
    locator.length === 0 ||
    locator === ".." ||
    locator.startsWith(`..${sep}`) ||
    isAbsolute(locator)
  ) {
    throw new Error("Tool Result archive locator escapes locatorRoot");
  }
  return locator.split(sep).join("/");
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
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
    ancestors.add(value);
    const snapshot = value.map((entry, index) => {
      if (entry === undefined) {
        throw new Error(`${label}[${index}] must be JSON serializable`);
      }
      return snapshotJsonValue(entry, `${label}[${index}]`, ancestors);
    });
    ancestors.delete(value);
    return Object.freeze(snapshot);
  }
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
    ancestors.add(value);
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if (entry === undefined) {
          throw new Error(`${label}.${key} must be JSON serializable`);
        }
        return [key, snapshotJsonValue(entry, `${label}.${key}`, ancestors)] as const;
      });
    ancestors.delete(value);
    return Object.freeze(Object.fromEntries(entries));
  }
  throw new Error(`${label} must be JSON serializable`);
}

function stableJson(value: unknown): string {
  const json = JSON.stringify(snapshotJsonValue(value, "Archive value"));
  if (json === undefined) throw new Error("Archive value must be JSON serializable");
  return json;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("FileToolResultArchive clock returned an invalid Date");
  }
  return value.toISOString();
}

function safeTemporaryId(value: string): string {
  const id = requireIdentifier(value, "Tool Result archive temporary id");
  const safe = id.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 120);
  if (safe.length === 0) throw new Error("Tool Result archive temporary id is unsafe");
  return safe;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Tool Result archive was aborted", { cause: signal.reason });
}
