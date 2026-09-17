import type { StorageBackendResolver } from "../storage/backend.js";
import {
  DOMAIN_ABSENT,
  StorageDomain,
  type DomainSpec,
} from "../storage/domain.js";
import { StorageConflictError } from "../storage/errors.js";
import { KV_ABSENT } from "../storage/kv.js";
import {
  CoordinatorClosedError,
  CoordinatorConflictError,
} from "./errors.js";
import type { CoordinatorState, CoordinatorStateStore } from "./types.js";

const COORDINATOR_DOMAIN_ID = "coordinator/runs";

export const coordinatorDomain: DomainSpec<string, CoordinatorState> =
  Object.freeze({
    id: COORDINATOR_DOMAIN_ID,
    schemaVersion: 1,
    shape: "keyed" as const,
    requirements: Object.freeze({ kv: Object.freeze({ list: false }) }),
    resolve(runId: string) {
      return Object.freeze({
        key: requireIdentifier(runId, "Coordinator Run id"),
        default: DOMAIN_ABSENT,
      });
    },
    encode(value: CoordinatorState): Uint8Array {
      return new TextEncoder().encode(JSON.stringify(snapshotCoordinatorState(value)));
    },
    decode(payload: Uint8Array): unknown {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
    },
    validate(value: unknown): CoordinatorState {
      return snapshotCoordinatorState(value);
    },
  });

export class MemoryCoordinatorStateStore implements CoordinatorStateStore {
  private readonly states = new Map<string, CoordinatorState>();
  private closed = false;

  async get(runId: string, signal?: AbortSignal): Promise<CoordinatorState | undefined> {
    this.assertOpen();
    signal?.throwIfAborted();
    return this.states.get(requireIdentifier(runId, "Coordinator Run id"));
  }

  async put(
    state: CoordinatorState,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertOpen();
    signal?.throwIfAborted();
    const stable = snapshotCoordinatorState(state);
    assertExpectedVersion(this.states.get(stable.runId), expectedVersion, stable.runId);
    this.states.set(stable.runId, stable);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new CoordinatorClosedError();
  }
}

export interface DomainCoordinatorStateStoreOptions {
  readonly storage: StorageBackendResolver;
  readonly backendId: string;
}

/** Durable Run-keyed Coordinator state with Storage-level CAS. */
export class DomainCoordinatorStateStore implements CoordinatorStateStore {
  private readonly domain: StorageDomain<string, CoordinatorState>;
  private closed = false;

  constructor(options: DomainCoordinatorStateStoreOptions) {
    this.domain = new StorageDomain({
      storage: options.storage,
      backendId: options.backendId,
      spec: coordinatorDomain,
    });
  }

  async get(runId: string, signal?: AbortSignal): Promise<CoordinatorState | undefined> {
    this.assertOpen();
    signal?.throwIfAborted();
    return (await this.domain.resolve(
      requireIdentifier(runId, "Coordinator Run id"),
    ).load(signal))?.value;
  }

  async put(
    state: CoordinatorState,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertOpen();
    signal?.throwIfAborted();
    const stable = snapshotCoordinatorState(state);
    const resolved = this.domain.resolve(stable.runId);
    const current = await resolved.load(signal);
    assertExpectedVersion(current?.value, expectedVersion, stable.runId);
    try {
      await resolved.save(
        stable,
        current === undefined
          ? KV_ABSENT
          : Object.freeze({ kind: "revision" as const, revision: current.revision! }),
        signal,
      );
    } catch (error: unknown) {
      if (error instanceof StorageConflictError) {
        throw new CoordinatorConflictError(
          `Coordinator Run ${stable.runId} changed concurrently`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new CoordinatorClosedError();
  }
}

export function snapshotCoordinatorState(value: unknown): CoordinatorState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Coordinator state must be an object");
  }
  const state = value as Partial<CoordinatorState>;
  if (state.schemaVersion !== 1 || typeof state.active !== "boolean") {
    throw new TypeError("Coordinator state shape is invalid");
  }
  if (state.active && (state.exitedAt !== undefined || state.outcome !== undefined)) {
    throw new TypeError("An active Coordinator cannot have exit facts");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    runId: requireIdentifier(state.runId, "Coordinator Run id"),
    sessionId: requireIdentifier(state.sessionId, "Coordinator Session id"),
    version: positiveInteger(state.version, "Coordinator state version"),
    active: state.active,
    ...(state.goal === undefined
      ? {}
      : { goal: requireText(state.goal, "Coordinator goal") }),
    enteredAt: timestamp(state.enteredAt, "Coordinator enteredAt"),
    ...(state.exitedAt === undefined
      ? {}
      : { exitedAt: timestamp(state.exitedAt, "Coordinator exitedAt") }),
    ...(state.outcome === undefined
      ? {}
      : { outcome: requireText(state.outcome, "Coordinator outcome") }),
  });
}

function assertExpectedVersion(
  current: CoordinatorState | undefined,
  expectedVersion: number | undefined,
  runId: string,
): void {
  if (expectedVersion === undefined) {
    if (current !== undefined) {
      throw new CoordinatorConflictError(`Coordinator Run ${runId} already exists`);
    }
    return;
  }
  positiveInteger(expectedVersion, "Expected Coordinator state version");
  if (current?.version !== expectedVersion) {
    throw new CoordinatorConflictError(
      `Coordinator Run ${runId} expected state version ${expectedVersion}, found ${current?.version ?? "absent"}`,
    );
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const text = requireIdentifier(value, label);
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp`);
  return text;
}
