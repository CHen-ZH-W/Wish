import { StorageDomain, type DomainSpec } from "../storage/domain.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { MAX_OCCUPANCY_SNAPSHOTS, type ContextOccupancySnapshot } from "./occupancy.js";

export const CONTEXT_OCCUPANCY_DOMAIN = "context-occupancy";
interface OccupancyDocument {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly snapshots: readonly ContextOccupancySnapshot[];
}
const spec: DomainSpec<string, OccupancyDocument> = {
  id: CONTEXT_OCCUPANCY_DOMAIN, schemaVersion: 1, shape: "keyed", requirements: { kv: {} },
  resolve(sessionId) { return { key: identifier(sessionId), default: { kind: "absent" } }; },
  encode(value) { return new TextEncoder().encode(JSON.stringify(value)); },
  decode(payload, schemaVersion) {
    if (schemaVersion !== 1) throw new Error("Unknown Context occupancy schema");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  },
  validate(value) {
    const document = record(value);
    if (document.schemaVersion !== 1 || !Array.isArray(document.snapshots) || document.snapshots.length > MAX_OCCUPANCY_SNAPSHOTS) throw new Error("Invalid Context occupancy document");
    const sessionId = identifier(document.sessionId);
    const snapshots = document.snapshots.map(validateSnapshot);
    if (snapshots.some(snapshot => snapshot.sessionId !== sessionId)) throw new Error("Context occupancy Session mismatch");
    return Object.freeze({ schemaVersion: 1, sessionId, snapshots: Object.freeze(snapshots) });
  },
};

/** Session-scoped, bounded, provider-neutral telemetry persistence. */
export class ContextOccupancyStore {
  private readonly domain: StorageDomain<string, OccupancyDocument>;
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(storage: StorageBackendResolver, backendId: string) {
    this.domain = new StorageDomain({ storage, backendId, spec });
  }
  async get(sessionId: string, signal?: AbortSignal): Promise<readonly ContextOccupancySnapshot[]> {
    await this.tails.get(sessionId);
    const document = await this.domain.resolve(sessionId).load(signal);
    if (document && document.value.sessionId !== sessionId) throw new Error("Context occupancy Session mismatch");
    return document?.value.snapshots ?? Object.freeze([]);
  }
  record(snapshot: ContextOccupancySnapshot): Promise<void> {
    return this.serial(snapshot.sessionId, async () => {
      const target = this.domain.resolve(snapshot.sessionId);
      const before = await target.load();
      const snapshots = (before?.value.snapshots ?? []).filter(item => item.runId !== snapshot.runId || item.stepId !== snapshot.stepId);
      await target.save({ schemaVersion: 1, sessionId: snapshot.sessionId,
        snapshots: [...snapshots, snapshot].slice(-MAX_OCCUPANCY_SNAPSHOTS),
      }, before?.revision ? { kind: "revision", revision: before.revision } : { kind: "absent" });
    });
  }
  clear(sessionId: string): Promise<void> {
    return this.serial(sessionId, async () => { await this.domain.resolve(sessionId).delete({ kind: "any" }); });
  }
  private serial(sessionId: string, action: () => Promise<void>): Promise<void> {
    const pending = (this.tails.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.tails.set(sessionId, pending);
    void pending.finally(() => { if (this.tails.get(sessionId) === pending) this.tails.delete(sessionId); }).catch(() => undefined);
    return pending;
  }
}

function validateSnapshot(value: unknown): ContextOccupancySnapshot {
  const item = record(value), model = record(item.model), breakdown = record(item.breakdown);
  if (typeof item.anchorable !== "boolean" || !Array.isArray(item.priorAttemptIds) || item.priorAttemptIds.length > 64) throw new Error("Invalid Context occupancy anchor");
  const capturedAt = identifier(item.capturedAt);
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("Invalid Context occupancy date");
  if (item.projectionStatus !== "ready" && item.projectionStatus !== "rejected") throw new Error("Invalid Context occupancy projection");
  const projectionStatus: ContextOccupancySnapshot["projectionStatus"] = item.projectionStatus;
  const result = {
    sessionId: identifier(item.sessionId), runId: identifier(item.runId), userTurnId: identifier(item.userTurnId), stepId: identifier(item.stepId), capturedAt, projectionStatus,
    model: Object.freeze({ provider: identifier(model.provider), model: identifier(model.model) }),
    historySequence: tokens(item.historySequence), envelopeDigest: hash(item.envelopeDigest),
    ...(item.opaqueDigest === undefined ? {} : { opaqueDigest: hash(item.opaqueDigest) }),
    anchorable: item.anchorable, priorAttemptIds: Object.freeze(item.priorAttemptIds.map(identifier)),
    breakdown: Object.freeze({ systemTokens: tokens(breakdown.systemTokens), toolsTokens: tokens(breakdown.toolsTokens), messageTokens: tokens(breakdown.messageTokens) }),
    ...optionalNumber("contextWindow", item.contextWindow, true),
    ...optionalNumber("reservedOutputTokens", item.reservedOutputTokens),
    ...optionalNumber("inputLimitTokens", item.inputLimitTokens),
    ...optionalNumber("preflightTokens", item.preflightTokens),
    ...(item.preflightMethod === undefined ? {} : { preflightMethod: identifier(item.preflightMethod) }),
  };
  if (!Number.isSafeInteger(result.breakdown.systemTokens + result.breakdown.toolsTokens + result.breakdown.messageTokens)) throw new Error("Context occupancy sum is unsafe");
  return Object.freeze(result);
}
function optionalNumber<Key extends string>(key: Key, value: unknown, positive = false): Partial<Record<Key, number>> {
  if (value === undefined) return {};
  const number = tokens(value);
  if (positive && number === 0) throw new Error("Context occupancy window is empty");
  return { [key]: number } as Record<Key, number>;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Context occupancy object");
  return value as Record<string, unknown>;
}
function tokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Context occupancy token count");
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 512) throw new Error("Invalid Context occupancy identifier");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid Context occupancy hash");
  return value;
}
