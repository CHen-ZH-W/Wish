import { randomUUID } from "node:crypto";
import { FiberState, type Context } from "@deepseek-ai/cordis";
import { assessPluginDisable } from "./assessment.js";
import { previewPluginSelection } from "./selection.js";
import type { PluginInspection } from "./types.js";
import type { PluginOperationState, PluginSelection, PluginStopControl, PluginStopOperation } from "./management-types.js";
import { PluginStopAdmissionUncertainError, type PluginDisableReservation, type PluginStopHost } from "./stop-contract.js";
import type { PluginLifecycleRegistry } from "./lifecycle.js";

declare module "@deepseek-ai/cordis" {
  interface Context { pluginStopControl: PluginStopControl }
}

/** Root-owned coordinator. No module names, business state, config files or HTTP here. */
export function installPluginStopControl(
  root: Context,
  inspection: PluginInspection,
  options: { readonly host?: PluginStopHost; readonly timeoutMs?: number } = {},
): PluginStopControl {
  if (root.fiber.uid !== 0 || root.get("pluginInspection") !== inspection || !root.get("pluginLifecycle")) {
    throw new Error("Plugin stop requires this Root's inspection and lifecycle registry");
  }
  if (root.get("pluginStopControl") !== undefined) throw new Error("Plugin stop control is already installed");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("Invalid plugin stop timeout");
  const lifecycle = root.get("pluginLifecycle")!;
  let closed = false, busy = false, recoveryRequired = false;
  let latest: PluginStopOperation | null = null;
  let active: AbortController | undefined;
  root.effect(() => () => { closed = true; active?.abort(); }, "plugin stop control");
  const result = (selection: PluginSelection, state: PluginOperationState, id = randomUUID()): PluginStopOperation =>
    Object.freeze({ id, selection, state: Object.freeze(state) });
  const port: PluginStopControl = Object.freeze({
    current: () => latest,
    async disable(input: PluginSelection): Promise<PluginStopOperation> {
      // Clone/validate now, before the first await or any client mutation of input.
      const selection = previewPluginSelection(inspection.inspect(), input).selection;
      const reject = (code: string) => result(selection, { phase: "rejected", code, changed: false });
      if (closed || root.fiber.state !== FiberState.ACTIVE) return reject("stop_control_closed");
      if (recoveryRequired) return reject("stop_recovery_required");
      if (busy) return reject("stop_operation_in_progress");
      if (!options.host) return reject("stop_host_unavailable");
      busy = true;
      const controller = new AbortController(); active = controller;
      const id = randomUUID();
      const set = (state: PluginOperationState) => { latest = result(selection, state, id); };
      set({ phase: "checking" });
      let reservation: PluginDisableReservation | undefined;
      let prepared: ReturnType<PluginLifecycleRegistry["prepareStop"]> | undefined;
      let closing = false, cleaned = false, applying = false;
      let phaseCode = "stop_query_failed";
      const check = () => {
        if (controller.signal.aborted) throw new StopError(closed ? "stop_control_closed" : "stop_timeout");
        if (reservation && !reservation.current()) throw new StopError("stop_configuration_changed");
        if (prepared && !prepared.current()) throw new StopError("stop_observation_changed");
      };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const collection = await bounded(lifecycle.collect(selection), controller.signal);
        check();
        const impact = previewPluginSelection(collection.observation, selection);
        // A group carrier/absent target needs a separate configuration-only protocol.
        if (impact.gatedEntryIds.some(entryId => {
          const entry = impact.snapshot.entries.find(item => item.id === entryId)!;
          return entry.kind !== "plugin" || entry.phase !== "active" || entry.enabled !== true;
        })) throw new StopError("stop_target_not_active");
        phaseCode = "stop_reservation_failed";
        reservation = options.host.reserve(impact);
        check();
        phaseCode = "stop_prepare_failed";
        // Verify support for every affected owner before installing any admission fence.
        prepared = lifecycle.prepareStop(collection, selection);
        check();
        const guarded = await bounded(lifecycle.collect(selection), controller.signal);
        check();
        const assessment = assessPluginDisable(guarded.observation, selection, {
          ...guarded, configuration: "managed", recovery: "available", admission: "guarded",
        });
        if (assessment.disposition !== "direct" && assessment.disposition !== "drain") {
          throw new StopError("stop_lifecycle_blocked");
        }
        set({ phase: "stopping" }); phaseCode = "stop_cleanup_failed";
        for (const guard of prepared.guards) {
          check();
          closing = true;
          await bounded(Promise.resolve().then(() => { check(); return guard.close(); }), controller.signal);
        }
        cleaned = true;
        check();
        set({ phase: "applying" }); phaseCode = "stop_apply_failed";
        applying = true;
        await bounded(Promise.resolve().then(() => { check(); return reservation!.apply(); }), controller.signal);
        // Applying intentionally disposes owners; the old graph identity is now obsolete.
        if (controller.signal.aborted) throw new StopError("stop_timeout");
        set({ phase: "verifying" }); phaseCode = "stop_verification_failed";
        if (!await bounded(reservation.verify(), controller.signal)) throw new StopError(phaseCode);
        const after = inspection.inspect();
        if (impact.gatedEntryIds.some(entryId => after.entries.find(entry => entry.id === entryId)?.enabled !== false) ||
          impact.affected.some(({ fiberId }) => after.fibers.some(fiber => fiber.id === fiberId &&
            fiber.phase !== "pending" && fiber.phase !== "disposed"))) throw new StopError(phaseCode);
        set({ phase: "succeeded", runtime: "confirmed", cleanup: "confirmed", persistence: "not-requested" });
      } catch (error) {
        let uncertain = error instanceof PluginStopAdmissionUncertainError;
        let code = uncertain ? "stop_admission_uncertain" : controller.signal.aborted ? (closed ? "stop_control_closed" : "stop_timeout")
          : error instanceof StopError ? error.code
          : error instanceof Error && ["stop_owner_unsupported", "stop_dependency_cycle", "stop_observation_changed"].includes(error.message)
            ? error.message : phaseCode;
        if (!closing) {
          try { prepared?.release(); }
          catch { uncertain = true; code = "stop_admission_uncertain"; }
        } else recoveryRequired = true;
        if (uncertain) recoveryRequired = true;
        if (recoveryRequired) {
          // Never reopen admission or replay a partially completed side effect.
          set({ phase: "failed", code, runtime: applying || uncertain ? "unknown" : "changed", persistence: "unchanged",
            cleanup: uncertain ? "unknown" : cleaned ? "confirmed" : controller.signal.aborted ? "pending" : "failed" });
        } else set({ phase: "rejected", code, changed: false });
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
    },
  });
  root.provide("pluginStopControl", port);
  return port;
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
