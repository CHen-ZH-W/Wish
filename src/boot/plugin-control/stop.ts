import { randomUUID } from "node:crypto";
import { FiberState, type Context, type Fiber } from "@deepseek-ai/cordis";
import { assessPluginDisable } from "./assessment.js";
import { previewPluginSelection } from "./selection.js";
import type { PluginInspection } from "./types.js";
import type { PluginOperationState, PluginSelection, PluginStopControl, PluginStopOperation } from "./management-types.js";
import { PluginStopAdmissionUncertainError, type PluginDisableReservation, type PluginStopHost } from "./stop-contract.js";
import type { PluginLifecycleRegistry } from "./lifecycle.js";
import { getOrInstallPluginChangeCoordinator, type PluginChangeScope } from "./change-coordinator.js";
import { SafePluginChangeTransaction } from "./safe-change.js";

/** Internal composition port: nested management changes reuse their top-level scope. */
export interface PluginStopAdapter extends PluginStopControl {
  disableWithin(selection: PluginSelection, scope: PluginChangeScope): Promise<PluginStopOperation>;
}

declare module "@deepseek-ai/cordis" {
  interface Context { pluginStopControl: PluginStopControl }
}

/** Root-owned coordinator. No module names, business state, config files or HTTP here. */
export function installPluginStopControl(
  root: Context,
  inspection: PluginInspection,
  options: { readonly host?: PluginStopHost; readonly timeoutMs?: number } = {},
): PluginStopAdapter {
  if (root.fiber.uid !== 0 || root.get("pluginInspection") !== inspection || !root.get("pluginLifecycle")) {
    throw new Error("Plugin stop requires this Root's inspection and lifecycle registry");
  }
  if (root.get("pluginStopControl") !== undefined) throw new Error("Plugin stop control is already installed");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("Invalid plugin stop timeout");
  const lifecycle = root.get("pluginLifecycle")!;
  const changes = getOrInstallPluginChangeCoordinator(root);
  let closed = false, busy = false, recoveryRequired = false;
  let latest: PluginStopOperation | null = null;
  let active: AbortController | undefined;
  root.effect(() => () => { closed = true; active?.abort(); }, "plugin stop control");
  const result = (selection: PluginSelection, state: PluginOperationState, id = randomUUID()): PluginStopOperation =>
    Object.freeze({ id, selection, state: Object.freeze(state) });
  const execute = async (selection: PluginSelection, scope: PluginChangeScope): Promise<PluginStopOperation> => {
    const reject = (code: string) => result(selection, { phase: "rejected", code, changed: false });
    if (closed || root.fiber.state !== FiberState.ACTIVE) return reject("stop_control_closed");
    if (recoveryRequired) return reject("stop_recovery_required");
    if (busy) return reject("stop_operation_in_progress");
    if (!options.host) return reject("stop_host_unavailable");
    busy = true;
    const controller = new AbortController(); active = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const id = randomUUID();
    const transaction = new SafePluginChangeTransaction();
    const set = (state: PluginOperationState) => { latest = result(selection, state, id); };
    set({ phase: "checking" });
    let reservation: PluginDisableReservation | undefined;
    let prepared: ReturnType<PluginLifecycleRegistry["prepareStop"]> | undefined;
    let dormantObservation: ReturnType<PluginInspection["inspect"]> | undefined;
    let closing = false, cleaned = false, applying = false;
    let phaseCode = "stop_query_failed";
    const check = () => {
      if (signal.aborted) throw new StopError(closed ? "stop_control_closed" : "stop_timeout");
      if (reservation && !reservation.current()) throw new StopError("stop_configuration_changed");
      if (prepared && !prepared.current()) throw new StopError("stop_observation_changed");
      if (dormantObservation && JSON.stringify(dormantObservation) !== JSON.stringify(inspection.inspect())) {
        throw new StopError("stop_observation_changed");
      }
    };
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const collection = await bounded(lifecycle.collect(selection), signal);
      check();
      const impact = previewPluginSelection(collection.observation, selection);
      const dormant = isDormantImpact(root, impact);
      if (!dormant && impact.affected.some(({ fiberId }) => {
        const fiber = impact.snapshot.fibers.find(item => item.id === fiberId);
        const entry = fiber?.entryId ? impact.snapshot.entries.find(item => item.id === fiber.entryId) : undefined;
        return entry?.managementClass === "managed" && root.get("pluginOwners")?.record(fiberId)?.canonical !== true;
      })) throw new StopError("stop_owner_unsupported");
      if (collection.owners.some(owner => owner.status.disposition === "restart")) throw new StopError("stop_restart_required");
      // A group carrier/absent target needs a separate configuration-only protocol.
      if (impact.gatedEntryIds.some(entryId => {
        const entry = impact.snapshot.entries.find(item => item.id === entryId)!;
        return entry.kind !== "plugin" || (!dormant && entry.phase !== "active") || entry.enabled !== true;
      })) throw new StopError("stop_target_not_active");
      phaseCode = "stop_reservation_failed";
      reservation = options.host.reserve(impact);
      check();
      phaseCode = "stop_prepare_failed";
      await scope.phase("fencing");
      if (dormant) {
        // PENDING/FAILED before apply owns no admitted work. Retain the exact
        // observation through the switch so a dependency activation cannot race
        // this configuration-only stop.
        dormantObservation = collection.observation;
        check();
        await scope.phase("draining");
        set({ phase: "stopping" }); phaseCode = "stop_cleanup_failed";
        transaction.changed();
        cleaned = true;
      } else {
        // Verify support for every affected owner before installing any admission fence.
        prepared = lifecycle.prepareStop(collection, selection, scope.change);
        check();
        const guarded = await bounded(lifecycle.collect(selection), signal);
        check();
        const assessment = assessPluginDisable(guarded.observation, selection, {
          ...guarded, configuration: "managed", recovery: "available", admission: "guarded",
        });
        if (assessment.disposition !== "direct" && assessment.disposition !== "drain") {
          throw new StopError("stop_lifecycle_blocked");
        }
        await scope.phase("draining");
        set({ phase: "stopping" }); phaseCode = "stop_cleanup_failed";
        for (let guard = prepared.guards[0]; guard; guard = prepared.advance()) {
          check();
          // Owners not yet fenced may acquire work while their Consumers drain.
          // Reassess after each fence, before starting that owner's cleanup.
          const current = await bounded(prepared.currentOwnerStatus(), signal);
          check();
          // Closed Consumers report blocked, so only inspect the newly fenced
          // owner's condition; prepareStop validates the entire support graph.
          if (current.disposition !== "direct" && current.disposition !== "drain") {
            throw new StopError("stop_lifecycle_blocked");
          }
          if (!closing) transaction.changed();
          closing = true;
          await bounded(Promise.resolve().then(() => { check(); return guard.close(); }), signal);
        }
        cleaned = true;
      }
      transaction.retain({ restore: () => reservation!.restore(), verify: () => reservation!.verifyRestored() });
      check();
      if (scope.change.kind === "disable") await scope.phase("switching");
      set({ phase: "applying" }); phaseCode = "stop_apply_failed";
      applying = true;
      await bounded(Promise.resolve().then(() => { check(); return reservation!.apply(); }), signal);
      // Applying intentionally disposes owners; the old graph identity is now obsolete.
      if (signal.aborted) throw new StopError("stop_timeout");
      if (scope.change.kind === "disable") await scope.phase("retiring");
      set({ phase: "verifying" }); phaseCode = "stop_verification_failed";
      if (scope.change.kind === "disable") await scope.phase("verifying");
      if (!await bounded(reservation.verify(), signal)) throw new StopError(phaseCode);
      const after = inspection.inspect();
      if (impact.gatedEntryIds.some(entryId => after.entries.find(entry => entry.id === entryId)?.enabled !== false) ||
        impact.affected.some(({ fiberId }) => after.fibers.some(fiber => fiber.id === fiberId &&
          fiber.phase !== "pending" && fiber.phase !== "disposed"))) throw new StopError(phaseCode);
      transaction.commit();
      set({ phase: "succeeded", runtime: "confirmed", cleanup: "confirmed", persistence: "not-requested" });
    } catch (error) {
      let uncertain = error instanceof PluginStopAdmissionUncertainError;
      let code = uncertain ? "stop_admission_uncertain" : signal.aborted ? (closed ? "stop_control_closed" : "stop_timeout")
        : error instanceof StopError ? error.code
        : error instanceof Error && ["stop_owner_unsupported", "stop_dependency_cycle", "stop_observation_changed"].includes(error.message)
          ? error.message : phaseCode;
      if (!closing) {
        try { prepared?.release(); }
        catch { uncertain = true; code = "stop_admission_uncertain"; }
      }
      const outcome = uncertain || signal.aborted
        ? { phase: "recovery-required" as const, code, restored: false as const }
        : await transaction.fail({ rejected: code, rolledBack: "stop_change_rolled_back", recovery: code });
      recoveryRequired = outcome.phase === "recovery-required";
      if (recoveryRequired) {
        // Never reopen admission or replay a partially completed side effect.
        set({ phase: "failed", code, runtime: applying || uncertain ? "unknown" : "changed", persistence: "unchanged",
          cleanup: uncertain ? "unknown" : cleaned ? "confirmed" : signal.aborted ? "pending" : "failed" });
      } else set({ phase: "rejected", code: outcome.code, changed: false });
    } finally {
      clearTimeout(timer); active = undefined;
      // An unresolved apply still owns its config lock. Releasing on timeout would
      // let a later writer race the old operation. Recovery is intentionally explicit.
      if (!recoveryRequired) {
        try { reservation?.release(); }
        catch {
          recoveryRequired = true;
          set({ phase: "failed", code: "stop_reservation_release_failed", runtime: closing ? "changed" : "unchanged",
            persistence: "unchanged", cleanup: cleaned ? "confirmed" : "unknown" });
        }
      }
      busy = false;
    }
    return latest!;
  };
  const port: PluginStopAdapter = Object.freeze({
    current: () => latest,
    async disable(input: PluginSelection): Promise<PluginStopOperation> {
      // Clone/validate now, before the first await or any client mutation of input.
      const selection = previewPluginSelection(inspection.inspect(), input).selection;
      const reject = (code: string) => result(selection, { phase: "rejected", code, changed: false });
      if (closed || root.fiber.state !== FiberState.ACTIVE) return reject("stop_control_closed");
      if (recoveryRequired) return reject("stop_recovery_required");
      if (busy || changes.snapshot().active) return reject("stop_operation_in_progress");
      if (!options.host) return reject("stop_host_unavailable");
      return changes.run({ kind: "disable", source: "standalone-stop", entryIds: selection.entryIds }, async scope => {
        const operation = await execute(selection, scope);
        if (operation.state.phase === "failed") await scope.recovery(operation.state.code);
        else if (operation.state.phase === "rejected" || operation.state.phase === "conflict") await scope.reject(operation.state.code);
        return operation;
      });
    },
    disableWithin: (input: PluginSelection, scope: PluginChangeScope) =>
      execute(previewPluginSelection(inspection.inspect(), input).selection, scope),
  });
  root.provide("pluginStopControl", port);
  return port;
}

function isDormantImpact(root: Context, impact: ReturnType<typeof previewPluginSelection>): boolean {
  if (!impact.affected.length || impact.gatedEntryIds.some(entryId => {
    const entry = impact.snapshot.entries.find(item => item.id === entryId);
    return entry?.kind !== "plugin" || entry.enabled !== true || (entry.phase !== "pending" && entry.phase !== "failed");
  })) return false;
  const fibers = new Map<number, Fiber>();
  for (const runtime of root.registry.values()) for (const fiber of runtime.fibers) {
    if (fiber.uid !== null) fibers.set(fiber.uid, fiber);
  }
  return impact.affected.every(({ fiberId }) => {
    const observed = impact.snapshot.fibers.find(item => item.id === fiberId);
    const fiber = fibers.get(fiberId);
    return !!fiber && (observed?.phase === "pending" || observed?.phase === "failed") &&
      (fiber.state === FiberState.PENDING || fiber.state === FiberState.FAILED) && !fiber.inertia && fiber.getEffects().length === 0;
  });
}

class StopError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** The deadline bounds the caller, not the lifetime of owned work. Late rejection is consumed. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new StopError("stop_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
