import { randomUUID } from "node:crypto";
import { FiberState, type Context } from "@deepseek-ai/cordis";
import { installPluginStopControl } from "./stop.js";
import { previewPluginSelection } from "./selection.js";
import { managementFingerprint, ManagedPluginStore, ManagedPluginStoreError } from "./managed-store.js";
import { ManagedProfile, ManagedProfileError, ManagedProfileSource } from "./managed-profile.js";
import type { ManagedPluginPreference, ManagedPluginReceipt, ManagedPluginRequest, ManagedPluginSnapshot } from "./managed-types.js";
import type { PluginInspection } from "./types.js";
import type { PluginSelection, PluginSelectionImpact, PluginStopControl } from "./management-types.js";
import type { PluginDisableReservation } from "./stop-contract.js";
import type { CodeReloadInspection, CodeReloadPermit } from "./code-reload.js";

export class PluginManagementError extends Error { constructor(readonly code: string) { super(code); } }

/** Root coordinator: durable intents and receipts, not a second business state machine. */
export class ManagedPluginControl {
  readonly stops: PluginStopControl;
  private profile?: ManagedProfile;
  private busy = false;
  private closed = false;
  private recoveryAvailable = false;
  private recoveryRequired: boolean;
  private active: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private watching = false;
  private configurationPhase: ManagedPluginSnapshot["configuration"]["phase"] = "idle";
  private configurationCode: string | null = null;
  private configurationRequest: ManagedPluginRequest | undefined;
  private configurationStop: PluginSelection | undefined;
  private readonly closing = new AbortController();
  private codeReload?: CodeReloadInspection;
  private removeCodeReload?: () => void;
  constructor(root: Context, private readonly inspection: PluginInspection, private readonly store: ManagedPluginStore) {
    this.recoveryRequired = store.snapshot().pending !== null;
    this.stops = installPluginStopControl(root, inspection, { host: { reserve: impact => this.reserve(impact) } });
  }
  attach(profile: ManagedProfile): void {
    if (this.profile) throw new PluginManagementError("management_profile_exists");
    this.profile = profile; this.emit();
  }
  /** Set only by the Root-owned listener, never by a request body. */
  setRecoveryAvailable(value: boolean): void { this.recoveryAvailable = value; this.emit(); }
  attachCodeReload(inspection: CodeReloadInspection): void {
    if (this.codeReload || this.closed) throw new PluginManagementError("management_code_reload_unavailable");
    this.codeReload = inspection;
    this.removeCodeReload = inspection.subscribe(() => {
      if (inspection.snapshot().phase === "recovery-required") this.recoveryRequired = true;
      this.emit();
    });
  }
  snapshot(): ManagedPluginSnapshot {
    const state = this.store.snapshot();
    return Object.freeze({ codeReload: this.codeReload?.snapshot() ?? null, inspection: this.inspection.inspect(), revision: state.revision, preferences: state.preferences,
      controls: this.profile?.controls() ?? Object.freeze({}),
      pending: state.pending, status: this.recoveryRequired ? "recovery-required" : this.busy ? "working" : "ready",
      writable: !this.closed && this.recoveryAvailable && !!this.profile?.healthy(),
      operation: this.stops.current(), lastReceipt: state.receipts.at(-1) ?? null,
      configuration: Object.freeze({ watching: this.watching, phase: this.configurationPhase,
        digest: this.profile?.source.digest ?? null, code: this.configurationCode }) });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Root watch lifecycle, independent of the managed business tree. */
  setConfigurationWatching(watching: boolean): void { this.watching = watching; this.emit(); }
  /** Serialize the entire native batch, including imports/cache work, with UI/config writes. */
  async runCodeReload(signal: AbortSignal, batch: (permit: CodeReloadPermit) => Promise<void>): Promise<void> {
    const combined = AbortSignal.any([signal, this.closing.signal]);
    while (this.busy) await waitForOperation(this.active, combined);
    combined.throwIfAborted();
    if (this.closed || !this.recoveryAvailable) throw new PluginManagementError("management_unavailable");
    if (this.recoveryRequired || this.store.snapshot().pending) throw new PluginManagementError("management_recovery_required");
    const profile = this.requireProfile();
    this.busy = true;
    let applied = false, active = true;
    const permit: CodeReloadPermit = Object.freeze({ apply: async (entryIds: readonly string[], update: () => Promise<void>) => {
      if (!active || applied) throw new PluginManagementError("management_code_reload_permit_invalid");
      applied = true; combined.throwIfAborted();
      if (this.closed || !this.recoveryAvailable || !profile.healthy()) throw new PluginManagementError("management_unavailable");
      if (!Array.isArray(entryIds) || entryIds.length > 512 || new Set(entryIds).size !== entryIds.length) throw new PluginManagementError("management_invalid_request");
      const before = this.store.snapshot();
      const entries = entryIds.map(id => profile.owned(id));
      for (const entry of entries) {
        if (entry.disabled || entry.fiber?.state !== FiberState.ACTIVE || before.preferences[entry.id]?.preference === "disabled") {
          throw new PluginManagementError("management_target_unsettled");
        }
      }
      // Dormant-only imports have no live owners to quarantine and never change a gate.
      if (!entries.length) { await update(); return; }
      const options = entries.map(entry => JSON.stringify(entry.options));
      const request: ManagedPluginRequest = { requestId: `code-reload:${randomUUID()}`, revision: before.revision,
        preference: "inherit", selection: { instanceId: this.inspection.inspect().instanceId, entryIds: [...entryIds] } };
      let staged = false;
      try {
        await this.store.commit(before.revision, { preferences: before.preferences, receipts: before.receipts, pending: request });
        staged = true; this.emit(); combined.throwIfAborted();
        await update();
        if (!profile.healthy() || entries.some((entry, index) => JSON.stringify(entry.options) !== options[index] || entry.disabled || entry.fiber?.state !== FiberState.ACTIVE)) {
          throw new PluginManagementError("management_code_reload_verification_failed");
        }
        const current = this.store.snapshot();
        await this.store.commit(current.revision, { preferences: current.preferences, pending: null, receipts: [...current.receipts, {
          requestId: request.requestId, fingerprint: managementFingerprint(request), status: "succeeded" as const, code: "management_code_reload_applied",
        }].slice(-100) });
        this.emit();
      } catch (error) {
        if (staged || (error as { code?: string }).code === "management_save_uncertain") this.recoveryRequired = true;
        this.emit(); throw error;
      }
    } });
    const run = Promise.resolve().then(() => batch(permit)).finally(() => { active = false; this.busy = false; this.emit(); });
    this.active = run; this.emit(); return run;
  }
  /** File events wait for UI writes, then compose the latest accepted user preferences. */
  async reloadConfiguration(): Promise<void> {
    while (this.busy) await this.active.catch(() => {});
    if (this.closed || !this.recoveryAvailable) throw new PluginManagementError("management_unavailable");
    if (this.recoveryRequired || this.store.snapshot().pending) throw new PluginManagementError("management_recovery_required");
    const profile = this.requireProfile();
    if (profile.source.unchanged() && this.configurationPhase === "idle") return;
    this.busy = true;
    this.configurationPhase = "applying"; this.configurationCode = null;
    const run = this.performConfiguration(profile).finally(() => {
      this.configurationRequest = undefined; this.configurationStop = undefined;
      this.busy = false; this.emit();
    });
    this.active = run; this.emit();
    return run;
  }
  private async performConfiguration(profile: ManagedProfile): Promise<void> {
    let staged = false;
    try {
      const before = this.store.snapshot();
      const candidate = new ManagedProfileSource(profile.source.filename, profile.source.rootId, before);
      const changed = profile.source.changes(candidate);
      if (!changed.length) {
        await profile.replace(candidate);
        this.configurationPhase = "idle";
        return;
      }
      const active: string[] = [];
      for (const id of changed) {
        const entry = profile.owned(id);
        if (entry.fiber) {
          if (entry.fiber.state !== FiberState.ACTIVE) throw new PluginManagementError("management_target_unsettled");
          active.push(id);
        }
      }
      const instanceId = this.inspection.inspect().instanceId;
      // Existing durable intent/recovery format quarantines every attempted target
      // after a crash. It is never a saved user disable preference or a replay job.
      const request: ManagedPluginRequest = {
        requestId: `configuration:${randomUUID()}`, revision: before.revision, preference: "inherit",
        selection: { instanceId, entryIds: changed },
      };
      this.configurationRequest = request;
      this.configurationStop = { instanceId, entryIds: Object.freeze(active.sort()) };
      await this.store.commit(before.revision, { preferences: before.preferences, receipts: before.receipts, pending: request });
      staged = true; this.emit();
      if (active.length) {
        const operation = await this.stops.disable(this.configurationStop);
        if (operation.state.phase !== "succeeded") {
          if (operation.state.phase !== "rejected") throw new PluginManagementError("management_recovery_required");
          const state = this.store.snapshot();
          await this.store.commit(state.revision, { preferences: state.preferences, pending: null, receipts: [...state.receipts, {
            requestId: request.requestId, fingerprint: managementFingerprint(request), status: "rejected" as const,
            code: operation.state.code, operationId: operation.id,
          }].slice(-100) });
          staged = false;
          throw new PluginManagementError(operation.state.code);
        }
      }
      if (this.closed) throw new PluginManagementError("management_unavailable");
      await profile.replace(candidate);
      const state = this.store.snapshot();
      await this.store.commit(state.revision, { preferences: state.preferences, pending: null, receipts: [...state.receipts, {
        requestId: request.requestId, fingerprint: managementFingerprint(request), status: "succeeded" as const,
        code: "management_configuration_applied",
      }].slice(-100) });
      this.configurationPhase = "idle";
    } catch (error) {
      if (staged || (error instanceof ManagedPluginStoreError && error.code === "management_save_uncertain")) this.recoveryRequired = true;
      const code = error instanceof ManagedProfileError || error instanceof PluginManagementError || error instanceof ManagedPluginStoreError
        ? error.code : staged ? "management_configuration_apply_failed" : "management_configuration_invalid";
      this.configurationPhase = this.recoveryRequired ? "recovery-required" : "rejected";
      this.configurationCode = code;
      throw new PluginManagementError(code);
    }
  }
  change(input: ManagedPluginRequest): Promise<ManagedPluginReceipt> {
    const request = parseRequest(input), fingerprint = managementFingerprint(request);
    const state = this.store.snapshot();
    const receipt = state.receipts.find(item => item.requestId === request.requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) return Promise.reject(new PluginManagementError("management_request_conflict"));
      return Promise.resolve(receipt);
    }
    if (this.closed || !this.recoveryAvailable) return Promise.reject(new PluginManagementError("management_unavailable"));
    if (this.busy) return Promise.reject(new PluginManagementError("management_busy"));
    if (this.recoveryRequired || state.pending) return Promise.reject(new PluginManagementError("management_recovery_required"));
    if (request.revision !== state.revision) return Promise.reject(new PluginManagementError("management_revision_conflict"));
    const profile = this.requireProfile();
    const impact = previewPluginSelection(this.inspection.inspect(), request.selection);
    const entries = impact.selection.entryIds.map(id => profile.owned(id));
    const controls = profile.controls();
    if (request.preference === "enabled" && entries.some(entry => controls[entry.id]?.canEnable === false)) {
      return Promise.reject(new PluginManagementError("management_enable_constrained"));
    }
    // Re-enabling/restoring only starts absent gates or keeps already-active gates;
    // no uncontrolled disposal of pending/loading resources through a config write.
    if (request.preference !== "disabled" && entries.some(entry => {
      const view = impact.snapshot.entries.find(item => item.id === entry.id)!;
      return view.phase !== "active" && (view.phase !== "absent" || !entry.disabled);
    })) {
      return Promise.reject(new PluginManagementError("management_target_unsettled"));
    }
    this.busy = true; this.emit();
    const run = this.perform(request, fingerprint).finally(() => { this.busy = false; this.emit(); });
    this.active = run;
    return run;
  }
  private async perform(request: ManagedPluginRequest, fingerprint: string): Promise<ManagedPluginReceipt> {
    let staged = false;
    try {
      const before = this.store.snapshot();
      await this.store.commit(request.revision, { preferences: before.preferences, receipts: before.receipts, pending: request });
      staged = true; this.emit();
      let receipt: ManagedPluginReceipt;
      if (request.preference === "disabled") {
        const operation = await this.stops.disable(request.selection);
        if (operation.state.phase === "failed") {
          this.recoveryRequired = true; this.emit();
          throw new PluginManagementError("management_recovery_required");
        }
        const succeeded = operation.state.phase === "succeeded";
        receipt = { requestId: request.requestId, fingerprint, status: succeeded ? "succeeded" : "rejected",
          code: succeeded ? "management_saved" : "code" in operation.state ? operation.state.code : "management_stop_incomplete", operationId: operation.id };
      } else {
        const profile = this.requireProfile();
        await profile.apply(request.selection.entryIds, request.preference);
        receipt = { requestId: request.requestId, fingerprint, status: "succeeded", code: "management_saved" };
      }
      const current = this.store.snapshot();
      const preferences: Record<string, ManagedPluginPreference> = { ...current.preferences };
      if (receipt.status === "succeeded") for (const id of request.selection.entryIds) {
        if (request.preference === "inherit") delete preferences[id];
        else preferences[id] = { name: this.profile!.source.original(id).name, preference: request.preference };
      }
      await this.store.commit(current.revision, { preferences, pending: null, receipts: [...current.receipts, receipt].slice(-100) });
      this.emit(); return Object.freeze(receipt);
    } catch (error) {
      if (staged || (error as { code?: string }).code === "management_save_uncertain") this.recoveryRequired = true;
      this.emit(); throw error;
    }
  }
  /** After restart only: explicitly reconcile a pending intent by keeping its targets disabled. */
  async recoverDisabled(revision: string): Promise<void> {
    if (this.busy || this.closed || !this.recoveryAvailable) throw new PluginManagementError("management_busy");
    const state = this.store.snapshot(), snapshot = this.inspection.inspect(), pending = state.pending;
    if (revision !== state.revision) throw new PluginManagementError("management_revision_conflict");
    if (!pending) throw new PluginManagementError("management_recovery_missing");
    if (pending.selection.instanceId === snapshot.instanceId) throw new PluginManagementError("management_restart_required");
    const profile = this.requireProfile();
    for (const id of pending.selection.entryIds) {
      const entry = profile.owned(id);
      if (!entry.disabled || entry.fiber) throw new PluginManagementError("management_recovery_unsettled");
    }
    this.busy = true; this.emit();
    const run = (async () => {
      const preferences = { ...state.preferences };
      for (const id of pending.selection.entryIds) preferences[id] = { name: profile.source.original(id).name, preference: "disabled" as const };
      const receipt: ManagedPluginReceipt = { requestId: pending.requestId, fingerprint: managementFingerprint(pending), status: "failed", code: "management_recovered_disabled" };
      await this.store.commit(revision, { preferences, pending: null, receipts: [...state.receipts, receipt].slice(-100) });
      this.recoveryRequired = false;
      this.configurationPhase = "idle"; this.configurationCode = null;
    })().finally(() => { this.busy = false; this.emit(); });
    this.active = run; return run;
  }
  async close(): Promise<void> {
    this.closed = true; this.recoveryAvailable = false;
    this.closing.abort(new PluginManagementError("management_closed"));
    await this.active.catch(() => {}); this.removeCodeReload?.(); this.listeners.clear(); await this.store.close();
  }
  private reserve(impact: PluginSelectionImpact): PluginDisableReservation {
    const profile = this.requireProfile(), pending = this.store.snapshot().pending;
    const configuration = pending?.requestId === this.configurationRequest?.requestId && this.configurationStop &&
      managementFingerprint(this.configurationStop) === managementFingerprint(impact.selection);
    const user = pending?.preference === "disabled" && managementFingerprint(pending.selection) === managementFingerprint(impact.selection);
    if (!this.busy || !this.recoveryAvailable || !pending || (!configuration && !user)) throw new PluginManagementError("management_reservation_invalid");
    const entries = impact.gatedEntryIds.map(id => profile.owned(id));
    const options = entries.map(entry => JSON.stringify(entry.options));
    let released = false;
    return {
      current: () => !released && !this.closed && this.recoveryAvailable && profile.healthy() &&
        entries.every((entry, index) => { try { return profile.owned(entry.id) === entry && JSON.stringify(entry.options) === options[index]; } catch { return false; } }),
      apply: () => profile.apply(impact.selection.entryIds, "disabled"),
      verify: async () => profile.healthy() && entries.every(entry => entry.disabled && !entry.fiber),
      release: () => { released = true; },
    };
  }
  private requireProfile(): ManagedProfile {
    if (!this.profile || !this.profile.healthy()) throw new PluginManagementError("management_configuration_changed");
    return this.profile;
  }
  private emit(): void { for (const listener of this.listeners) { try { void Promise.resolve(listener()).catch(() => {}); } catch { /* Advisory notifications. */ } } }
}

/** Abort only the wait, never an accepted configuration write owned by another operation. */
function waitForOperation(operation: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void operation.catch(() => {}).then(() => { signal.removeEventListener("abort", abort); resolve(); });
    if (signal.aborted) abort();
  });
}

function parseRequest(value: ManagedPluginRequest): ManagedPluginRequest {
  const id = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 512 && item === item.trim() && !/[\u0000-\u001f]/u.test(item);
  if (!value || !id(value.requestId) || !id(value.revision) || !["enabled", "disabled", "inherit"].includes(value.preference) ||
    !value.selection || !id(value.selection.instanceId) || !Array.isArray(value.selection.entryIds) || !value.selection.entryIds.length ||
    value.selection.entryIds.length > 512 || value.selection.entryIds.some(item => !id(item)) || new Set(value.selection.entryIds).size !== value.selection.entryIds.length ||
    Object.keys(value).some(key => !["requestId", "revision", "preference", "selection"].includes(key)) ||
    Object.keys(value.selection).some(key => !["instanceId", "entryIds"].includes(key))) throw new PluginManagementError("management_invalid_request");
  return Object.freeze({ ...value, selection: Object.freeze({ ...value.selection, entryIds: Object.freeze([...value.selection.entryIds]) }) });
}
