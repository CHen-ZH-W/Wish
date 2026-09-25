import { FiberState, type Context } from "@deepseek-ai/cordis";
import type { PluginInspection } from "./types.js";
import type {
  PluginLifecycleCollection, PluginLifecycleInspection, PluginLifecycleOwnerView,
  PluginLifecycleStatus, PluginSelection, PluginStopReport,
} from "./management-types.js";
import { previewPluginSelection } from "./selection.js";
import { PluginStopAdmissionUncertainError, type PreparePluginStop, type PluginStopGuard } from "./stop-contract.js";
import {
  getOrInstallPluginOwnerRegistry,
  registerPluginOwner,
  type PluginLifecycleCoverage,
  type PluginOwnerRecord,
  type PluginOwnerRegistry,
} from "./owner-registry.js";
import type { PluginChange } from "./change-coordinator.js";

/** Module-owned query; must observe without reconciliation, admission changes or writes. */
export type PluginLifecycleQuery = (signal: AbortSignal) => PluginLifecycleStatus | Promise<PluginLifecycleStatus>;
export type { PluginLifecycleCoverage } from "./owner-registry.js";

interface QueryState {
  readonly fiberId: number;
  readonly pending: Set<AbortController>;
  running: boolean;
}

declare module "@deepseek-ai/cordis" {
  interface Context { pluginLifecycle: PluginLifecycleRegistry }
}

/** Optional adapter seam: standalone domains do not acquire a management dependency. */
export function registerPluginLifecycle(owner: Context, query: PluginLifecycleQuery, prepare?: PreparePluginStop): void {
  owner.root.get("pluginLifecycle")?.register(owner, query, prepare);
}

/** One declaration for owners whose existing stop guard is also their code-change fence.
 * Native HMR owns deactivation after every affected Consumer has been fenced; disable
 * continues to close Consumer -> Provider through the lifecycle coordinator.
 */
export function registerReplaceablePluginLifecycle(
  owner: Context,
  query: PluginLifecycleQuery,
  prepare: PreparePluginStop,
  replacement: "drain" | "generation" = "drain",
): void {
  registerPluginOwner(owner, {
    status: query,
    replacement,
    prepare: () => {
      const guard = prepare();
      return {
        // Long-lived leases are released by affected Consumers during native
        // teardown. Waiting for them before teardown would deadlock Providers.
        drained: Promise.resolve(),
        deactivate: () => Promise.resolve().then(() => guard.close()),
        release: () => guard.release(),
      };
    },
  });
}

export function installPluginLifecycle(
  root: Context,
  inspection: PluginInspection,
  options: { readonly queryTimeoutMs?: number } = {},
): PluginLifecycleInspection {
  if (root.fiber.uid !== 0) throw new Error("Plugin lifecycle must be installed on the process Root");
  if (root.get("pluginLifecycle") !== undefined) throw new Error("Plugin lifecycle is already installed");
  if (root.get("pluginInspection") !== inspection) throw new Error("Plugin lifecycle requires this Root's inspection");
  const registry = new PluginLifecycleRegistry(root, inspection, options.queryTimeoutMs ?? 1000,
    getOrInstallPluginOwnerRegistry(root));
  root.provide("pluginLifecycle", registry);
  // Keep the external Host read port distinct from the in-process registration seam.
  return Object.freeze({ collect: (selection: PluginSelection) => registry.collect(selection) });
}

/** Compatibility read/stop adapter over the Root-owned Owner Registry. */
export class PluginLifecycleRegistry implements PluginLifecycleInspection {
  private readonly queryStates = new Map<number, QueryState>();
  private revision = 0;
  private closed = false;
  private readonly observations = new WeakMap<PluginLifecycleCollection, number>();
  private readonly unsubscribeOwners: () => void;

  constructor(
    private readonly root: Context,
    private readonly inspection: PluginInspection,
    private readonly queryTimeoutMs: number,
    private readonly owners: PluginOwnerRegistry,
  ) {
    if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 30_000) {
      throw new TypeError("Plugin lifecycle query timeout must be between 1 and 30000 ms");
    }
    this.unsubscribeOwners = owners.subscribe(fiberId => {
      this.revision += 1;
      for (const [id, state] of this.queryStates) {
        if (state.fiberId !== fiberId) continue;
        for (const controller of state.pending) controller.abort();
        if (!state.running) this.queryStates.delete(id);
      }
    });
    root.effect(() => () => {
      this.closed = true;
      this.unsubscribeOwners();
      for (const state of this.queryStates.values()) for (const controller of state.pending) controller.abort();
      this.queryStates.clear();
    }, "plugin lifecycle registry");
    root.on("internal/update", async (_config, _noSave, next) => {
      this.revision += 1;
      try { await next(); } finally { this.revision += 1; }
    }, { global: true, prepend: true });
  }

  register(owner: Context, query: PluginLifecycleQuery, prepare?: PreparePluginStop): void {
    this.assertOpen();
    this.owners.registerLifecycle(owner, query, prepare);
  }
  coverage(id: number): PluginLifecycleCoverage {
    return this.owners.coverage(id).lifecycle;
  }
  registered(id: number): boolean { return this.coverage(id) !== "unregistered"; }

  async collect(selection: PluginSelection): Promise<PluginLifecycleCollection> {
    this.assertOpen();
    const observation = this.inspection.inspect();
    const impact = previewPluginSelection(observation, selection);
    const wanted = new Set(impact.affected.map(item => item.fiberId));
    for (const entry of observation.entries) {
      if (impact.gatedEntryIds.includes(entry.id) && entry.fiberId !== null) wanted.add(entry.fiberId);
    }
    const revision = this.revision;
    const selected = this.owners.recordsWithStatus().filter(record => wanted.has(record.fiberId));
    let owners: readonly PluginLifecycleOwnerView[] = await Promise.all(selected.map(async record => {
      const view = observation.fibers.find(fiber => fiber.id === record.fiberId);
      const status = await this.query(record);
      return Object.freeze({ registrationId: record.id, fiberId: record.fiberId,
        entryId: view?.entryId ?? null, entryRoot: view?.entryRoot ?? false, status });
    }));
    this.assertOpen();
    // Config/service changes and same-Fiber reactivation invalidate a concurrent query.
    // This is deliberately conservative, not a config CAS or a domain-state lock.
    if (revision !== this.revision || JSON.stringify(observation) !== JSON.stringify(this.inspection.inspect())) {
      owners = owners.map(owner => Object.freeze({ ...owner, status: blocked("lifecycle_observation_changed") }));
    }
    const byFiber = new Map(owners.map(owner => [owner.fiberId, owner]));
    const reports: PluginStopReport[] = [];
    for (const entryId of impact.gatedEntryIds) {
      const entry = observation.entries.find(item => item.id === entryId)!;
      const owner = entry.fiberId === null ? undefined : byFiber.get(entry.fiberId);
      const status = owner?.entryRoot ? owner.status : blocked("lifecycle_unassessed");
      reports.push(Object.freeze({ subject: Object.freeze({ kind: "entry", entryId }), disposition: status.disposition, code: status.code }));
    }
    for (const { fiberId } of impact.affected) {
      const status = byFiber.get(fiberId)?.status ?? blocked("lifecycle_unassessed");
      reports.push(Object.freeze({ subject: Object.freeze({ kind: "fiber", fiberId }), disposition: status.disposition, code: status.code }));
    }
    const result: PluginLifecycleCollection = Object.freeze({ observation,
      impact: Object.freeze({ gatedEntryIds: impact.gatedEntryIds, affected: impact.affected, coverage: impact.coverage, safety: impact.safety }),
      reports: Object.freeze(reports), owners: Object.freeze(owners),
      coverage: "registered-owners", configuration: "unknown", recovery: "unknown", admission: "unknown" });
    this.observations.set(result, revision);
    return result;
  }

  /** Internal execution seam. Never export guards or accept owner ids over the wire. */
  prepareStop(collection: PluginLifecycleCollection, selection: PluginSelection,
    change: PluginChange = { kind: "disable", source: "standalone-stop" }): {
    readonly guards: readonly PluginStopGuard[];
    /** Fence the next owner only after the previous Consumer has finished cleanup. */
    advance(): PluginStopGuard | undefined;
    currentOwnerStatus(): Promise<PluginLifecycleStatus>;
    current(): boolean; release(): void;
  } {
    this.assertOpen();
    const revision = this.observations.get(collection);
    const observation = collection.observation;
    const current = () => revision !== undefined && revision === this.revision && !this.closed &&
      JSON.stringify(observation) === JSON.stringify(this.inspection.inspect());
    if (!current()) throw new Error("stop_observation_changed");
    const impact = previewPluginSelection(observation, selection);
    const records = new Map(this.owners.recordsWithStatus().map(record => [record.fiberId, record]));
    const wanted = new Set(impact.affected.map(item => item.fiberId));
    // Child/consumer cleanup must precede its owned parent/provider. Reject cycles.
    const ordered: PluginOwnerRecord[] = [], visiting = new Set<number>(), visited = new Set<number>();
    const visit = (id: number) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error("stop_dependency_cycle");
      const record = records.get(id);
      if (!record?.canDisable || !this.live(record) ||
        !collection.owners.some(owner => owner.registrationId === record.id && owner.fiberId === id)) {
        throw new Error("stop_owner_unsupported");
      }
      visiting.add(id);
      for (const fiber of observation.fibers) {
        if (wanted.has(fiber.id) && (fiber.parentId === id || fiber.dependencies.some(dep => dep.providerFiberId === id))) visit(fiber.id);
      }
      visiting.delete(id); visited.add(id); ordered.push(record);
    };
    for (const id of wanted) visit(id);
    const guards: PluginStopGuard[] = [];
    const release = () => {
      let failed = false;
      for (const guard of [...guards].reverse()) {
        try { guard.release(); } catch { failed = true; }
      }
      if (failed) throw new PluginStopAdmissionUncertainError();
    };
    let next = 0;
    const advance = () => {
      if (!current()) throw new Error("stop_observation_changed");
      const record = ordered[next];
      if (!record) return undefined;
      const prepared = this.owners.prepare(record, change);
      const guard: PluginStopGuard = {
        close: async () => { await prepared.drained; await prepared.deactivate(); },
        release: () => prepared.release(),
      };
      guards.push(guard); next++;
      return guard;
    };
    try { advance(); } catch (error) {
      release();
      throw error;
    }
    // Simultaneously fencing Providers would interrupt an admitted Consumer
    // that calls its dependencies later while draining.
    return { get guards() { return Object.freeze([...guards]); }, advance, current, release,
      currentOwnerStatus: () => this.query(ordered[next - 1]!),
    };
  }

  private live(record: PluginOwnerRecord): boolean {
    return !this.closed && this.owners.current(record) &&
      record.fiber.uid === record.fiberId && record.fiber.entry === record.entry &&
      record.fiber.state === FiberState.ACTIVE;
  }

  private async query(record: PluginOwnerRecord): Promise<PluginLifecycleStatus> {
    if (!this.live(record)) return blocked("lifecycle_owner_inactive");
    const state = this.queryStates.get(record.id) ?? { fiberId: record.fiberId, pending: new Set<AbortController>(), running: false };
    this.queryStates.set(record.id, state);
    if (state.running) return blocked("lifecycle_query_pending");
    state.running = true;
    const controller = new AbortController();
    state.pending.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<PluginLifecycleStatus>(resolve => {
        onAbort = () => resolve(blocked("lifecycle_owner_changed"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          resolve(blocked("lifecycle_query_timeout"));
          controller.abort();
        }, this.queryTimeoutMs);
        // Both branches handle late completion/rejection after timeout or disposal.
        void Promise.resolve().then(() => {
          if (!this.live(record) || controller.signal.aborted) return blocked("lifecycle_owner_changed");
          return record.status!(controller.signal);
        }).then(value => {
          state.running = false;
          resolve(this.live(record) && !controller.signal.aborted ? snapshotStatus(value) : blocked("lifecycle_owner_changed"));
        }, () => {
          state.running = false;
          resolve(blocked("lifecycle_query_failed"));
        });
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) controller.signal.removeEventListener("abort", onAbort);
      state.pending.delete(controller);
      if (!state.running && !state.pending.size) this.queryStates.delete(record.id);
    }
  }

  private assertOpen(): void {
    if (this.closed || this.root.fiber.state !== FiberState.ACTIVE) throw new Error("Plugin lifecycle is closed");
  }
}

function blocked(code: string): PluginLifecycleStatus {
  return Object.freeze({ disposition: "blocked", code });
}

function snapshotStatus(value: PluginLifecycleStatus): PluginLifecycleStatus {
  try {
    if (!value || !["direct", "drain", "blocked", "maintenance", "restart"].includes(value.disposition) ||
      typeof value.code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/u.test(value.code)) return blocked("lifecycle_query_invalid");
    if (value.counts === undefined) return Object.freeze({ disposition: value.disposition, code: value.code });
    if (!value.counts || typeof value.counts !== "object" || Array.isArray(value.counts)) return blocked("lifecycle_query_invalid");
    const entries = Object.entries(value.counts);
    if (entries.length > 16 || entries.some(([key, count]) => !/^[a-z][a-z0-9_]{0,47}$/u.test(key) ||
      !Number.isSafeInteger(count) || count < 0)) return blocked("lifecycle_query_invalid");
    return Object.freeze({ disposition: value.disposition, code: value.code, counts: Object.freeze(Object.fromEntries(entries)) });
  } catch {
    return blocked("lifecycle_query_invalid");
  }
}
