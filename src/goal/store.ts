import type { StorageBackendResolver } from "../storage/backend.js";
import { DOMAIN_ABSENT, StorageDomain, type DomainSpec } from "../storage/domain.js";
import { StorageConflictError } from "../storage/errors.js";
import { KV_ABSENT } from "../storage/kv.js";
import { GoalConflictError, GoalError } from "./errors.js";
import type { GoalPhase, GoalState, GoalStateStore } from "./types.js";

export const goalDomain: DomainSpec<string, GoalState> = Object.freeze({
  id: "goal/sessions",
  schemaVersion: 1,
  shape: "keyed" as const,
  requirements: Object.freeze({ kv: Object.freeze({ list: false }) }),
  resolve(sessionId: string) {
    return Object.freeze({ key: identifier(sessionId, "Goal Session id"), default: DOMAIN_ABSENT });
  },
  encode(value: GoalState) {
    return new TextEncoder().encode(JSON.stringify(snapshotGoalState(value)));
  },
  decode(payload: Uint8Array): unknown {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  },
  validate: snapshotGoalState,
});

export class MemoryGoalStateStore implements GoalStateStore {
  private readonly states = new Map<string, GoalState>();
  private closed = false;
  async get(sessionId: string, signal?: AbortSignal): Promise<GoalState | undefined> {
    this.assertOpen(); signal?.throwIfAborted(); return this.states.get(identifier(sessionId, "Goal Session id"));
  }
  async put(state: GoalState, expectedVersion?: number, signal?: AbortSignal): Promise<void> {
    this.assertOpen(); signal?.throwIfAborted();
    const stable = snapshotGoalState(state);
    assertVersion(this.states.get(stable.sessionId), expectedVersion, stable.sessionId);
    this.states.set(stable.sessionId, stable);
  }
  async delete(sessionId: string, expectedVersion: number, signal?: AbortSignal): Promise<void> {
    this.assertOpen(); signal?.throwIfAborted();
    const id = identifier(sessionId, "Goal Session id");
    assertVersion(this.states.get(id), expectedVersion, id);
    this.states.delete(id);
  }
  async close(): Promise<void> { this.closed = true; }
  private assertOpen() { if (this.closed) throw new GoalError("goal_closed", "Goal store is closed"); }
}

export class DomainGoalStateStore implements GoalStateStore {
  private readonly domain: StorageDomain<string, GoalState>;
  private closed = false;
  constructor(options: { readonly storage: StorageBackendResolver; readonly backendId: string }) {
    this.domain = new StorageDomain({ storage: options.storage, backendId: options.backendId, spec: goalDomain });
  }
  async get(sessionId: string, signal?: AbortSignal): Promise<GoalState | undefined> {
    this.assertOpen(); return (await this.domain.resolve(identifier(sessionId, "Goal Session id")).load(signal))?.value;
  }
  async put(state: GoalState, expectedVersion?: number, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const stable = snapshotGoalState(state);
    const resolved = this.domain.resolve(stable.sessionId);
    const current = await resolved.load(signal);
    assertVersion(current?.value, expectedVersion, stable.sessionId);
    try {
      await resolved.save(stable, current === undefined ? KV_ABSENT : { kind: "revision", revision: current.revision! }, signal);
    } catch (error: unknown) { throw storageConflict(error, stable.sessionId); }
  }
  async delete(sessionId: string, expectedVersion: number, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const id = identifier(sessionId, "Goal Session id");
    const resolved = this.domain.resolve(id);
    const current = await resolved.load(signal);
    assertVersion(current?.value, expectedVersion, id);
    try {
      await resolved.delete({ kind: "revision", revision: current!.revision! }, signal);
    } catch (error: unknown) { throw storageConflict(error, id); }
  }
  async close(): Promise<void> { this.closed = true; }
  private assertOpen() { if (this.closed) throw new GoalError("goal_closed", "Goal store is closed"); }
}

export function snapshotGoalState(value: unknown): GoalState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Goal state must be an object");
  const state = value as Partial<GoalState>;
  const phase = goalPhase(state.phase);
  const blockedReason = phase === "blocked" ? blockReason(state.blockedReason) : undefined;
  if (phase !== "blocked" && state.blockedReason !== undefined) throw new TypeError("Only a blocked Goal may carry blockedReason");
  const roundsStarted = nonNegative(state.roundsStarted, "Goal roundsStarted");
  const maxGoalRounds = positive(state.maxGoalRounds, "Goal maxGoalRounds");
  if (roundsStarted > maxGoalRounds) throw new TypeError("Goal roundsStarted exceeds maxGoalRounds");
  if (state.schemaVersion !== 1) throw new TypeError("Goal state schemaVersion is invalid");
  return Object.freeze({
    schemaVersion: 1 as const,
    sessionId: identifier(state.sessionId, "Goal Session id"),
    version: positive(state.version, "Goal state version"),
    id: identifier(state.id, "Goal id"),
    revision: positive(state.revision, "Goal revision"),
    objective: text(state.objective, "Goal objective"),
    phase,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    roundsStarted,
    maxGoalRounds,
    createdAt: timestamp(state.createdAt, "Goal createdAt"),
    updatedAt: timestamp(state.updatedAt, "Goal updatedAt"),
  });
}

function assertVersion(current: GoalState | undefined, expected: number | undefined, sessionId: string) {
  if (expected === undefined) {
    if (current !== undefined) throw new GoalConflictError("goal_already_exists", `Session ${sessionId} already has a Goal`);
    return;
  }
  positive(expected, "Expected Goal state version");
  if (current?.version !== expected) throw new GoalConflictError("goal_stale_revision", `Goal state changed concurrently for Session ${sessionId}`);
}
function storageConflict(error: unknown, sessionId: string): unknown {
  return error instanceof StorageConflictError
    ? new GoalConflictError("goal_stale_revision", `Goal state changed concurrently for Session ${sessionId}`, { cause: error })
    : error;
}
function goalPhase(value: unknown): GoalPhase { if (!["active", "paused", "blocked", "complete"].includes(value as string)) throw new TypeError("Goal phase is invalid"); return value as GoalPhase; }
function blockReason(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Blocked Goal requires blockedReason"); const reason = value as Record<string, unknown>; const code = identifier(reason.code, "Goal block code"); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(code)) throw new TypeError("Goal block code must be lower-kebab-case"); return Object.freeze({ code, message: text(reason.message, "Goal block message") }); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new TypeError(`${label} must be non-empty trimmed text`); return value; }
function text(value: unknown, label: string): string { if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must not be empty`); return value.trim(); }
function positive(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive safe integer`); return value as number; }
function nonNegative(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative safe integer`); return value as number; }
function timestamp(value: unknown, label: string): string { const result = identifier(value, label); if (Number.isNaN(Date.parse(result))) throw new TypeError(`${label} must be an ISO timestamp`); return result; }
