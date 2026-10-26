import { freezeJson } from "../agent-profiles/validation.js";
import type { StorageBackendLease } from "../storage/backend.js";
import { StorageDomain, DOMAIN_ABSENT, type DomainSpec } from "../storage/domain.js";
import { StorageConflictError } from "../storage/errors.js";
import { canonical, digest, EvolutionError, fail, object, sha, text } from "./validation.js";
import type { EvolutionTarget, EvolutionTicket } from "./types.js";

export interface EvolutionTriggerSuggestion {
  readonly id: string; readonly target: EvolutionTarget;
  readonly failureCategory: EvolutionTicket["failureCategory"]; readonly confidence: number;
  readonly taskIds: readonly string[]; readonly evidenceDigest: string; readonly summary: string;
}
export interface EvolutionTriggerConfig {
  readonly mode: "off" | "advisory" | "automatic"; readonly targets: readonly EvolutionTarget[];
  readonly minIndependentTasks: number; readonly minConfidence: number; readonly cooldownMs: number;
  readonly maxConcurrent: number; readonly maxDispatches: number; readonly windowMs: number;
}
export interface EvolutionTriggerDispatch {
  readonly operationId: string; readonly evidenceKey: string; readonly suggestion: EvolutionTriggerSuggestion;
  readonly startedAt: number; readonly status: "pending" | "dispatched" | "completed" | "uncertain" | "abandoned";
  readonly campaignId?: string; readonly error?: string;
}
export interface EvolutionTriggerSnapshot {
  readonly schemaVersion: 1; readonly revision: number; readonly dispatches: readonly EvolutionTriggerDispatch[];
}
export interface EvolutionTriggerStore {
  read(): Promise<EvolutionTriggerSnapshot>;
  compareAndSwap(expectedRevision: number, value: EvolutionTriggerSnapshot): Promise<EvolutionTriggerSnapshot>;
  close?(): Promise<void>;
}
export interface EvolutionTriggerPorts {
  listSuggestions(signal: AbortSignal): Promise<readonly EvolutionTriggerSuggestion[]>;
  /** Host task ownership determines priority; a model cannot report this value. */
  isUserBusy(): boolean | Promise<boolean>;
  assessResources?(): Promise<{ readonly available: boolean; readonly reason?: string }>;
  dispatch(suggestion: EvolutionTriggerSuggestion, context: { readonly operationId: string; readonly signal: AbortSignal }): Promise<{ readonly campaignId: string; readonly settled?: boolean }>;
  /** Host lookup only. Unknown outcome must not dispatch the suggestion again. */
  reconcile?(entry: EvolutionTriggerDispatch, signal: AbortSignal): Promise<{ readonly campaignId: string; readonly settled?: boolean } | undefined>;
}
export interface EvolutionTriggerTick {
  readonly mode: EvolutionTriggerConfig["mode"]; readonly advisories: readonly EvolutionTriggerSuggestion[];
  readonly dispatched: readonly string[]; readonly deferred: Readonly<Record<string, string>>;
}
const empty = (): EvolutionTriggerSnapshot => ({ schemaVersion: 1, revision: 0, dispatches: [] });
const defaults: EvolutionTriggerConfig = { mode: "off", targets: [], minIndependentTasks: 3, minConfidence: 0.8,
  cooldownMs: 3_600_000, maxConcurrent: 1, maxDispatches: 3, windowMs: 86_400_000 };
const targets = ["skill", "prompt", "workflow", "tool", "plugin", "kernel"];

export class MemoryEvolutionTriggerStore implements EvolutionTriggerStore {
  private value = freezeJson(empty());
  async read(): Promise<EvolutionTriggerSnapshot> { return this.value; }
  async compareAndSwap(expectedRevision: number, value: EvolutionTriggerSnapshot): Promise<EvolutionTriggerSnapshot> {
    if (this.value.revision !== expectedRevision || value.revision !== expectedRevision + 1) fail("evolution_trigger_conflict");
    return this.value = updatedSnapshot(this.value, value);
  }
}
/** One CAS aggregate per Host trigger owner; the supplied lease is released by close(). */
export class StorageEvolutionTriggerStore implements EvolutionTriggerStore {
  private readonly domain: StorageDomain<string, EvolutionTriggerSnapshot>;
  private closed = false;
  constructor(private readonly lease: StorageBackendLease, private readonly key = "task-evidence") {
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(key)) fail("evolution_trigger_invalid_key");
    const spec: DomainSpec<string, EvolutionTriggerSnapshot> = {
      id: "evolution/triggers/v1", schemaVersion: 1, shape: "keyed", requirements: { kv: {} },
      resolve: key => ({ key, default: DOMAIN_ABSENT }),
      encode: value => new TextEncoder().encode(canonical(value)),
      decode: bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), validate: snapshot,
    };
    this.domain = new StorageDomain({ storage: lease, backendId: lease.id, spec });
  }
  private assertOpen(): void { if (this.closed) fail("evolution_trigger_store_closed"); }
  async read(): Promise<EvolutionTriggerSnapshot> { this.assertOpen(); return (await this.domain.resolve(this.key).load())?.value ?? freezeJson(empty()); }
  async compareAndSwap(expectedRevision: number, value: EvolutionTriggerSnapshot): Promise<EvolutionTriggerSnapshot> {
    this.assertOpen(); const handle = this.domain.resolve(this.key), current = await handle.load();
    if ((current?.value.revision ?? 0) !== expectedRevision || value.revision !== expectedRevision + 1) fail("evolution_trigger_conflict");
    const checked = updatedSnapshot(current?.value ?? empty(), value);
    try { await handle.save(checked, current ? { kind: "revision", revision: current.revision! } : { kind: "absent" }); }
    catch (error) { if (error instanceof StorageConflictError) throw new EvolutionError("evolution_trigger_conflict"); throw error; }
    return checked;
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; this.lease.release(); } }
}

/** Evidence-driven scheduling. No timer, evaluator or publisher is owned by this class. */
export class EvolutionTrigger {
  private policy: EvolutionTriggerConfig;
  private readonly retirement = new AbortController();
  private readonly active = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly now: () => number;
  constructor(private readonly options: { readonly store: EvolutionTriggerStore; readonly ports: EvolutionTriggerPorts; readonly config?: Partial<EvolutionTriggerConfig>; readonly now?: () => number }) {
    this.policy = config(options.config ?? {}); this.now = options.now ?? Date.now;
  }
  get configuration(): EvolutionTriggerConfig { return this.policy; }
  get activeCount(): number { return this.active.size; }
  configure(value: Partial<EvolutionTriggerConfig>): EvolutionTriggerConfig { this.assertOpen(); return this.policy = config({ ...this.policy, ...value }); }
  snapshot(): Promise<EvolutionTriggerSnapshot> { return this.options.store.read(); }
  async listAdvisories(signal?: AbortSignal): Promise<readonly EvolutionTriggerSuggestion[]> {
    this.assertOpen(); const combined = AbortSignal.any([this.retirement.signal, ...(signal ? [signal] : [])]); combined.throwIfAborted();
    const values = await this.options.ports.listSuggestions(combined); combined.throwIfAborted();
    if (values.length > 1_000) fail("evolution_trigger_suggestion_limit");
    const seen = new Set<string>();
    return values.map(suggestion).filter(item => {
      const key = evidenceKey(item); if (seen.has(key)) return false; seen.add(key);
      return !this.policy.targets.length || this.policy.targets.includes(item.target);
    });
  }
  async tick(signal?: AbortSignal): Promise<EvolutionTriggerTick> {
    this.assertOpen();
    if (this.policy.mode === "off") return { mode: "off", advisories: [], dispatched: [], deferred: {} };
    const advisories = await this.listAdvisories(signal), mode = this.policy.mode;
    if (mode !== "automatic") return { mode, advisories, dispatched: [], deferred: {} };
    const combined = AbortSignal.any([this.retirement.signal, ...(signal ? [signal] : [])]);
    const deferred: Record<string, string> = {}, dispatched: string[] = [], jobs: Promise<void>[] = [];
    for (const item of advisories) {
      const key = evidenceKey(item);
      const operation = await this.exclusive(async () => {
        this.assertOpen(); combined.throwIfAborted();
        if (this.policy.mode !== "automatic") { deferred[key] = "automatic-disabled"; return undefined; }
        if (item.failureCategory !== "harness") { deferred[key] = "human-attribution-required"; return undefined; }
        if (item.confidence < this.policy.minConfidence || new Set(item.taskIds).size < this.policy.minIndependentTasks) { deferred[key] = "insufficient-independent-evidence"; return undefined; }
        if (!this.policy.targets.includes(item.target)) { deferred[key] = "target-not-allowed"; return undefined; }
        if (await this.options.ports.isUserBusy()) { deferred[key] = "user-task-busy"; return undefined; }
        const resources = await this.options.ports.assessResources?.();
        if (resources && !resources.available) { deferred[key] = resources.reason ?? "resources-unavailable"; return undefined; }
        this.assertOpen(); combined.throwIfAborted();
        let created: EvolutionTriggerDispatch | undefined;
        await this.update(current => {
          this.assertOpen(); combined.throwIfAborted();
          created = undefined;
          const reason = blocked(current, item, this.policy, this.now());
          if (reason) { deferred[key] = reason; return undefined; }
          created = { operationId: `evolution-trigger-${digest(key)}`, evidenceKey: key, suggestion: item, startedAt: this.now(), status: "pending" };
          return { ...current, dispatches: [...current.dispatches, created] };
        });
        return created;
      });
      if (!operation) continue;
      dispatched.push(operation.operationId);
      const job = this.dispatch(operation, combined); this.active.set(operation.operationId, job);
      void job.finally(() => { if (this.active.get(operation.operationId) === job) this.active.delete(operation.operationId); }).catch(() => {});
      jobs.push(job);
    }
    await Promise.all(jobs);
    return { mode, advisories, dispatched, deferred };
  }
  /** Explicit Host reconciliation of restart/transport uncertainty; no automatic retry. */
  async recover(signal?: AbortSignal): Promise<EvolutionTriggerSnapshot> {
    this.assertOpen(); if (!this.options.ports.reconcile) return this.snapshot();
    const combined = AbortSignal.any([this.retirement.signal, ...(signal ? [signal] : [])]);
    for (const entry of (await this.snapshot()).dispatches) {
      if (!["pending", "uncertain", "dispatched"].includes(entry.status) || this.active.has(entry.operationId)) continue;
      combined.throwIfAborted(); const receipt = await this.options.ports.reconcile(entry, combined); combined.throwIfAborted();
      if (receipt) {
        if (receipt.settled !== undefined && typeof receipt.settled !== "boolean") fail("evolution_trigger_invalid_receipt");
        const id = text(receipt.campaignId); if (entry.campaignId && entry.campaignId !== id) fail("evolution_trigger_receipt_mismatch");
        await this.exclusive(() => this.update(current => {
          const latest = current.dispatches.find(item => item.operationId === entry.operationId);
          if (latest?.status === "completed") return undefined;
          return { ...current, dispatches: current.dispatches.map(item => item.operationId === entry.operationId ? { ...item, campaignId: id, status: receipt.settled ? "completed" : "dispatched" } : item) };
        }));
      }
    }
    return this.snapshot();
  }
  /** Host completion of technical development releases concurrency, without consulting an evaluator. */
  async markSettled(operationId: string, campaignId: string): Promise<EvolutionTriggerSnapshot> {
    this.assertOpen(); text(operationId); text(campaignId);
    return this.exclusive(() => this.update(current => {
      const entry = current.dispatches.find(item => item.operationId === operationId);
      if (!entry || entry.campaignId !== campaignId || !["dispatched", "completed"].includes(entry.status)) fail("evolution_trigger_receipt_mismatch");
      if (entry.status === "completed") return undefined;
      return { ...current, dispatches: current.dispatches.map(item => item.operationId === operationId ? { ...item, status: "completed" } : item) };
    }));
  }
  suspend(): void { this.closed = true; this.retirement.abort(new EvolutionError("evolution_trigger_closed")); }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.suspend();
    return this.closing = (async () => { await this.queue.catch(() => {}); await Promise.allSettled([...this.active.values()]); await this.options.store.close?.(); })();
  }
  private async dispatch(entry: EvolutionTriggerDispatch, signal: AbortSignal): Promise<void> {
    let receipt: { readonly campaignId: string; readonly settled?: boolean } | undefined, error: unknown, invoked = false;
    try {
      signal.throwIfAborted(); invoked = true; receipt = await this.options.ports.dispatch(entry.suggestion, { operationId: entry.operationId, signal }); text(receipt.campaignId);
      if (receipt.settled !== undefined && typeof receipt.settled !== "boolean") fail("evolution_trigger_invalid_receipt");
    }
    catch (caught) { receipt = undefined; error = caught; }
    await this.exclusive(() => this.update(current => ({ ...current, dispatches: current.dispatches.map(item => item.operationId !== entry.operationId ? item : receipt
      ? { ...item, campaignId: receipt.campaignId, status: receipt.settled ? "completed" : "dispatched" }
      : { ...item, status: invoked ? "uncertain" : "abandoned", error: String(error instanceof Error ? error.message : error).slice(0, 4_096) }) })));
  }
  private assertOpen(): void { if (this.closed) fail("evolution_trigger_closed"); }
  private exclusive<T>(action: () => Promise<T>): Promise<T> { const job = this.queue.catch(() => {}).then(action); this.queue = job; return job; }
  private async update(change: (current: EvolutionTriggerSnapshot) => EvolutionTriggerSnapshot | undefined): Promise<EvolutionTriggerSnapshot> {
    for (let retry = 0; retry < 3; retry++) {
      const current = await this.options.store.read(), next = change(current); if (!next) return current;
      try { return await this.options.store.compareAndSwap(current.revision, { ...next, revision: current.revision + 1 }); }
      catch (error) { if (!(error instanceof EvolutionError) || error.code !== "evolution_trigger_conflict" || retry === 2) throw error; }
    }
    fail("evolution_trigger_conflict");
  }
}
function config(value: Partial<EvolutionTriggerConfig>): EvolutionTriggerConfig {
  if (Object.keys(value).some(key => !Object.keys(defaults).includes(key))) fail("evolution_trigger_invalid_config");
  const item = { ...defaults, ...value };
  if (!["off", "advisory", "automatic"].includes(item.mode) || !Array.isArray(item.targets) || item.targets.some(target => !targets.includes(target)) || new Set(item.targets).size !== item.targets.length) fail("evolution_trigger_invalid_config");
  if (item.mode === "automatic" && !item.targets.length) fail("evolution_trigger_fixed_target_required");
  for (const key of ["minIndependentTasks", "cooldownMs", "maxConcurrent", "maxDispatches", "windowMs"] as const) {
    if (!Number.isSafeInteger(item[key]) || item[key] < (key === "cooldownMs" ? 0 : 1)) fail("evolution_trigger_invalid_config");
  }
  if (item.maxConcurrent > 32 || item.maxDispatches > 1_000 || item.windowMs > 31 * 86_400_000 || !Number.isFinite(item.minConfidence) || item.minConfidence < 0 || item.minConfidence > 1) fail("evolution_trigger_invalid_config");
  return freezeJson(item);
}
function suggestion(value: unknown): EvolutionTriggerSuggestion {
  const item = object(value);
  if (Object.keys(item).some(key => !["id", "target", "failureCategory", "confidence", "taskIds", "evidenceDigest", "summary"].includes(key))) fail("evolution_trigger_invalid_suggestion");
  text(item.id); text(item.summary); sha(item.evidenceDigest);
  if (!targets.includes(String(item.target)) || !["environment", "authorization", "project", "harness", "unknown"].includes(String(item.failureCategory)) || typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) fail("evolution_trigger_invalid_suggestion");
  if (!Array.isArray(item.taskIds) || item.taskIds.length > 1_000 || item.taskIds.some(id => typeof id !== "string" || !id.trim() || id.length > 4_096)) fail("evolution_trigger_invalid_tasks");
  return freezeJson(item) as unknown as EvolutionTriggerSuggestion;
}
function evidenceKey(item: EvolutionTriggerSuggestion): string { return `${item.target}:${item.evidenceDigest}`; }
function snapshot(value: unknown): EvolutionTriggerSnapshot {
  const item = object(value);
  if (item.schemaVersion !== 1 || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0 || !Array.isArray(item.dispatches) || item.dispatches.length > 10_000) fail("evolution_trigger_invalid_snapshot");
  const keys = new Set<string>();
  for (const raw of item.dispatches) {
    const entry = object(raw), input = suggestion(entry.suggestion), key = evidenceKey(input);
    if (entry.evidenceKey !== key || entry.operationId !== `evolution-trigger-${digest(key)}` || keys.has(key) || typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt) || entry.startedAt < 0 || !["pending", "dispatched", "completed", "uncertain", "abandoned"].includes(String(entry.status))) fail("evolution_trigger_invalid_dispatch");
    keys.add(key); if (entry.campaignId !== undefined) text(entry.campaignId); if (["dispatched", "completed"].includes(String(entry.status)) && entry.campaignId === undefined) fail("evolution_trigger_receipt_missing");
  }
  return freezeJson(item) as unknown as EvolutionTriggerSnapshot;
}
function updatedSnapshot(previous: EvolutionTriggerSnapshot, value: EvolutionTriggerSnapshot): EvolutionTriggerSnapshot {
  const checked = snapshot(value);
  if (checked.dispatches.length < previous.dispatches.length) fail("evolution_trigger_history_immutable");
  for (const [index, before] of previous.dispatches.entries()) {
    const after = checked.dispatches[index]!;
    const { status: _s1, campaignId: _c1, error: _e1, ...left } = before;
    const { status: _s2, campaignId: _c2, error: _e2, ...right } = after;
    if (digest(left) !== digest(right) || (before.campaignId && before.campaignId !== after.campaignId)) fail("evolution_trigger_history_immutable");
    const transitions = { pending: ["pending", "uncertain", "dispatched", "completed", "abandoned"], uncertain: ["uncertain", "dispatched", "completed"], dispatched: ["dispatched", "completed"], completed: ["completed"], abandoned: ["abandoned"] };
    if (!transitions[before.status].includes(after.status)) fail("evolution_trigger_invalid_transition");
  }
  if (checked.dispatches.slice(previous.dispatches.length).some(entry => entry.status !== "pending" || entry.campaignId !== undefined)) fail("evolution_trigger_intent_required");
  return checked;
}
function blocked(state: EvolutionTriggerSnapshot, item: EvolutionTriggerSuggestion, policy: EvolutionTriggerConfig, now: number): string | undefined {
  if (state.dispatches.some(entry => entry.evidenceKey === evidenceKey(item))) return "already-dispatched-or-uncertain";
  if (state.dispatches.filter(entry => ["pending", "uncertain", "dispatched"].includes(entry.status)).length >= policy.maxConcurrent) return "concurrency-limit";
  if (state.dispatches.filter(entry => entry.startedAt >= now - policy.windowMs).length >= policy.maxDispatches) return "window-budget";
  if (state.dispatches.some(entry => entry.suggestion.target === item.target && now - entry.startedAt < policy.cooldownMs)) return "cooldown";
  return undefined;
}
