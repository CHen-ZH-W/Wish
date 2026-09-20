import { randomUUID } from "node:crypto";

import type { StorageBackendResolver } from "../../storage/backend.js";
import {
  StorageDomain,
  type DomainReadResult,
  type DomainSpec,
  type ResolvedStorageDomain,
} from "../../storage/domain.js";
import { KV_ABSENT, type KvPrecondition } from "../../storage/kv.js";
import { ApprovalRuleClosedError } from "./errors.js";
import {
  type ApprovalRuleMatchRequest,
  type ApprovalRuleRecord,
  type ApprovalRuleStore,
  type RememberApprovalRuleRequest,
} from "./types.js";

const APPROVAL_RULE_DOMAIN_ID = "permissions/approval-rules";
const DEFAULT_MAX_RULES = 4_096;

interface ApprovalRuleState {
  readonly schemaVersion: 1;
  readonly rules: readonly ApprovalRuleRecord[];
}

const EMPTY_STATE: ApprovalRuleState = Object.freeze({
  schemaVersion: 1 as const,
  rules: Object.freeze([]),
});

export const approvalRuleDomain: DomainSpec<void, ApprovalRuleState> =
  Object.freeze({
    id: APPROVAL_RULE_DOMAIN_ID,
    schemaVersion: 1,
    shape: "global" as const,
    requirements: Object.freeze({ kv: Object.freeze({ list: false }) }),
    resolve() {
      return Object.freeze({
        default: Object.freeze({ kind: "value" as const, value: EMPTY_STATE }),
      });
    },
    encode(value: ApprovalRuleState): Uint8Array {
      return new TextEncoder().encode(JSON.stringify(value));
    },
    decode(payload: Uint8Array): unknown {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
    },
    validate(value: unknown): ApprovalRuleState {
      return snapshotState(value);
    },
  });

export interface DomainApprovalRuleStoreOptions {
  readonly storage: StorageBackendResolver;
  readonly backendId: string;
  readonly maxRules?: number;
  readonly id?: () => string;
  readonly now?: () => Date;
}

export interface MemoryApprovalRuleStoreOptions {
  readonly maxRules?: number;
  readonly id?: () => string;
  readonly now?: () => Date;
}

/** Process-local Provider used by explicit standalone and focused test graphs. */
export class MemoryApprovalRuleStore implements ApprovalRuleStore {
  readonly version = "approval-rules-memory-v1";
  private readonly maxRules: number;
  private readonly nextId: () => string;
  private readonly now: () => Date;
  private readonly rules = new Map<string, ApprovalRuleRecord>();
  private closed = false;

  constructor(options: MemoryApprovalRuleStoreOptions = {}) {
    this.maxRules = positiveInteger(
      options.maxRules ?? DEFAULT_MAX_RULES,
      "ApprovalRule maxRules",
    );
    this.nextId = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async find(
    request: ApprovalRuleMatchRequest,
  ): Promise<ApprovalRuleRecord | undefined> {
    this.assertOpen();
    const normalized = snapshotMatchRequest(request);
    throwIfAborted(request.signal);
    const candidates = [...this.rules.values()].filter((rule) =>
      matchesBase(rule, normalized)
    );
    return candidates.find((rule) =>
      rule.scope === "run" && rule.runId === normalized.identity.runId
    ) ?? candidates.find((rule) =>
      rule.scope === "session" &&
      rule.sessionId === normalized.identity.sessionId
    ) ?? candidates.find((rule) => rule.scope === "workspace");
  }

  async remember(
    request: RememberApprovalRuleRequest,
  ): Promise<ApprovalRuleRecord> {
    this.assertOpen();
    const normalized = snapshotRememberRequest(request);
    throwIfAborted(normalized.signal);
    const existing = [...this.rules.values()].find((rule) =>
      matchesRequestedScope(rule, normalized)
    );
    if (existing !== undefined) {
      return existing;
    }
    const rule = createRule(normalized, this.nextId, this.now);
    this.rules.set(ruleSelector(rule), rule);
    while (this.rules.size > this.maxRules) {
      const oldest = this.rules.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.rules.delete(oldest);
    }
    return rule;
  }

  async list(signal?: AbortSignal): Promise<readonly ApprovalRuleRecord[]> {
    this.assertOpen();
    throwIfAborted(signal);
    return Object.freeze([...this.rules.values()]);
  }

  async revoke(id: string, signal?: AbortSignal): Promise<boolean> {
    this.assertOpen();
    const normalized = requireIdentifier(id, "ApprovalRule id");
    throwIfAborted(signal);
    for (const [selector, rule] of this.rules) {
      if (rule.id !== normalized) continue;
      this.rules.delete(selector);
      return true;
    }
    return false;
  }

  clearRun(runId: string): boolean {
    this.assertOpen();
    const normalized = requireIdentifier(runId, "ApprovalRule Run id");
    let changed = false;
    for (const [selector, rule] of this.rules) {
      if (rule.scope !== "run" || rule.runId !== normalized) continue;
      this.rules.delete(selector);
      changed = true;
    }
    return changed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rules.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new ApprovalRuleClosedError();
  }
}

/** Run-local rules plus durable session/workspace rules over Storage KV. */
export class DomainApprovalRuleStore implements ApprovalRuleStore {
  readonly version: string;
  private readonly domain: ResolvedStorageDomain<ApprovalRuleState>;
  private readonly maxRules: number;
  private readonly nextId: () => string;
  private readonly now: () => Date;
  private readonly runRules = new Map<string, ApprovalRuleRecord>();
  private cached: DomainReadResult<ApprovalRuleState> | undefined;
  private loading: Promise<DomainReadResult<ApprovalRuleState>> | undefined;
  private tail = Promise.resolve();
  private closed = false;

  constructor(options: DomainApprovalRuleStoreOptions) {
    this.maxRules = positiveInteger(
      options.maxRules ?? DEFAULT_MAX_RULES,
      "ApprovalRule maxRules",
    );
    this.nextId = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.domain = new StorageDomain({
      storage: options.storage,
      backendId: options.backendId,
      spec: approvalRuleDomain,
    }).resolve(undefined);
    this.version = `approval-rules-domain-v1:${this.domain.backendId}`;
  }

  async find(
    request: ApprovalRuleMatchRequest,
  ): Promise<ApprovalRuleRecord | undefined> {
    this.assertOpen();
    const normalized = snapshotMatchRequest(request);
    throwIfAborted(request.signal);
    await this.tail;
    const state = await this.state(request.signal);
    throwIfAborted(request.signal);
    const candidates = [
      ...this.runRules.values(),
      ...state.value.rules,
    ].filter((rule) => matchesBase(rule, normalized));
    return candidates.find((rule) =>
      rule.scope === "run" && rule.runId === normalized.identity.runId
    ) ?? candidates.find((rule) =>
      rule.scope === "session" &&
      rule.sessionId === normalized.identity.sessionId
    ) ?? candidates.find((rule) => rule.scope === "workspace");
  }

  async remember(
    request: RememberApprovalRuleRequest,
  ): Promise<ApprovalRuleRecord> {
    this.assertOpen();
    const normalized = snapshotRememberRequest(request);
    return await this.serial(async () => {
      throwIfAborted(request.signal);
      const existing = await this.findWithoutTail(normalized);
      if (existing !== undefined && existing.scope === normalized.scope) {
        return existing;
      }
      const rule = createRule(normalized, this.nextId, this.now);
      if (rule.scope === "run") {
        this.runRules.set(ruleSelector(rule), rule);
        this.pruneRunRules();
        return rule;
      }
      const current = await this.state(request.signal);
      const retained = current.value.rules.filter((item) =>
        ruleSelector(item) !== ruleSelector(rule)
      );
      if (retained.length >= this.maxRules) {
        throw new Error(
          `ApprovalRuleStore exceeds the ${this.maxRules} persistent rule limit`,
        );
      }
      const next = snapshotState({
        schemaVersion: 1,
        rules: [...retained, rule],
      });
      this.cached = await this.domain.save(
        next,
        storagePrecondition(current),
        request.signal,
      );
      return rule;
    });
  }

  async list(signal?: AbortSignal): Promise<readonly ApprovalRuleRecord[]> {
    this.assertOpen();
    throwIfAborted(signal);
    await this.tail;
    const state = await this.state(signal);
    throwIfAborted(signal);
    return Object.freeze([
      ...this.runRules.values(),
      ...state.value.rules,
    ]);
  }

  async revoke(id: string, signal?: AbortSignal): Promise<boolean> {
    this.assertOpen();
    const normalizedId = requireIdentifier(id, "ApprovalRule id");
    return await this.serial(async () => {
      throwIfAborted(signal);
      for (const [selector, rule] of this.runRules) {
        if (rule.id !== normalizedId) continue;
        this.runRules.delete(selector);
        return true;
      }
      const current = await this.state(signal);
      const retained = current.value.rules.filter((rule) =>
        rule.id !== normalizedId
      );
      if (retained.length === current.value.rules.length) return false;
      this.cached = await this.domain.save(
        snapshotState({ schemaVersion: 1, rules: retained }),
        storagePrecondition(current),
        signal,
      );
      return true;
    });
  }

  clearRun(runId: string): boolean {
    this.assertOpen();
    const normalized = requireIdentifier(runId, "ApprovalRule Run id");
    let changed = false;
    for (const [selector, rule] of this.runRules) {
      if (rule.runId !== normalized) continue;
      this.runRules.delete(selector);
      changed = true;
    }
    return changed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    this.runRules.clear();
  }

  private async findWithoutTail(
    request: RememberApprovalRuleRequest,
  ): Promise<ApprovalRuleRecord | undefined> {
    const state = await this.state(request.signal);
    const candidates = [...this.runRules.values(), ...state.value.rules]
      .filter((rule) => matchesBase(rule, request));
    return candidates.find((rule) => matchesRequestedScope(rule, request));
  }

  private async state(
    signal?: AbortSignal,
  ): Promise<DomainReadResult<ApprovalRuleState>> {
    if (this.cached !== undefined) return this.cached;
    this.loading ??= this.domain.load(signal).then((loaded) => {
      if (loaded === undefined) {
        throw new Error("ApprovalRule Domain unexpectedly resolved absent");
      }
      return loaded;
    });
    try {
      const loaded = await this.loading;
      if (loaded.value.rules.length > this.maxRules) {
        throw new Error(
          `ApprovalRuleStore exceeds the ${this.maxRules} persistent rule limit`,
        );
      }
      return this.cached = loaded;
    } finally {
      this.loading = undefined;
    }
  }

  private serial<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private pruneRunRules(): void {
    while (this.runRules.size > this.maxRules) {
      const oldest = this.runRules.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.runRules.delete(oldest);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ApprovalRuleClosedError();
  }
}

function createRule(
  request: RememberApprovalRuleRequest,
  id: () => string,
  now: () => Date,
): ApprovalRuleRecord {
  const scope = request.scope;
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("ApprovalRule clock must return a valid Date");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    id: requireIdentifier(id(), "ApprovalRule id"),
    effect: "allow" as const,
    scope,
    profile: request.profile,
    policyVersion: request.policyVersion,
    toolName: request.toolName,
    capabilityDigest: request.capabilityDigest,
    agentId: request.identity.agentId,
    workspaceFingerprint: request.identity.workspaceFingerprint,
    ...(scope === "session"
      ? { sessionId: request.identity.sessionId }
      : {}),
    ...(scope === "run" ? { runId: request.identity.runId } : {}),
    createdAt: date.toISOString(),
  });
}

function matchesBase(
  rule: ApprovalRuleRecord,
  request: ApprovalRuleMatchRequest,
): boolean {
  return rule.effect === "allow" &&
    rule.profile === request.profile &&
    rule.policyVersion === request.policyVersion &&
    rule.toolName === request.toolName &&
    rule.capabilityDigest === request.capabilityDigest &&
    rule.agentId === request.identity.agentId &&
    rule.workspaceFingerprint === request.identity.workspaceFingerprint;
}

function matchesRequestedScope(
  rule: ApprovalRuleRecord,
  request: RememberApprovalRuleRequest,
): boolean {
  return matchesBase(rule, request) && rule.scope === request.scope &&
    (rule.scope !== "run" || rule.runId === request.identity.runId) &&
    (rule.scope !== "session" ||
      rule.sessionId === request.identity.sessionId);
}

function ruleSelector(rule: ApprovalRuleRecord): string {
  return JSON.stringify([
    rule.scope,
    rule.profile,
    rule.policyVersion,
    rule.toolName,
    rule.capabilityDigest,
    rule.agentId,
    rule.workspaceFingerprint,
    rule.sessionId ?? "",
    rule.runId ?? "",
  ]);
}

function storagePrecondition(
  state: DomainReadResult<ApprovalRuleState>,
): KvPrecondition {
  return state.persisted
    ? Object.freeze({ kind: "revision" as const, revision: state.revision! })
    : KV_ABSENT;
}

function snapshotMatchRequest(
  request: ApprovalRuleMatchRequest,
): ApprovalRuleMatchRequest {
  if (request === null || typeof request !== "object") {
    throw new TypeError("ApprovalRule match request must be an object");
  }
  return Object.freeze({
    profile: permissionProfile(request.profile),
    policyVersion: requireIdentifier(
      request.policyVersion,
      "ApprovalRule policyVersion",
    ),
    toolName: requireIdentifier(request.toolName, "ApprovalRule Tool name"),
    capabilityDigest: requireIdentifier(
      request.capabilityDigest,
      "ApprovalRule capability digest",
    ),
    identity: snapshotIdentity(request.identity),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function snapshotRememberRequest(
  request: RememberApprovalRuleRequest,
): RememberApprovalRuleRequest {
  const matched = snapshotMatchRequest(request);
  if (
    request.scope !== "run" && request.scope !== "session" &&
    request.scope !== "workspace"
  ) {
    throw new TypeError("ApprovalRule retained scope is invalid");
  }
  return Object.freeze({ ...matched, scope: request.scope });
}

function snapshotIdentity(
  identity: ApprovalRuleMatchRequest["identity"],
): ApprovalRuleMatchRequest["identity"] {
  if (identity === null || typeof identity !== "object") {
    throw new TypeError("ApprovalRule identity must be an object");
  }
  return Object.freeze({
    agentId: requireIdentifier(identity.agentId, "ApprovalRule Agent id"),
    sessionId: requireIdentifier(identity.sessionId, "ApprovalRule Session id"),
    runId: requireIdentifier(identity.runId, "ApprovalRule Run id"),
    workspaceFingerprint: requireIdentifier(
      identity.workspaceFingerprint,
      "ApprovalRule Workspace fingerprint",
    ),
  });
}

function snapshotState(value: unknown): ApprovalRuleState {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    !Array.isArray((value as Record<string, unknown>).rules)
  ) throw new TypeError("ApprovalRule state is invalid");
  const rules = (value as { readonly rules: readonly unknown[] }).rules.map(
    snapshotPersistentRule,
  );
  const selectors = new Set(rules.map(ruleSelector));
  const ids = new Set(rules.map((rule) => rule.id));
  if (selectors.size !== rules.length || ids.size !== rules.length) {
    throw new TypeError("ApprovalRule state contains duplicate rules");
  }
  return Object.freeze({ schemaVersion: 1 as const, rules: Object.freeze(rules) });
}

function snapshotPersistentRule(value: unknown): ApprovalRuleRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ApprovalRule record is invalid");
  }
  const rule = value as Partial<ApprovalRuleRecord>;
  if (
    rule.schemaVersion !== 1 || rule.effect !== "allow" ||
    (rule.scope !== "session" && rule.scope !== "workspace")
  ) throw new TypeError("Persistent ApprovalRule record shape is invalid");
  const createdAt = requireIdentifier(rule.createdAt!, "ApprovalRule createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new TypeError("ApprovalRule createdAt is invalid");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    id: requireIdentifier(rule.id!, "ApprovalRule id"),
    effect: "allow" as const,
    scope: rule.scope,
    profile: permissionProfile(rule.profile!),
    policyVersion: requireIdentifier(rule.policyVersion!, "ApprovalRule policyVersion"),
    toolName: requireIdentifier(rule.toolName!, "ApprovalRule Tool name"),
    capabilityDigest: requireIdentifier(
      rule.capabilityDigest!,
      "ApprovalRule capability digest",
    ),
    agentId: requireIdentifier(rule.agentId!, "ApprovalRule Agent id"),
    workspaceFingerprint: requireIdentifier(
      rule.workspaceFingerprint!,
      "ApprovalRule Workspace fingerprint",
    ),
    ...(rule.scope === "session"
      ? { sessionId: requireIdentifier(rule.sessionId!, "ApprovalRule Session id") }
      : {}),
    createdAt,
  });
}

function permissionProfile(
  value: ApprovalRuleMatchRequest["profile"],
): ApprovalRuleMatchRequest["profile"] {
  if (
    value !== "read-only" && value !== "workspace-write" &&
    value !== "approval-required" && value !== "full-access"
  ) throw new TypeError("ApprovalRule profile is invalid");
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) throw new TypeError(`${label} must be non-empty trimmed text`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("ApprovalRule operation was aborted", { cause: signal.reason });
}
