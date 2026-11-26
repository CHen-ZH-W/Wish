import type { ModelRef, ModelUsage } from "../core/model/model.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { DOMAIN_ABSENT, StorageDomain, type DomainSpec } from "../storage/domain.js";
import { StorageConflictError } from "../storage/errors.js";
import { TitleJobConflictError, type TitleJob, type TitleJobState, type TitleJobStore } from "./types.js";

export const titleJobDomain: DomainSpec<string, TitleJob> = Object.freeze({
  id: "session-title/jobs",
  schemaVersion: 1,
  shape: "keyed" as const,
  requirements: Object.freeze({ kv: Object.freeze({ list: false }) }),
  resolve(sessionId: string) { return { key: text(sessionId), default: DOMAIN_ABSENT }; },
  encode(job: TitleJob) { return new TextEncoder().encode(JSON.stringify(snapshotTitleJob(job))); },
  decode(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); },
  validate: snapshotTitleJob,
});

export class DomainTitleJobStore implements TitleJobStore {
  private readonly domain: StorageDomain<string, TitleJob>;
  constructor(options: { readonly storage: StorageBackendResolver; readonly backendId: string }) {
    this.domain = new StorageDomain({ ...options, spec: titleJobDomain });
  }
  async get(sessionId: string): Promise<TitleJob | undefined> {
    return (await this.domain.resolve(sessionId).load())?.value;
  }
  async put(job: TitleJob, expectedVersion?: number): Promise<void> {
    const stable = snapshotTitleJob(job);
    const address = this.domain.resolve(stable.sessionId);
    const current = await address.load();
    assertVersion(current?.value, expectedVersion, stable.sessionId);
    try {
      await address.save(stable, current === undefined
        ? { kind: "absent" } : { kind: "revision", revision: current.revision! });
    } catch (error) { throw conflict(error, stable.sessionId); }
  }
  async delete(sessionId: string, expectedVersion: number): Promise<void> {
    const address = this.domain.resolve(sessionId);
    const current = await address.load();
    assertVersion(current?.value, expectedVersion, sessionId);
    try { await address.delete({ kind: "revision", revision: current!.revision! }); }
    catch (error) { throw conflict(error, sessionId); }
  }
}

export class MemoryTitleJobStore implements TitleJobStore {
  private readonly jobs = new Map<string, TitleJob>();
  async get(sessionId: string): Promise<TitleJob | undefined> { return this.jobs.get(sessionId); }
  async put(job: TitleJob, expectedVersion?: number): Promise<void> {
    const stable = snapshotTitleJob(job);
    assertVersion(this.jobs.get(stable.sessionId), expectedVersion, stable.sessionId);
    this.jobs.set(stable.sessionId, stable);
  }
  async delete(sessionId: string, expectedVersion: number): Promise<void> {
    assertVersion(this.jobs.get(sessionId), expectedVersion, sessionId);
    this.jobs.delete(sessionId);
  }
}

export function snapshotTitleJob(value: unknown): TitleJob {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Title job must be an object");
  const job = value as Partial<TitleJob>;
  if (job.schemaVersion !== 1) throw new TypeError("Invalid title job schema");
  const states: readonly TitleJobState[] = ["pending", "running", "retry", "succeeded", "failed", "cancelled"];
  if (!states.includes(job.state!)) throw new TypeError("Invalid title job state");
  const seed = text(job.seed);
  if ([...seed].length > 8000) throw new TypeError("Title seed exceeds the persistence limit");
  if (job.lastError !== undefined && !/^[a-z][a-z0-9_.-]{0,79}$/iu.test(job.lastError)) throw new TypeError("Unsafe title error code");
  return Object.freeze({
    schemaVersion: 1,
    sessionId: text(job.sessionId), jobId: text(job.jobId),
    version: integer(job.version, 1), state: job.state!, seed,
    expectedTitleRevision: integer(job.expectedTitleRevision), attempts: integer(job.attempts),
    nextAttemptAt: integer(job.nextAttemptAt), createdAt: integer(job.createdAt), updatedAt: integer(job.updatedAt),
    ...(job.inputId === undefined ? {} : { inputId: text(job.inputId) }),
    ...(job.model === undefined ? {} : { model: model(job.model) }),
    ...(job.usage === undefined ? {} : { usage: usage(job.usage) }),
    ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
  });
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Title job text must be nonempty");
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError("Invalid title job counter");
  return value;
}
function model(value: ModelRef): ModelRef { return Object.freeze({ provider: text(value.provider), model: text(value.model) }); }
function usage(value: ModelUsage): ModelUsage {
  if (value.source !== "provider" && value.source !== "estimated" && value.source !== "mixed") throw new TypeError("Invalid title usage source");
  return Object.freeze({
    inputTokens: integer(value.inputTokens), outputTokens: integer(value.outputTokens), totalTokens: integer(value.totalTokens), source: value.source,
    ...(value.cachedInputTokens === undefined ? {} : { cachedInputTokens: integer(value.cachedInputTokens) }),
    ...(value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: integer(value.cacheWriteInputTokens) }),
    ...(value.estimationMethod === undefined ? {} : { estimationMethod: text(value.estimationMethod) }),
  });
}
function assertVersion(current: TitleJob | undefined, expected: number | undefined, sessionId: string): void {
  if (expected === undefined ? current !== undefined : current?.version !== expected) throw new TitleJobConflictError(sessionId);
}
function conflict(error: unknown, sessionId: string): unknown {
  return error instanceof StorageConflictError ? new TitleJobConflictError(sessionId) : error;
}
