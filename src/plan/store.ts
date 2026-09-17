import type { StorageBackendResolver } from "../storage/backend.js";
import {
  DOMAIN_ABSENT,
  StorageDomain,
  type DomainSpec,
} from "../storage/domain.js";
import { StorageConflictError } from "../storage/errors.js";
import { KV_ABSENT } from "../storage/kv.js";
import { PlanClosedError, PlanConflictError } from "./errors.js";
import type { PlanDocument, PlanReview, PlanState, PlanStateStore } from "./types.js";

const PLAN_DOMAIN_ID = "plan/sessions";

export const planDomain: DomainSpec<string, PlanState> = Object.freeze({
  id: PLAN_DOMAIN_ID,
  schemaVersion: 1,
  shape: "keyed" as const,
  requirements: Object.freeze({ kv: Object.freeze({ list: false }) }),
  resolve(sessionId: string) {
    return Object.freeze({
      key: requireIdentifier(sessionId, "Plan Session id"),
      default: DOMAIN_ABSENT,
    });
  },
  encode(value: PlanState): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(snapshotPlanState(value)));
  },
  decode(payload: Uint8Array): unknown {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  },
  validate(value: unknown): PlanState {
    return snapshotPlanState(value);
  },
});

export class MemoryPlanStateStore implements PlanStateStore {
  private readonly states = new Map<string, PlanState>();
  private closed = false;

  async get(sessionId: string, signal?: AbortSignal): Promise<PlanState | undefined> {
    this.assertOpen();
    signal?.throwIfAborted();
    return this.states.get(requireIdentifier(sessionId, "Plan Session id"));
  }

  async put(
    state: PlanState,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertOpen();
    signal?.throwIfAborted();
    const stable = snapshotPlanState(state);
    assertExpectedVersion(this.states.get(stable.sessionId), expectedVersion, stable.sessionId);
    this.states.set(stable.sessionId, stable);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new PlanClosedError();
  }
}

export interface DomainPlanStateStoreOptions {
  readonly storage: StorageBackendResolver;
  readonly backendId: string;
}

/** Durable Session-keyed Plan state with Storage-level CAS. */
export class DomainPlanStateStore implements PlanStateStore {
  private readonly domain: StorageDomain<string, PlanState>;
  private closed = false;

  constructor(options: DomainPlanStateStoreOptions) {
    this.domain = new StorageDomain({
      storage: options.storage,
      backendId: options.backendId,
      spec: planDomain,
    });
  }

  async get(sessionId: string, signal?: AbortSignal): Promise<PlanState | undefined> {
    this.assertOpen();
    signal?.throwIfAborted();
    return (await this.domain.resolve(
      requireIdentifier(sessionId, "Plan Session id"),
    ).load(signal))?.value;
  }

  async put(
    state: PlanState,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertOpen();
    signal?.throwIfAborted();
    const stable = snapshotPlanState(state);
    const resolved = this.domain.resolve(stable.sessionId);
    const current = await resolved.load(signal);
    assertExpectedVersion(current?.value, expectedVersion, stable.sessionId);
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
        throw new PlanConflictError(
          `Plan Session ${stable.sessionId} changed concurrently`,
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
    if (this.closed) throw new PlanClosedError();
  }
}

export function snapshotPlanState(value: unknown): PlanState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Plan state must be an object");
  }
  const state = value as Partial<PlanState>;
  if (state.schemaVersion !== 1 || typeof state.active !== "boolean") {
    throw new TypeError("Plan state shape is invalid");
  }
  const active = state.active;
  const document = state.document === undefined
    ? undefined
    : snapshotPlanDocument(state.document);
  if (!active && document !== undefined && document.approvedAt === undefined) {
    throw new TypeError("An inactive Plan document must be approved");
  }
  if (active && state.exitedAt !== undefined) {
    throw new TypeError("An active Plan cannot have exitedAt");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    sessionId: requireIdentifier(state.sessionId, "Plan Session id"),
    version: positiveInteger(state.version, "Plan state version"),
    active,
    ...(state.goal === undefined ? {} : { goal: requireText(state.goal, "Plan goal") }),
    enteredAt: timestamp(state.enteredAt, "Plan enteredAt"),
    ...(state.exitedAt === undefined ? {} : { exitedAt: timestamp(state.exitedAt, "Plan exitedAt") }),
    ...(document === undefined ? {} : { document }),
    ...(state.review === undefined ? {} : { review: snapshotReview(state.review, document, active) }),
  });
}

function snapshotReview(review: PlanReview, document: PlanDocument | undefined, active: boolean): PlanReview {
  if (!review || !["pending", "approved", "changes-requested", "cancelled", "superseded"].includes(review.status)) {
    throw new TypeError("Invalid Plan review");
  }
  if ((review.status === "pending" || review.status === "approved") &&
      (!document || review.planVersion !== document.version || review.digest !== document.digest ||
       active !== (review.status === "pending"))) throw new TypeError("Review and Plan disagree");
  return Object.freeze({
    id: requireIdentifier(review.id, "Review id"), status: review.status,
    planVersion: positiveInteger(review.planVersion, "Review Plan version"),
    digest: sha256Digest(review.digest), submittedAt: timestamp(review.submittedAt, "Review time"),
    ...(review.resolvedAt === undefined ? {} : { resolvedAt: timestamp(review.resolvedAt, "Review resolution time") }),
    ...(review.actor === undefined ? {} : { actor: requireText(review.actor, "Review actor") }),
    ...(review.feedback === undefined ? {} : { feedback: requireText(review.feedback, "Review feedback") }),
  });
}

function snapshotPlanDocument(value: unknown): PlanDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Plan document must be an object");
  }
  const document = value as Partial<PlanDocument>;
  return Object.freeze({
    version: positiveInteger(document.version, "Plan document version"),
    markdown: requireText(document.markdown, "Plan markdown"),
    digest: sha256Digest(document.digest),
    updatedAt: timestamp(document.updatedAt, "Plan document updatedAt"),
    ...(document.artifacts === undefined ? {} : { artifacts: Object.freeze(document.artifacts.map((ref) => Object.freeze({
      kind: requireIdentifier(ref.kind, "Artifact kind"), id: requireIdentifier(ref.id, "Artifact id"),
      version: positiveInteger(ref.version, "Artifact version"), digest: sha256Digest(ref.digest),
    }))) }),
    ...(document.approvedAt === undefined
      ? {}
      : { approvedAt: timestamp(document.approvedAt, "Plan document approvedAt") }),
    ...(document.approvalSummary === undefined
      ? {}
      : { approvalSummary: requireText(document.approvalSummary, "Plan approval summary") }),
  });
}

function assertExpectedVersion(
  current: PlanState | undefined,
  expectedVersion: number | undefined,
  sessionId: string,
): void {
  if (expectedVersion === undefined) {
    if (current !== undefined) {
      throw new PlanConflictError(`Plan Session ${sessionId} already exists`);
    }
    return;
  }
  positiveInteger(expectedVersion, "Expected Plan state version");
  if (current?.version !== expectedVersion) {
    throw new PlanConflictError(
      `Plan Session ${sessionId} expected state version ${expectedVersion}, found ${current?.version ?? "absent"}`,
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

function sha256Digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Plan digest must be a lowercase SHA-256 digest");
  }
  return value;
}
