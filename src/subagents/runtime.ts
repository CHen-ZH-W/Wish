import { randomUUID } from "node:crypto";
import { subagentIdForKey } from "./identity.js";
import { snapshotChildCapabilities } from "./identity.js";

import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { PERMISSION_PROFILES, type PermissionProfile } from "../permissions/types.js";
import { registerPluginOwner } from "../boot/plugin-control/owner-registry.js";
import type { StorageBackendLease } from "../storage/backend.js";
import {
  SubagentClosedError,
  SubagentLimitExceededError,
  SubagentNotFoundError,
  SubagentNotRunningError,
} from "./errors.js";
import { SubagentsService } from "./service.js";
import { DomainSubagentRecordStore } from "./store.js";
import type { SubagentExecutionProvider } from "./execution.js";
import type {
  CaptureSubagentRequest,
  CollectedSubagent,
  CollectSubagentRequest,
  InspectSubagentRequest,
  ListSubagentsRequest,
  ObserveSessionSubagentsRequest,
  SendSubagentRequest,
  SpawnSubagentRequest,
  StopSubagentRequest,
  SubagentLaunchIdentity,
  SubagentLauncher,
  SubagentExecutionSnapshot,
  SubagentEvent,
  SubagentEventListener,
  SubagentOwner,
  SubagentRecord,
  SubagentRecordStore,
  SubagentResultReader,
  Subagents,
} from "./types.js";

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_CONCURRENT_PER_RUN = 2;

export interface SubagentRuntimeOptions {
  readonly execution: SubagentExecutionProvider;
  readonly store: SubagentRecordStore;
  readonly launcher: SubagentLauncher;
  readonly maxConcurrent?: number;
  readonly maxConcurrentPerRun?: number;
  readonly id?: () => string;
  readonly childSessionId?: (id: string) => string;
  readonly childRunId?: (id: string) => string;
  readonly results?: SubagentResultReader;
  readonly now?: () => Date;
  readonly monitorIntervalMs?: number;
}

/** Semantic child lifecycle backed by durable records and an execution Port. */
export class SubagentRuntime implements Subagents {
  private readonly execution: SubagentExecutionProvider;
  private readonly store: SubagentRecordStore;
  private readonly launcher: SubagentLauncher;
  private readonly maxConcurrent: number;
  private readonly maxConcurrentPerRun: number;
  private readonly nextId: () => string;
  private readonly nextChildSessionId: (id: string) => string;
  private readonly nextChildRunId: (id: string) => string;
  private readonly results: SubagentResultReader | undefined;
  private readonly now: () => Date;
  private readonly monitorIntervalMs: number;
  private readonly listeners = new Set<SubagentEventListener>();
  private readonly monitorAbort = new AbortController();
  private readonly monitors = new Map<string, Promise<void>>();
  private tail = Promise.resolve();
  private closed = false;
  private observationPaused = false;
  private closing: Promise<void> | undefined;
  private readonly observations = new Set<Promise<unknown>>();
  private pendingOperations = 0;

  constructor(options: SubagentRuntimeOptions) {
    this.execution = options.execution;
    this.store = options.store;
    this.launcher = options.launcher;
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      "Subagent maxConcurrent",
    );
    this.maxConcurrentPerRun = positiveInteger(
      options.maxConcurrentPerRun ?? DEFAULT_MAX_CONCURRENT_PER_RUN,
      "Subagent maxConcurrentPerRun",
    );
    this.nextId = options.id ?? randomUUID;
    this.nextChildSessionId = options.childSessionId ?? ((id) => `subagent-${id}`);
    this.nextChildRunId = options.childRunId ?? ((id) => `subagent-run-${id}`);
    this.results = options.results;
    this.now = options.now ?? (() => new Date());
    this.monitorIntervalMs = positiveInteger(
      options.monitorIntervalMs ?? 250,
      "Subagent monitor interval",
    );
  }

  spawn(request: SpawnSubagentRequest): Promise<SubagentRecord> {
    const input = normalizeSpawn(request);
    return this.serial(async () => {
      const records = await this.refreshAll(input.signal);
      const id = input.idempotencyKey === undefined ? identifier(this.nextId(), "Subagent id factory") : subagentIdForKey(input.idempotencyKey);
      const existing = records.find(record => record.id === id);
      if (existing) {
        if (!input.idempotencyKey || !ownedBy(existing, input) || existing.task !== input.task || existing.role !== input.role ||
            existing.model !== input.model || existing.permissionProfile !== input.permissionProfile ||
            JSON.stringify(existing.availableTools) !== JSON.stringify(input.availableTools) ||
            JSON.stringify(existing.allowedCapabilities) !== JSON.stringify(input.allowedCapabilities)) throw new Error("Subagent idempotency conflict");
        return existing;
      }
      const running = records.filter(isLive);
      if (running.length >= this.maxConcurrent) {
        throw new SubagentLimitExceededError(
          `Subagent concurrency limit ${this.maxConcurrent} was reached`,
        );
      }
      if (running.filter((record) => record.parentRunId === input.parentRunId).length >=
        this.maxConcurrentPerRun) {
        throw new SubagentLimitExceededError(
          `Parent Run ${input.parentRunId} reached its Subagent concurrency limit ${this.maxConcurrentPerRun}`,
        );
      }

      const childSessionId = identifier(
        this.nextChildSessionId(id),
        "Subagent child Session id factory",
      );
      const childRunId = identifier(
        this.nextChildRunId(id),
        "Subagent child Run id factory",
      );
      const timestamp = this.timestamp();
      let record: SubagentRecord = Object.freeze({
        schemaVersion: 1 as const,
        id,
        parentAgentId: input.parentAgentId,
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        childSessionId,
        childRunId,
        workspaceRoot: input.workspaceRoot,
        role: input.role,
        task: input.task,
        ...(input.allowedCapabilities === undefined ? {} : { allowedCapabilities: input.allowedCapabilities }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.permissionProfile === undefined
          ? {}
          : { permissionProfile: input.permissionProfile }),
        ...(input.availableTools === undefined
          ? {}
          : { availableTools: input.availableTools }),
        status: "starting" as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.store.create(record, input.signal);
      try {
        const identity: SubagentLaunchIdentity = Object.freeze({
          id,
          childSessionId,
          childRunId,
        });
        const launch = await this.launcher.resolve(input, identity);
        let session: SubagentExecutionSnapshot;
        try {
          if (launch.resourceManifestDigest !== undefined) {
            if (!/^[a-f0-9]{64}$/u.test(launch.resourceManifestDigest)) throw new Error("Invalid Subagent resource manifest digest");
            record = Object.freeze({ ...record, resourceManifestDigest: launch.resourceManifestDigest });
            await this.store.replace(record, input.signal);
          }
          session = await this.execution.start({
            id,
            role: launch.windowName ?? input.role,
            workspaceRoot: input.workspaceRoot,
            command: launch.command,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        } catch (error: unknown) {
          await launch.cleanupOnFailure?.();
          throw error;
        }
        record = Object.freeze({
          ...record,
          status: session.active ? "running" as const : "exited" as const,
          target: session.target,
          updatedAt: this.timestamp(),
          ...(!session.active ? { endedAt: this.timestamp() } : {}),
          ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
        });
        await this.store.replace(record, input.signal);
        this.publish(record);
        if (isLive(record)) this.monitor(record.id);
        return record;
      } catch (error: unknown) {
        const failed = Object.freeze({
          ...record,
          status: "failed" as const,
          updatedAt: this.timestamp(),
          endedAt: this.timestamp(),
          failure: errorMessage(error),
        });
        await this.store.replace(failed).catch(() => undefined);
        this.publish(failed);
        throw error;
      }
    });
  }

  async list(request: ListSubagentsRequest): Promise<readonly SubagentRecord[]> {
    const owner = normalizeOwner(request);
    return this.serial(async () => {
      throwIfAborted(request.signal);
      const records = await this.refreshAll(request.signal);
      return Object.freeze(records.filter((record) => ownedBy(record, owner) &&
        (request.status === undefined || record.status === request.status)));
    });
  }
  async observeSession(request: ObserveSessionSubagentsRequest): Promise<readonly SubagentRecord[]> {
    const agent = identifier(request.parentAgentId, "Subagent parent Agent id"), session = identifier(request.parentSessionId, "Subagent parent Session id"), workspace = identifier(request.workspaceRoot, "Subagent Workspace root");
    return this.observe(async () => {
      throwIfAborted(request.signal);
      const records = await this.store.list(request.signal);
      throwIfAborted(request.signal);
      return Object.freeze(records.filter(record => record.parentAgentId === agent && record.parentSessionId === session && record.workspaceRoot === workspace));
    });
  }

  /** Stored record facts, not live process discovery; intentionally does not refresh. */
  async lifecycleSnapshot(signal?: AbortSignal): Promise<{
    readonly closed: boolean; readonly pendingOperations: number; readonly monitors: number;
    readonly liveRecords: number; readonly unresolvedRecords: number;
  }> {
    return this.observe(async () => {
      throwIfAborted(signal);
      const records = await this.store.list(signal);
      throwIfAborted(signal);
      return Object.freeze({ closed: this.closed, pendingOperations: this.pendingOperations, monitors: this.monitors.size,
        liveRecords: records.filter(isLive).length,
        // Missing target data is not proof that a failed launch had no side effects.
        unresolvedRecords: records.filter(record => record.status === "lost" || record.status === "failed").length });
    });
  }

  async inspect(request: InspectSubagentRequest, observation?: {
    execution: Pick<SubagentExecutionProvider, "inspect">; results?: SubagentResultReader;
  }): Promise<SubagentRecord | undefined> {
    const owner = normalizeOwner(request);
    return this.serial(async () => {
      throwIfAborted(request.signal);
      const record = await this.store.get(identifier(request.id, "Subagent id"), request.signal);
      if (record === undefined || !ownedBy(record, owner)) return undefined;
      return this.refresh(record, request.signal, observation);
    });
  }

  async capture(request: CaptureSubagentRequest): Promise<string> {
    return this.serial(async () => {
      const record = await this.required(request);
      if (record.target === undefined) throw new SubagentNotRunningError(record.id);
      return this.execution.capture({
        target: record.target,
        ...(request.lines === undefined ? {} : { lines: request.lines }),
        ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    });
  }

  async send(request: SendSubagentRequest): Promise<void> {
    return this.serial(async () => {
      const record = await this.required(request);
      if (record.status !== "running" || record.target === undefined) throw new SubagentNotRunningError(record.id);
      await this.execution.send({
        target: record.target,
        text: request.text,
        ...(request.enter === undefined ? {} : { enter: request.enter }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    });
  }

  stop(request: StopSubagentRequest): Promise<SubagentRecord> {
    const id = identifier(request.id, "Subagent id");
    return this.serial(async () => {
      const record = await this.required({ ...request, id });
      if (record.status === "stopped") return record;
      if (record.target !== undefined) {
        await this.execution.stop(record.target, request.signal);
      }
      const stopped = Object.freeze({
        ...record,
        status: "stopped" as const,
        updatedAt: this.timestamp(),
        endedAt: record.endedAt ?? this.timestamp(),
      });
      await this.store.replace(stopped, request.signal);
      this.publish(stopped);
      return stopped;
    });
  }

  async collect(request: CollectSubagentRequest): Promise<CollectedSubagent> {
    return this.serial(async () => {
      const record = await this.required(request);
      let output: string | undefined;
      if (record.target !== undefined) {
        try {
          output = await this.execution.capture({
            target: record.target,
            ...(request.lines === undefined ? {} : { lines: request.lines }),
            ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
        } catch {
          // A lost execution target is already represented in the refreshed record.
        }
      }
      return Object.freeze({ record, ...(output === undefined ? {} : { output }) });
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.listeners.clear();
    this.monitorAbort.abort("Subagent Runtime closed");
    return this.closing = (async () => {
      await Promise.allSettled([...this.monitors.values(), ...this.observations, this.tail]);
      await this.store.close();
    })();
  }

  subscribe(listener: SubagentEventListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /** Reconcile durable live records and resume process-local completion watches. */
  async resume(signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      throwIfAborted(signal);
      const records = await this.refreshAll(signal);
      for (const record of records) if (isLive(record)) this.monitor(record.id);
    });
  }
  /** Provider admission is already fenced. Let existing observations finish,
   * including timer waits; do not abort commands or kill independent children.
   */
  pauseObservation(): { drained: Promise<void>; release(): Promise<void> } {
    this.assertOpen(); this.observationPaused = true;
    return { drained: Promise.allSettled([...this.monitors.values(), ...this.observations, this.tail]).then(() => {}),
      release: async () => { if (!this.closed) { this.observationPaused = false; await this.resume(); } } };
  }

  private async required(
    request: InspectSubagentRequest,
  ): Promise<SubagentRecord> {
    // Only called from already admitted serial work; joining tail here deadlocks.
    const owner = normalizeOwner(request);
    const id = identifier(request.id, "Subagent id");
    const record = await this.store.get(id, request.signal);
    if (record === undefined || !ownedBy(record, owner)) {
      throw new SubagentNotFoundError(id);
    }
    return this.refresh(record, request.signal);
  }

  private async refreshAll(signal?: AbortSignal): Promise<SubagentRecord[]> {
    const records = await this.store.list(signal);
    const refreshed: SubagentRecord[] = [];
    for (const record of records) refreshed.push(await this.refresh(record, signal));
    refreshed.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
    return refreshed;
  }

  private async refresh(
    record: SubagentRecord,
    signal?: AbortSignal,
    observation: { execution: Pick<SubagentExecutionProvider, "inspect">; results?: SubagentResultReader } = {
      execution: this.execution, ...(this.results ? { results: this.results } : {}),
    },
  ): Promise<SubagentRecord> {
    const session = isLive(record) && record.target !== undefined
      ? await observation.execution.inspect(record.target, signal)
      : undefined;
    let next = session === undefined && (!isLive(record) || record.target === undefined)
      ? record
      : reconcile(record, session, this.timestamp());
    const result = await observation.results?.read(record.id, signal);
    if (result !== undefined && JSON.stringify(next.result) !== JSON.stringify(result)) {
      if (
        result.childSessionId !== record.childSessionId ||
        result.childRunId !== record.childRunId
      ) throw new Error(`Subagent result identity does not match ${record.id}`);
      next = Object.freeze({ ...next, result, updatedAt: this.timestamp() });
    }
    if (next === record) return record;
    await this.store.replace(next, signal);
    this.publish(next);
    return next;
  }

  private monitor(id: string): void {
    if (this.monitors.has(id) || this.closed || this.observationPaused) return;
    const signal = this.monitorAbort.signal;
    const completion = (async () => {
      while (!signal.aborted) {
        await delay(this.monitorIntervalMs, signal);
        if (this.observationPaused) return;
        const record = await this.serial(async () => {
          const current = await this.store.get(id, signal);
          return current === undefined ? undefined : this.refresh(current, signal);
        });
        if (record === undefined || !isLive(record) || record.result !== undefined) return;
      }
    })().catch((error: unknown) => {
      if (!signal.aborted) {
        const message = errorMessage(error);
        void this.serial(async () => {
          const record = await this.store.get(id);
          if (record === undefined || !isLive(record)) return;
          const failed = Object.freeze({
            ...record,
            status: "failed" as const,
            failure: `Subagent monitor failed: ${message}`,
            updatedAt: this.timestamp(),
            endedAt: this.timestamp(),
          });
          await this.store.replace(failed);
          this.publish(failed);
        }).catch(() => undefined);
      }
    }).finally(() => this.monitors.delete(id));
    this.monitors.set(id, completion);
  }

  private publish(record: SubagentRecord): void {
    if (this.closed) return;
    const event: SubagentEvent = Object.freeze({
      type: "subagent.updated" as const,
      occurredAt: this.timestamp(),
      record,
    });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Diagnostic observers never change lifecycle decisions.
      }
    }
  }

  private serial<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.assertOpen();
    this.pendingOperations += 1;
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result.then(() => { this.pendingOperations -= 1; }, () => { this.pendingOperations -= 1; });
    return result;
  }

  /** Read-only observers drain on close without becoming execution admission counts. */
  private observe<Value>(read: () => Promise<Value>): Promise<Value> {
    this.assertOpen();
    const result = Promise.resolve().then(read);
    this.observations.add(result);
    void result.then(() => this.observations.delete(result), () => this.observations.delete(result));
    return result;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Subagent clock must return a valid Date");
    }
    return value.toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new SubagentClosedError();
  }
}

function reconcile(
  record: SubagentRecord,
  session: SubagentExecutionSnapshot | undefined,
  timestamp: string,
): SubagentRecord {
  if (session?.active === true) {
    if (
      record.status === "running" &&
      record.target !== undefined &&
      sameTarget(record.target, session.target)
    ) return record;
    return Object.freeze({
      ...record,
      status: "running" as const,
      target: session.target,
      updatedAt: timestamp,
    });
  }
  if (session === undefined) {
    return Object.freeze({
      ...record,
      status: "lost" as const,
      updatedAt: timestamp,
      endedAt: timestamp,
    });
  }
  return Object.freeze({
    ...record,
    status: "exited" as const,
    target: session.target,
    updatedAt: timestamp,
    endedAt: timestamp,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
  });
}

function isLive(record: SubagentRecord): boolean {
  return record.status === "starting" || record.status === "running";
}

function normalizeSpawn(request: SpawnSubagentRequest): SpawnSubagentRequest & { role: string } {
  if (request === null || typeof request !== "object") {
    throw new TypeError("Spawn Subagent request must be an object");
  }
  return Object.freeze({
    ...(request.allowedCapabilities === undefined ? {} : { allowedCapabilities: snapshotChildCapabilities(request.allowedCapabilities) }),
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: identifier(request.idempotencyKey, "Subagent dispatch key") }),
    parentAgentId: identifier(request.parentAgentId, "Subagent parent Agent id"),
    parentSessionId: identifier(request.parentSessionId, "Subagent parent Session id"),
    parentRunId: identifier(request.parentRunId, "Subagent parent Run id"),
    workspaceRoot: identifier(request.workspaceRoot, "Subagent workspace root"),
    task: text(request.task, "Subagent task"),
    role: identifier(request.role ?? "worker", "Subagent role"),
    ...(request.model === undefined ? {} : { model: identifier(request.model, "Subagent model") }),
    ...(request.modelsConfiguration === undefined
      ? {}
      : { modelsConfiguration: request.modelsConfiguration }),
    ...(request.permissionProfile === undefined
      ? {}
      : { permissionProfile: permissionProfile(request.permissionProfile) }),
    ...(request.availableTools === undefined ? {} : {
      availableTools: toolNames(request.availableTools),
    }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function normalizeOwner(owner: SubagentOwner): SubagentOwner {
  if (owner === null || typeof owner !== "object") {
    throw new TypeError("Subagent owner must be an object");
  }
  return Object.freeze({
    parentAgentId: identifier(owner.parentAgentId, "Subagent parent Agent id"),
    parentSessionId: identifier(owner.parentSessionId, "Subagent parent Session id"),
    parentRunId: identifier(owner.parentRunId, "Subagent parent Run id"),
    workspaceRoot: identifier(owner.workspaceRoot, "Subagent workspace root"),
  });
}

function ownedBy(record: SubagentRecord, owner: SubagentOwner): boolean {
  return record.parentAgentId === owner.parentAgentId &&
    record.parentSessionId === owner.parentSessionId &&
    record.parentRunId === owner.parentRunId &&
    record.workspaceRoot === owner.workspaceRoot;
}

function sameTarget(
  left: NonNullable<SubagentRecord["target"]>,
  right: NonNullable<SubagentRecord["target"]>,
): boolean {
  return left.providerId === right.providerId &&
    left.id === right.id &&
    left.target === right.target &&
    JSON.stringify(left.locator) === JSON.stringify(right.locator);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
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
  const tools = value.map((tool) => identifier(tool, "Subagent Tool"));
  if (new Set(tools).size !== tools.length) {
    throw new TypeError("Subagent Tools must not contain duplicates");
  }
  return Object.freeze(tools);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Config {
  readonly backendId?: string;
  readonly maxRecords?: number;
  readonly maxConcurrent?: number;
  readonly maxConcurrentPerRun?: number;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
  maxRecords: s.number().step(1).min(1),
  maxConcurrent: s.number().step(1).min(1),
  maxConcurrentPerRun: s.number().step(1).min(1),
});

/** Cordis domain runtime; Providers contribute execution and launch adapters. */
export class SubagentsRuntimeService extends SubagentsService {
  static readonly inject = [
    "subagentExecution",
    "storageBackend",
  ];
  static readonly Config = Config;

  private readonly lease: StorageBackendLease;
  private readonly backend: SubagentRuntime;
  private closing: Promise<void> | undefined;
  private readonly requests = new Set<Promise<unknown>>();
  private suspended = false;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: false } });
    try {
      this.backend = new SubagentRuntime({
        execution: ctx.subagentExecution,
        store: new DomainSubagentRecordStore({
          storage: this.lease,
          backendId,
          ...(config.maxRecords === undefined ? {} : { maxRecords: config.maxRecords }),
        }),
        launcher: {
          resolve: (request, identity) => {
            const launcher = ctx.get("subagentLauncher");
            if (!launcher) throw new Error("Subagent launch capability is unavailable");
            return launcher.resolve(request, identity);
          },
        },
        results: {
          read: async (id, signal) => ctx.get("subagentLauncher")?.readResult(id, signal),
        },
        ...(config.maxConcurrent === undefined ? {} : { maxConcurrent: config.maxConcurrent }),
        ...(config.maxConcurrentPerRun === undefined
          ? {}
          : { maxConcurrentPerRun: config.maxConcurrentPerRun }),
      });
      ctx.effect(() => () => this.close(), "subagents.close");
      registerPluginOwner(ctx, {
        replacement: "drain",
        status: async signal => {
          if (this.closing) return { disposition: "blocked", code: "subagents_closing" };
          const snapshot = await this.backend.lifecycleSnapshot(signal);
          const busy = this.requests.size > 0 || snapshot.pendingOperations > 0 || snapshot.monitors > 0 ||
            snapshot.liveRecords > 0 || snapshot.unresolvedRecords > 0;
          return { disposition: snapshot.closed ? "blocked" : busy ? "drain" : "direct", code: snapshot.closed ? "subagents_closing"
            : busy ? "subagents_unsettled_records" : "subagents_idle",
          counts: { active_requests: this.requests.size, pending_operations: snapshot.pendingOperations, monitors: snapshot.monitors,
            live_records: snapshot.liveRecords, unresolved_records: snapshot.unresolvedRecords } };
        },
        prepare: change => {
          if (this.suspended || this.closing) throw new SubagentClosedError();
          this.suspended = true;
          // Live children belong to the execution Provider. Pause this generation's
          // monitors and drain every admitted API call without stopping or relaunching
          // those children; a successor reconstructs them from durable records.
          const observations = this.backend.pauseObservation();
          return {
            drained: Promise.all([observations.drained, Promise.allSettled([...this.requests])]).then(() => {}),
            deactivate: change.kind === "replace" ? async () => {} : () => this.close(),
            release: () => {
              if (this.closing) return;
              return observations.release().then(() => {
                if (!this.closing) this.suspended = false;
              });
            },
          };
        },
      });
    } catch (error: unknown) {
      this.lease.release();
      throw error;
    }
  }

  async [Service.init](): Promise<void> {
    await this.backend.resume();
  }

  spawn(request: SpawnSubagentRequest): Promise<SubagentRecord> { return this.track(() => this.backend.spawn(request)); }
  list(request: ListSubagentsRequest): Promise<readonly SubagentRecord[]> { return this.track(() => this.backend.list(request)); }
  observeSession(request: ObserveSessionSubagentsRequest): Promise<readonly SubagentRecord[]> { return this.track(() => this.backend.observeSession(request)); }
  inspect(request: InspectSubagentRequest): Promise<SubagentRecord | undefined> {
    // Forward this caller's scope through reconciliation reads. A captured
    // constructor scope is already ACTIVE when a downstream scheduler initializes,
    // and must not be mistaken for business traffic against an uncommitted adapter.
    const caller = this.ctx;
    const launcher = caller.get("subagentLauncher");
    return this.track(() => this.backend.inspect(request, { execution: caller.subagentExecution,
      ...(launcher ? { results: { read: (id, signal) => launcher.readResult(id, signal) } } : {}) }));
  }
  capture(request: CaptureSubagentRequest): Promise<string> { return this.track(() => this.backend.capture(request)); }
  send(request: SendSubagentRequest): Promise<void> { return this.track(() => this.backend.send(request)); }
  stop(request: StopSubagentRequest): Promise<SubagentRecord> { return this.track(() => this.backend.stop(request)); }
  collect(request: CollectSubagentRequest): Promise<CollectedSubagent> { return this.track(() => this.backend.collect(request)); }
  subscribe(listener: SubagentEventListener): () => void {
    if (this.suspended || this.closing) throw new SubagentClosedError();
    return this.backend.subscribe(listener);
  }

  close(): Promise<void> {
    return this.closing ??= this.closeOwnedResources();
  }

  private track<Value>(request: () => Promise<Value>): Promise<Value> {
    if (this.suspended || this.closing) throw new SubagentClosedError();
    const result = request();
    this.requests.add(result);
    void result.then(() => { this.requests.delete(result); }, () => { this.requests.delete(result); });
    return result;
  }

  private async closeOwnedResources(): Promise<void> {
    try {
      await this.backend.close();
    } finally {
      this.lease.release();
    }
  }
}

export default SubagentsRuntimeService;
