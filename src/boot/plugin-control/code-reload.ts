import { FiberState, type Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";
import type { PluginInspection, PluginInspectionSnapshot } from "./types.js";

interface ExecutionBoundary {
  replace(update: () => Promise<void>, options: { readonly signal: AbortSignal }): Promise<void>;
  snapshot(): { readonly phase: string };
}
type Batch = ReadonlyMap<Plugin, { readonly filename: string; readonly runtime?: Plugin.Runtime }>;
export interface CodeReloadSnapshot {
  readonly phase: "idle" | "draining" | "applying" | "succeeded" | "rejected" | "recovery-required" | "closed";
  readonly revision: number;
  readonly code: string | null;
  readonly entryIds: readonly string[];
}
export interface CodeReloadInspection {
  snapshot(): CodeReloadSnapshot;
  subscribe(listener: () => void): () => void;
}
/** Host-only persistence permit, valid only inside its serialized native batch. */
export interface CodeReloadPermit {
  apply(entryIds: readonly string[], update: () => Promise<void>): Promise<void>;
}
export interface CodeReloadTransaction {
  run(signal: AbortSignal, batch: (permit: CodeReloadPermit) => Promise<void>): Promise<void>;
}
/** Module-owned admission fence. Host knows only draining, never domain state.
 * Called consumer-first after all current Steps complete. Must seal admission
 * synchronously; admitted work drains against still-live dependencies.
 */
export interface CodeReloadParticipant {
  prepare(): { readonly drained: Promise<void>; release(): void | Promise<void> };
}
declare module "@deepseek-ai/cordis" {
  interface Context { codeReload: CodeReloadCoordinator }
}

export function installCodeReload(root: Context, inspection: PluginInspection): CodeReloadInspection {
  if (Hmr.coordinationVersion !== 3) throw new Error("Cordis HMR coordination patch missing; run npm run build before starting Wish");
  const coordinator = new CodeReloadCoordinator(root, inspection);
  root.provide("codeReload", coordinator);
  return Object.freeze({ snapshot: () => coordinator.snapshot(), subscribe: (listener: () => void) => coordinator.subscribe(listener) });
}

/** Root-owned lifecycle adapter. Native HMR still owns module analysis, caches and replacement. */
class CodeReloadCoordinator implements CodeReloadInspection {
  private readonly safe = new Map<number, { fiber: Fiber; participant?: CodeReloadParticipant }>();
  private readonly boundaries = new Map<number, ExecutionBoundary>();
  private readonly starts = new Map<number, () => void>();
  private readonly closing = new AbortController();
  private readonly listeners = new Set<() => void>();
  private configRevision = 0;
  private busy = false;
  private transaction?: CodeReloadTransaction;
  private permit: CodeReloadPermit | undefined;
  private view: CodeReloadSnapshot = Object.freeze({ phase: "idle", revision: 0, code: null, entryIds: Object.freeze([]) });

  constructor(private readonly root: Context, private readonly inspection: PluginInspection) {
    const coordinator = this;
    root.on("internal/config", function (config, next) {
      const value = next();
      // Managed config has one owner. Even an explicitly addressed native HMR
      // entry must not refresh Include trees outside that owner's transaction.
      return coordinator.transaction && this.runtime?.callback === Hmr ? { ...value, watchConfig: false } : value;
    }, { global: true, prepend: true });
    root.on("hmr/reload-batch", (signal, next) => {
      if (!this.transaction) return next();
      return this.transaction.run(signal, async permit => {
        if (this.permit) throw Error("code_reload_batch_overlap");
        this.permit = permit;
        try { await next(); } finally { this.permit = undefined; }
      });
    }, { global: true, prepend: true });
    root.on("internal/update", async (_config, _noSave, next) => {
      this.configRevision++; try { await next(); } finally { this.configRevision++; }
    }, { global: true, prepend: true });
    root.on("hmr/reload-prepare", (batch, signal, next) => this.coordinate(batch, signal, next), { global: true, prepend: true });
    root.on("hmr/reload-failed", (_error, phase) => {
      if (this.closing.signal.aborted || this.view.phase === "recovery-required" || (phase === "prepare" && this.view.phase === "rejected")) return;
      this.set(phase === "apply" ? "recovery-required" : "rejected", `code_reload_${phase}_failed`);
    }, { global: true });
    root.on("hmr/restart", () => {
      // A framework/Boot edit must not silently exit a Host with live Runs.
      if (!this.busy && this.view.phase !== "recovery-required") this.set("rejected", "code_reload_restart_required");
    }, { global: true });
    root.effect(() => () => {
      this.closing.abort(new Error("code_reload_closed"));
      this.set("closed", "code_reload_closed"); this.listeners.clear();
    }, "code reload coordination");
  }

  snapshot(): CodeReloadSnapshot { return this.view; }
  attachTransaction(transaction: CodeReloadTransaction): void {
    if (this.transaction || this.busy || this.closing.signal.aborted) throw Error("code_reload_transaction_unavailable");
    this.transaction = transaction;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  register(owner: Context, participant?: CodeReloadParticipant): void {
    const id = this.ownerId(owner);
    owner.effect(() => { this.safe.set(id, { fiber: owner.fiber, ...(participant ? { participant } : {}) }); return () => { this.safe.delete(id); }; }, "code-reloadable owner");
  }
  registerBoundary(owner: Context, boundary: ExecutionBoundary): void {
    const id = this.ownerId(owner);
    owner.effect(() => { this.boundaries.set(id, boundary); return () => { this.boundaries.delete(id); }; }, "code reload execution boundary");
  }
  /** New background dispatchers must not start before the durable receipt.
   * Reconciliation/Service.init must finish without waiting for this callback.
   * The callback only opens local admission; it must not throw or await work.
   */
  startWhenReady(owner: Context, start: () => void): void {
    const id = this.ownerId(owner);
    if (!this.safe.has(id)) throw Error("code_reload_owner_unsupported");
    if (this.view.phase !== "applying" && this.view.phase !== "recovery-required") { start(); return; }
    owner.effect(() => { this.starts.set(id, start); return () => { this.starts.delete(id); }; }, "post-reload activation");
  }
  private ownerId(owner: Context): number {
    if (owner.root !== this.root.root || owner.fiber.uid === null || this.closing.signal.aborted) throw Error("code_reload_owner_unavailable");
    return owner.fiber.uid;
  }
  private async coordinate(batch: Batch, signal: AbortSignal, apply: () => Promise<void>): Promise<void> {
    if (this.transaction && !this.permit) throw Error("code_reload_transaction_required");
    if (this.busy || this.view.phase === "recovery-required" || this.closing.signal.aborted) throw Error("code_reload_unavailable");
    this.busy = true;
    let applying = false;
    try {
      const before = this.inspection.inspect(), configRevision = this.configRevision;
      const affected = this.affected(batch, before);
      const entries = before.fibers.filter(fiber => affected.has(fiber.id) && fiber.entryId).map(fiber => fiber.entryId!);
      this.set("draining", null, [...new Set(entries)].sort());
      for (const id of affected) {
        if (!this.safe.has(id) || this.boundaries.has(id)) throw Error("code_reload_owner_unsupported");
      }
      const boundaries = [...this.boundaries.values()];
      const combined = AbortSignal.any([signal, this.closing.signal]);
      const applyAtBoundary = async (index: number): Promise<void> => {
        if (index < boundaries.length) return boundaries[index]!.replace(() => applyAtBoundary(index + 1), { signal: combined });
        combined.throwIfAborted();
        if (configRevision !== this.configRevision || JSON.stringify(before) !== JSON.stringify(this.inspection.inspect())) {
          throw Error("code_reload_graph_changed");
        }
        const update = async () => {
          applying = true; this.set("applying", null);
          await apply();
          const after = this.inspection.inspect();
          // Stable owners must survive; newly activated owners must renew their
          // declaration before the barrier admits another Step.
          for (const old of before.fibers) {
            if (!affected.has(old.id) && !after.fibers.some(fiber => fiber.id === old.id && fiber.phase === old.phase)) {
              throw Error("code_reload_unexpected_impact");
            }
          }
          for (const entryId of entries) {
            const current = after.entries.find(entry => entry.id === entryId);
            if (!current || current.phase !== "active" || current.fiberId === null || !this.safe.has(current.fiberId)) {
              throw Error("code_reload_owner_not_restored");
            }
          }
        };
        // The durable success receipt must land before the Step barrier reopens.
        const prepared: ReturnType<CodeReloadParticipant["prepare"]>[] = [];
        try {
          for (const id of this.consumerOrder(affected, before)) {
            combined.throwIfAborted();
            const participant = this.safe.get(id)?.participant;
            if (!participant) continue;
            const fence = participant.prepare(); prepared.push(fence);
            await fence.drained;
          }
          combined.throwIfAborted();
          if (configRevision !== this.configRevision || JSON.stringify(before) !== JSON.stringify(this.inspection.inspect())) {
            throw Error("code_reload_graph_changed");
          }
          if (this.permit) await this.permit.apply([...new Set(entries)].sort(), update);
          else await update();
          const starts = [...this.starts.values()]; this.starts.clear();
          for (const start of starts) start();
        } finally {
          // Before disposal the old implementations can resume. Once apply has
          // begun, never reopen old references after partial replacement.
          if (!applying) for (const fence of prepared.reverse()) await fence.release();
        }
      };
      await applyAtBoundary(0);
      this.set("succeeded", "code_reload_applied");
    } catch (error) {
      const fenced = [...this.boundaries.values()].some(boundary => boundary.snapshot().phase === "failed");
      if (!this.closing.signal.aborted) this.set(applying || fenced ? "recovery-required" : "rejected",
        error instanceof Error && /^code_reload_[a-z_]+$/.test(error.message) ? error.message : "code_reload_failed");
      throw error;
    } finally { this.busy = false; }
  }
  private consumerOrder(affected: Set<number>, snapshot: PluginInspectionSnapshot): number[] {
    const pending = new Set(affected), order: number[] = [];
    while (pending.size) {
      const leaves = [...pending].filter(id => !snapshot.fibers.some(fiber => pending.has(fiber.id) && fiber.id !== id &&
        (fiber.parentId === id || fiber.dependencies.some(dep => dep.providerFiberId === id))));
      if (!leaves.length) throw Error("code_reload_dependency_cycle");
      for (const id of leaves) { pending.delete(id); order.push(id); }
    }
    return order;
  }
  private affected(batch: Batch, snapshot: PluginInspectionSnapshot): Set<number> {
    const ids = new Set<number>();
    for (const { runtime } of batch.values()) for (const fiber of runtime?.fibers ?? []) {
      if (fiber.uid === null || fiber.state !== FiberState.ACTIVE) throw Error("code_reload_target_unsettled");
      ids.add(fiber.uid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const fiber of snapshot.fibers) {
        if (ids.has(fiber.id)) continue;
        if ((fiber.parentId !== null && ids.has(fiber.parentId)) || fiber.dependencies.some(dep => dep.providerFiberId !== null && ids.has(dep.providerFiberId))) {
          ids.add(fiber.id); changed = true;
        }
      }
    }
    for (const id of ids) if (!snapshot.fibers.some(fiber => fiber.id === id && fiber.phase === "active")) throw Error("code_reload_target_unobserved");
    return ids;
  }
  private set(phase: CodeReloadSnapshot["phase"], code: string | null, entryIds = this.view.entryIds): void {
    this.view = Object.freeze({ phase, code, entryIds: Object.freeze([...entryIds]), revision: this.view.revision + 1 });
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* observers cannot govern cleanup */ } }
  }
}
