import type { StorageBackendResolver } from "../storage/backend.js";
import {
  PERMISSION_PROFILES,
  type PermissionProfile,
} from "../permissions/types.js";
import {
  StorageDomain,
  type DomainReadResult,
  type DomainSpec,
  type ResolvedStorageDomain,
} from "../storage/domain.js";
import { KV_ABSENT, type KvPrecondition } from "../storage/kv.js";
import { SubagentClosedError, SubagentConflictError } from "./errors.js";
import { snapshotResult } from "./files.js";
import type { SubagentRecord, SubagentRecordStore } from "./types.js";
import { snapshotChildCapabilities } from "./identity.js";

const SUBAGENT_DOMAIN_ID = "subagents/records";
const DEFAULT_MAX_RECORDS = 4_096;

interface SubagentState {
  readonly schemaVersion: 1;
  readonly records: readonly SubagentRecord[];
}

const EMPTY_STATE: SubagentState = Object.freeze({
  schemaVersion: 1 as const,
  records: Object.freeze([]),
});

export const subagentDomain: DomainSpec<void, SubagentState> = Object.freeze({
  id: SUBAGENT_DOMAIN_ID,
  schemaVersion: 1,
  shape: "global" as const,
  requirements: Object.freeze({ kv: Object.freeze({ list: false }) }),
  resolve() {
    return Object.freeze({
      default: Object.freeze({ kind: "value" as const, value: EMPTY_STATE }),
    });
  },
  encode(value: SubagentState): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(payload: Uint8Array): unknown {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  },
  validate(value: unknown): SubagentState {
    return snapshotState(value);
  },
});

export interface MemorySubagentRecordStoreOptions {
  readonly maxRecords?: number;
}

export class MemorySubagentRecordStore implements SubagentRecordStore {
  private readonly records = new Map<string, SubagentRecord>();
  private readonly maxRecords: number;
  private closed = false;

  constructor(options: MemorySubagentRecordStoreOptions = {}) {
    this.maxRecords = positiveInteger(
      options.maxRecords ?? DEFAULT_MAX_RECORDS,
      "Subagent max records",
    );
  }

  async create(record: SubagentRecord, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    throwIfAborted(signal);
    const stable = snapshotRecord(record);
    if (this.records.has(stable.id)) {
      throw new SubagentConflictError(`Subagent ${stable.id} already exists`);
    }
    if (this.records.size >= this.maxRecords) {
      throw new SubagentConflictError(
        `Subagent store exceeds the ${this.maxRecords} record limit`,
      );
    }
    this.records.set(stable.id, stable);
  }

  async replace(record: SubagentRecord, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    throwIfAborted(signal);
    const stable = snapshotRecord(record);
    if (!this.records.has(stable.id)) {
      throw new SubagentConflictError(`Subagent ${stable.id} does not exist`);
    }
    this.records.set(stable.id, stable);
  }

  async get(id: string, signal?: AbortSignal): Promise<SubagentRecord | undefined> {
    this.assertOpen();
    throwIfAborted(signal);
    return this.records.get(requireText(id, "Subagent id"));
  }

  async list(signal?: AbortSignal): Promise<readonly SubagentRecord[]> {
    this.assertOpen();
    throwIfAborted(signal);
    return Object.freeze([...this.records.values()]);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new SubagentClosedError();
  }
}

export interface DomainSubagentRecordStoreOptions {
  readonly storage: StorageBackendResolver;
  readonly backendId: string;
  readonly maxRecords?: number;
}

/** Durable record store. Live process truth is reconciled by the execution Provider. */
export class DomainSubagentRecordStore implements SubagentRecordStore {
  private readonly domain: ResolvedStorageDomain<SubagentState>;
  private readonly maxRecords: number;
  private cached: DomainReadResult<SubagentState> | undefined;
  private tail = Promise.resolve();
  private closed = false;

  constructor(options: DomainSubagentRecordStoreOptions) {
    this.maxRecords = positiveInteger(
      options.maxRecords ?? DEFAULT_MAX_RECORDS,
      "Subagent max records",
    );
    this.domain = new StorageDomain({
      storage: options.storage,
      backendId: options.backendId,
      spec: subagentDomain,
    }).resolve(undefined);
  }

  create(record: SubagentRecord, signal?: AbortSignal): Promise<void> {
    const stable = snapshotRecord(record);
    return this.serial(async () => {
      throwIfAborted(signal);
      const current = await this.state(signal);
      if (current.value.records.some((item) => item.id === stable.id)) {
        throw new SubagentConflictError(`Subagent ${stable.id} already exists`);
      }
      if (current.value.records.length >= this.maxRecords) {
        throw new SubagentConflictError(
          `Subagent store exceeds the ${this.maxRecords} record limit`,
        );
      }
      await this.save([...current.value.records, stable], current, signal);
    });
  }

  replace(record: SubagentRecord, signal?: AbortSignal): Promise<void> {
    const stable = snapshotRecord(record);
    return this.serial(async () => {
      throwIfAborted(signal);
      const current = await this.state(signal);
      const index = current.value.records.findIndex((item) => item.id === stable.id);
      if (index < 0) {
        throw new SubagentConflictError(`Subagent ${stable.id} does not exist`);
      }
      const records = [...current.value.records];
      records[index] = stable;
      await this.save(records, current, signal);
    });
  }

  async get(id: string, signal?: AbortSignal): Promise<SubagentRecord | undefined> {
    this.assertOpen();
    throwIfAborted(signal);
    await this.tail;
    return (await this.state(signal)).value.records.find(
      (item) => item.id === requireText(id, "Subagent id"),
    );
  }

  async list(signal?: AbortSignal): Promise<readonly SubagentRecord[]> {
    this.assertOpen();
    throwIfAborted(signal);
    await this.tail;
    return (await this.state(signal)).value.records;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
  }

  private async state(signal?: AbortSignal): Promise<DomainReadResult<SubagentState>> {
    this.assertOpen();
    if (this.cached !== undefined) return this.cached;
    const loaded = await this.domain.load(signal);
    if (loaded === undefined) throw new Error("Subagent Domain unexpectedly resolved absent");
    if (loaded.value.records.length > this.maxRecords) {
      throw new SubagentConflictError(
        `Subagent store exceeds the ${this.maxRecords} record limit`,
      );
    }
    return this.cached = loaded;
  }

  private async save(
    records: readonly SubagentRecord[],
    current: DomainReadResult<SubagentState>,
    signal?: AbortSignal,
  ): Promise<void> {
    this.cached = await this.domain.save(
      snapshotState({ schemaVersion: 1, records }),
      precondition(current),
      signal,
    );
  }

  private serial<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.assertOpen();
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new SubagentClosedError();
  }
}

function snapshotState(value: unknown): SubagentState {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((value as { records?: unknown }).records)
  ) throw new TypeError("Subagent state is invalid");
  const records = (value as { records: readonly unknown[] }).records.map(snapshotRecord);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new TypeError("Subagent state contains duplicate ids");
  }
  return Object.freeze({ schemaVersion: 1 as const, records: Object.freeze(records) });
}

export function snapshotRecord(value: unknown): SubagentRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Subagent record is invalid");
  }
  const record = value as Partial<SubagentRecord>;
  if (record.schemaVersion !== 1 || !SUBAGENT_STATUSES.has(record.status!)) {
    throw new TypeError("Subagent record shape is invalid");
  }
  const createdAt = timestamp(record.createdAt, "Subagent createdAt");
  const updatedAt = timestamp(record.updatedAt, "Subagent updatedAt");
  if (record.resourceManifestDigest !== undefined && !/^[a-f0-9]{64}$/u.test(record.resourceManifestDigest)) throw new TypeError("Invalid Subagent resource manifest digest");
  return Object.freeze({
    schemaVersion: 1 as const,
    ...(record.resourceManifestDigest === undefined ? {} : { resourceManifestDigest: record.resourceManifestDigest }),
    id: requireText(record.id, "Subagent id"),
    parentAgentId: requireText(record.parentAgentId, "Subagent parent Agent id"),
    parentSessionId: requireText(record.parentSessionId, "Subagent parent Session id"),
    parentRunId: requireText(record.parentRunId, "Subagent parent Run id"),
    childSessionId: requireText(record.childSessionId, "Subagent child Session id"),
    childRunId: requireText(record.childRunId, "Subagent child Run id"),
    workspaceRoot: requireText(record.workspaceRoot, "Subagent workspace root"),
    role: requireText(record.role, "Subagent role"),
    task: requireText(record.task, "Subagent task"),
    ...(record.allowedCapabilities === undefined ? {} : { allowedCapabilities: snapshotChildCapabilities(record.allowedCapabilities) }),
    ...(record.model === undefined ? {} : { model: requireText(record.model, "Subagent model") }),
    ...(record.permissionProfile === undefined
      ? {}
      : { permissionProfile: permissionProfile(record.permissionProfile) }),
    ...(record.availableTools === undefined ? {} : {
      availableTools: toolNames(record.availableTools),
    }),
    status: record.status!,
    ...(record.target === undefined ? {} : { target: snapshotTarget(record.target) }),
    createdAt,
    updatedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: timestamp(record.endedAt, "Subagent endedAt") }),
    ...(record.exitCode === undefined ? {} : { exitCode: nonNegativeInteger(record.exitCode, "Subagent exit code") }),
    ...(record.failure === undefined ? {} : { failure: requireText(record.failure, "Subagent failure") }),
    ...(record.result === undefined ? {} : { result: snapshotResult(record.result) }),
  });
}

const SUBAGENT_STATUSES = new Set([
  "starting", "running", "exited", "stopped", "failed", "lost",
]);

function snapshotTarget(target: NonNullable<SubagentRecord["target"]>): NonNullable<SubagentRecord["target"]> {
  return Object.freeze({
    providerId: requireText(target.providerId, "Subagent execution Provider id"),
    id: requireText(target.id, "Subagent execution target id"),
    target: requireText(target.target, "Subagent execution target"),
    attachCommand: requireText(target.attachCommand, "Subagent attach command"),
    captureCommand: requireText(target.captureCommand, "Subagent capture command"),
    locator: snapshotLocator(target.locator),
  });
}

function snapshotLocator(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Subagent execution locator must be an object");
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([name, item]) => [
    requireText(name, "Subagent execution locator name"),
    requireText(item, `Subagent execution locator ${name}`),
  ])));
}

function precondition(state: DomainReadResult<SubagentState>): KvPrecondition {
  return state.persisted
    ? Object.freeze({ kind: "revision" as const, revision: state.revision! })
    : KV_ABSENT;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function permissionProfile(value: unknown): PermissionProfile {
  if (!(PERMISSION_PROFILES as readonly unknown[]).includes(value)) {
    throw new TypeError("Subagent permission profile is invalid");
  }
  return value as PermissionProfile;
}

function toolNames(value: readonly unknown[]): readonly string[] {
  const tools = value.map((tool) => requireText(tool, "Subagent Tool"));
  if (new Set(tools).size !== tools.length) {
    throw new TypeError("Subagent Tools must not contain duplicates");
  }
  return Object.freeze(tools);
}

function timestamp(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} is invalid`);
  return text;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be non-negative`);
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
