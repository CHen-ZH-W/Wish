import { randomUUID } from "node:crypto";
import { FiberState, type Context } from "@deepseek-ai/cordis";
import { installPluginStopControl, type PluginStopAdapter } from "./stop.js";
import { previewPluginSelection } from "./selection.js";
import { managementFingerprint, ManagedPluginStore, ManagedPluginStoreError } from "./managed-store.js";
import { ManagedProfile, ManagedProfileError, ManagedProfileSource } from "./managed-profile.js";
import type { ManagedPluginIntent, ManagedPluginPreference, ManagedPluginProtocolView, ManagedPluginReceipt, ManagedPluginRequest,
  ManagedPluginActivationControl, ManagedPluginControlView, ManagedPluginSnapshot, ManagedPluginState } from "./managed-types.js";
import type { PluginEntryView, PluginInspection, PluginInspectionSnapshot } from "./types.js";
import type { PluginSelection, PluginSelectionImpact } from "./management-types.js";
import type { PluginDisableReservation } from "./stop-contract.js";
import type { CodeReloadInspection, CodeReloadPermit } from "./code-reload.js";
import { getOrInstallPluginChangeCoordinator, PluginChangeError, type PluginChangeCoordinator, type PluginChangeHandle,
  type PluginChangeOperationView, type PluginChangeScope } from "./change-coordinator.js";
import { SafePluginChangeTransaction, type PluginChangeRestoration } from "./safe-change.js";

export class PluginManagementError extends Error { constructor(readonly code: string) { super(code); } }

/** Root coordinator: durable intents and receipts, not a second business state machine. */
export class ManagedPluginControl {
  readonly stops: PluginStopAdapter;
  private readonly changes: PluginChangeCoordinator;
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
  private configurationRequest: ManagedPluginIntent | undefined;
  private configurationStop: PluginSelection | undefined;
  private readonly closing = new AbortController();
  private codeReload?: CodeReloadInspection;
  private removeCodeReload?: () => void;
  private readonly removeChanges: () => void;
  private readonly requests = new Map<string, { fingerprint: string; handle: PluginChangeHandle<ManagedPluginReceipt> }>();
  constructor(private readonly root: Context, private readonly inspection: PluginInspection, private readonly store: ManagedPluginStore) {
    this.recoveryRequired = store.snapshot().pending !== null;
    this.changes = getOrInstallPluginChangeCoordinator(root);
    this.changes.attachJournal({ latest: () => this.store.snapshot().operations.at(-1) ?? null,
      record: operation => this.store.recordOperation(operation) });
    this.removeChanges = this.changes.subscribe(() => this.emit());
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
    const inspection = this.inspection.inspect();
    const owners = Object.freeze(inspection.fibers.map(fiber => {
      const registry = this.root.get("pluginOwners"), coverage = registry?.coverage(fiber.id), record = registry?.record(fiber.id);
      return Object.freeze({ fiberId: fiber.id,
        lifecycle: coverage?.lifecycle ?? "unregistered",
        codeReload: coverage?.codeReload ?? "unregistered",
        replacement: record?.replacement ?? "unregistered",
        declaration: record === undefined ? "unregistered" : record.canonical ? "canonical" : "compatibility",
      });
    }));
    const change = this.changes.snapshot();
    const requests = [change.active, ...change.queued].filter((operation): operation is PluginChangeOperationView =>
      operation?.source === "management" && operation.requestId !== null).map(operation => Object.freeze({
        operationId: operation.id, requestId: operation.requestId!, phase: requestPhase(operation.phase), cancellable: operation.cancellable,
      }));
    const protocols = projectPluginProtocols(inspection, owners);
    const controls = projectPluginControls(inspection, protocols, this.profile?.controls() ?? Object.freeze({}), state.preferences);
    return Object.freeze({ owners, protocols, requests: Object.freeze(requests),
      operations: state.operations, codeReload: this.codeReload?.snapshot() ?? null, inspection, revision: state.revision, preferences: state.preferences,
      controls,
      pending: state.pending, status: this.recoveryRequired ? "recovery-required" : this.busy || !!change.active || !!change.queued.length ? "working" : "ready",
      writable: !this.closed && this.recoveryAvailable && !!this.profile?.healthy(),
      operation: this.stops.current(), lastReceipt: state.receipts.at(-1) ?? null,
      configuration: Object.freeze({ watching: this.watching, phase: this.configurationPhase,
        digest: this.profile?.source.digest ?? null, code: this.configurationCode }) });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Root watch lifecycle, independent of the managed business tree. */
  setConfigurationWatching(watching: boolean): void { this.watching = watching; this.emit(); }
  /** Host-only watch paths; never included in the browser snapshot. */
  configurationFiles(): readonly string[] { return this.profile?.source.files ?? []; }
  /** Serialize the entire native batch, including imports/cache work, with UI/config writes. */
  async runCodeReload(signal: AbortSignal, batch: (permit: CodeReloadPermit) => Promise<void>): Promise<void> {
    const combined = AbortSignal.any([signal, this.closing.signal]);
    combined.throwIfAborted();
    if (this.closed || !this.recoveryAvailable) throw new PluginManagementError("management_unavailable");
    const profile = this.requireProfile();
    const requestId = `code-reload:${randomUUID()}`;
    let active = true;
    const handle = this.changes.submit({ kind: "replace", source: "hmr", requestId }, async change => {
      if (this.closed || !this.recoveryAvailable) throw new PluginManagementError("management_unavailable");
      if (this.recoveryRequired || this.store.snapshot().pending) throw new PluginManagementError("management_recovery_required");
      this.busy = true; this.emit();
      let applied = false;
      const permit: CodeReloadPermit = Object.freeze({ change, apply: async (entryIds: readonly string[], update: () => Promise<void>) => {
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
        const request: ManagedPluginRequest = { requestId, revision: before.revision,
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
          if (staged && changeErrorCode(error, "management_code_reload_failed") === "code_reload_candidate_rolled_back") {
            try {
              const current = this.store.snapshot();
              await this.store.commit(current.revision, { preferences: before.preferences, pending: null,
                receipts: [...current.receipts, { requestId: request.requestId, fingerprint: managementFingerprint(request),
                  status: "rejected" as const, code: "management_code_reload_rolled_back" }].slice(-100) });
              staged = false; this.emit();
              throw new PluginManagementError("code_reload_candidate_rolled_back");
            } catch (rollbackError) {
              if (rollbackError instanceof PluginManagementError && rollbackError.code === "code_reload_candidate_rolled_back") throw rollbackError;
              this.recoveryRequired = true;
              await change.recovery("management_code_reload_recovery_failed");
              this.emit(); throw rollbackError;
            }
          }
          if (staged || (error as { code?: string }).code === "management_save_uncertain") {
            this.recoveryRequired = true;
            await change.recovery(changeErrorCode(error, "management_code_reload_failed"));
          }
          this.emit(); throw error;
        }
      } });
      await batch(permit);
    }, { signal: combined });
    await handle.accepted;
    const run = handle.completion.then(() => undefined).finally(() => { active = false; this.busy = false; this.emit(); });
    this.active = run; this.emit(); return run;
  }
  /** File events wait for UI writes, then compose the latest accepted user preferences. */
  async reloadConfiguration(): Promise<void> {
    if (this.closed || !this.recoveryAvailable) throw new PluginManagementError("management_unavailable");
    const profile = this.requireProfile();
    if (profile.source.unchanged() && this.configurationPhase === "idle") return;
    const requestId = `configuration:${randomUUID()}`;
    const handle = this.changes.submit({ kind: "reconfigure", source: "configuration", requestId }, async scope => {
      if (this.closed || !this.recoveryAvailable) throw new PluginManagementError("management_unavailable");
      if (this.recoveryRequired || this.store.snapshot().pending) throw new PluginManagementError("management_recovery_required");
      this.busy = true; this.configurationPhase = "applying"; this.configurationCode = null; this.emit();
      return this.performConfiguration(profile, scope, requestId);
    });
    await handle.accepted;
    const run = handle.completion.then(() => undefined).finally(() => {
        this.configurationRequest = undefined; this.configurationStop = undefined;
        this.busy = false; this.emit();
      });
    this.active = run; this.emit();
    return run;
  }
  private async performConfiguration(profile: ManagedProfile, scope: PluginChangeScope, requestId: string): Promise<void> {
    let staged = false;
    const transaction = new SafePluginChangeTransaction();
    try {
      const before = this.store.snapshot();
      const previousSource = profile.source;
      const candidate = new ManagedProfileSource(profile.source.filename, profile.source.rootId, before, profile.source);
      const changed = profile.source.changes(candidate);
      if (!changed.length) {
        await scope.phase("staging");
        await scope.phase("switching");
        await profile.replace(candidate);
        await scope.phase("verifying");
        this.configurationPhase = "idle";
        return;
      }
      const checkStructure = await profile.prepareStructure(candidate);
      const active: string[] = [];
      const dormant: (() => void)[] = [];
      for (const change of changed) {
        if (change.kind === "add") continue;
        if (profile.source.original(change.entryId).group) continue;
        const entry = profile.owned(change.entryId);
        if (entry._initTask || entry._disposing) throw new PluginManagementError("management_target_unsettled");
        if (change.kind === "reorder") {
          if (entry.fiber?.inertia) throw new PluginManagementError("management_target_unsettled");
          continue;
        }
        if (entry.fiber) {
          if (entry.fiber.state === FiberState.ACTIVE) active.push(change.entryId);
          else {
            const fiber = entry.fiber;
            const check = () => {
              // A pending/failed Fiber may own pre-activation effects. Only an
              // empty, settled instance can bypass the active-owner stop protocol.
              if (entry.fiber !== fiber || fiber.inertia ||
                (fiber.state !== FiberState.PENDING && fiber.state !== FiberState.FAILED) || fiber.getEffects().length) {
                throw new PluginManagementError("management_target_unsettled");
              }
            };
            check(); dormant.push(check);
          }
        } else dormant.push(() => {
          if (entry.fiber || entry._initTask || entry._disposing) throw new PluginManagementError("management_target_unsettled");
        });
      }
      const selection = { instanceId: this.inspection.inspect().instanceId, entryIds: active };
      const affected = active.length ? previewPluginSelection(this.inspection.inspect(), selection).affected.map(item => item.fiberId) : [];
      await scope.target(changed.map(change => change.entryId));
      await scope.phase("waiting-safe-point");
      await this.atSafePoint(affected, async () => {
        if (!candidate.unchanged()) throw new PluginManagementError("management_configuration_changed");
        const observation = this.inspection.inspect(), instanceId = observation.instanceId;
        const runtimeBefore = this.runtimeCheckpoint(profile, observation);
        // Record both identities so restart can quarantine present entries and
        // reconcile removed ones without replaying the configuration operation.
        const request: ManagedPluginIntent = {
          requestId, revision: before.revision, preference: "inherit",
          selection: { instanceId, entryIds: changed.map(change => change.entryId) },
          configuration: { beforeDigest: profile.source.digest, afterDigest: candidate.digest, changes: changed },
        };
        this.configurationRequest = request;
        this.configurationStop = { instanceId, entryIds: Object.freeze(active.sort()) };
        await this.store.commit(before.revision, { preferences: before.preferences, receipts: before.receipts, pending: request });
        staged = true; this.emit();
        if (JSON.stringify(observation) !== JSON.stringify(this.inspection.inspect())) throw new PluginManagementError("management_configuration_changed");
        if (active.length) {
          const operation = await this.stops.disableWithin(this.configurationStop, scope);
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
          transaction.changed(this.configurationRestoration(profile, previousSource, before, request, active, runtimeBefore));
        }
        if (this.closed) throw new PluginManagementError("management_unavailable");
        for (const check of dormant) check();
        checkStructure();
        await scope.phase("staging");
        await scope.phase("switching");
        if (!transaction.changedRuntime) {
          transaction.changed(this.configurationRestoration(profile, previousSource, before, request, active, runtimeBefore));
        }
        await profile.replace(candidate);
        await scope.phase("retiring");
        await scope.phase("verifying");
        this.assertActiveConformance([...new Set([
          ...changed.map(change => change.entryId),
          ...this.activatedSince(profile, runtimeBefore),
        ])]);
        const state = this.store.snapshot();
        await this.store.commit(state.revision, { preferences: candidate.preferences, pending: null, receipts: [...state.receipts, {
          requestId: request.requestId, fingerprint: managementFingerprint(request), status: "succeeded" as const,
          code: "management_configuration_applied",
        }].slice(-100) });
        transaction.commit();
        this.configurationPhase = "idle";
      }, () => staged || this.recoveryRequired, scope.signal);
    } catch (error) {
      const code = error instanceof ManagedProfileError || error instanceof PluginManagementError || error instanceof ManagedPluginStoreError
        ? error.code : staged ? "management_configuration_apply_failed" : "management_configuration_invalid";
      let reported = code;
      if (this.recoveryRequired) {
        reported = code;
      } else if (staged && !(error instanceof ManagedPluginStoreError && error.code === "management_save_uncertain")) {
        const outcome = await transaction.fail({ rejected: code, rolledBack: "management_configuration_rolled_back",
          recovery: "management_configuration_recovery_failed" });
        reported = outcome.code;
        this.recoveryRequired = outcome.phase === "recovery-required";
      } else if (staged || (error instanceof ManagedPluginStoreError && error.code === "management_save_uncertain")) {
        this.recoveryRequired = true;
      }
      this.configurationPhase = this.recoveryRequired ? "recovery-required" : "rejected";
      this.configurationCode = reported;
      if (this.recoveryRequired) await scope.recovery(reported);
      else await scope.reject(reported);
      throw new PluginManagementError(reported);
    }
  }
  /** Persist admission before returning; execution is Host-owned after that point. */
  async submit(input: ManagedPluginRequest): Promise<PluginChangeOperationView> {
    const request = parseRequest(input), fingerprint = managementFingerprint(request);
    const persisted = [...this.store.snapshot().operations].reverse().find(operation =>
      operation.source === "management" && operation.requestId === request.requestId);
    if (persisted) {
      if (persisted.fingerprint !== fingerprint) throw new PluginManagementError("management_request_conflict");
      return persisted;
    }
    const existing = this.requests.get(request.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PluginManagementError("management_request_conflict");
      return existing.handle.accepted;
    }
    if (this.requests.size >= 64) throw new PluginManagementError("management_queue_full");
    const kind = request.preference === "disabled" ? "disable" : "enable";
    let handle: PluginChangeHandle<ManagedPluginReceipt>;
    try {
      handle = this.changes.submit({ kind, source: "management", requestId: request.requestId,
        entryIds: request.selection.entryIds, fingerprint, submittedRevision: request.revision },
      scope => this.beginChange(request, fingerprint, scope));
    } catch (error) {
      if (error instanceof PluginChangeError && error.code === "plugin_change_queue_full") {
        throw new PluginManagementError("management_queue_full");
      }
      throw error;
    }
    this.requests.set(request.requestId, { fingerprint, handle }); this.emit();
    void handle.completion.finally(() => {
      if (this.requests.get(request.requestId)?.handle === handle) this.requests.delete(request.requestId);
      this.emit();
    }).catch(() => {});
    return handle.accepted;
  }
  /** Compatibility wait API: timeout/disconnect ends only this caller's wait, never the accepted Host operation. */
  async change(input: ManagedPluginRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ManagedPluginReceipt> {
    const request = parseRequest(input), timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new PluginManagementError("management_invalid_request");
    options.signal?.throwIfAborted();
    const operation = await this.submit(request);
    const receipt = this.store.snapshot().receipts.find(item => item.requestId === request.requestId);
    if (receipt) return receipt;
    const active = this.requests.get(request.requestId);
    if (!active) throw new PluginManagementError(operation.code ?? "management_operation_incomplete");
    return waitForCaller(active.handle.completion, timeoutMs, options.signal);
  }
  operation(operationId: string): PluginChangeOperationView | undefined {
    const current = this.changes.snapshot();
    return current.active?.id === operationId ? current.active
      : current.queued.find(operation => operation.id === operationId)
        ?? (current.last?.id === operationId ? current.last : this.store.operation(operationId));
  }
  receipt(requestId: string | null): ManagedPluginReceipt | undefined {
    return requestId === null ? undefined : this.store.snapshot().receipts.find(receipt => receipt.requestId === requestId);
  }
  /** Cancellation is reversible only through waiting-safe-point. */
  cancel(operationId: string): boolean { return this.changes.cancel(operationId, "management_cancelled"); }
  private async beginChange(request: ManagedPluginRequest, fingerprint: string, scope: PluginChangeScope): Promise<ManagedPluginReceipt> {
    const state = this.store.snapshot();
    const receipt = state.receipts.find(item => item.requestId === request.requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new PluginManagementError("management_request_conflict");
      return receipt;
    }
    const current = this.store.snapshot();
    if (this.closed || !this.recoveryAvailable) throw new PluginManagementError("management_unavailable");
    if (this.busy) throw new PluginManagementError("management_busy");
    if (this.recoveryRequired || current.pending) throw new PluginManagementError("management_recovery_required");
    if (request.revision !== current.revision) throw new PluginManagementError("management_revision_conflict");
    const profile = this.requireProfile();
    const impact = previewPluginSelection(this.inspection.inspect(), request.selection);
    if (impact.selection.entryIds.some(id =>
      impact.snapshot.entries.find(entry => entry.id === id)?.managementClass !== "managed")) {
      throw new PluginManagementError("management_target_read_only");
    }
    if (request.preference === "disabled" && impact.affected.some(({ fiberId }) => {
      const registry = this.root.get("pluginOwners"), coverage = registry?.coverage(fiberId), record = registry?.record(fiberId);
      const lifecycle = coverage?.lifecycle ?? "unregistered";
      const codeReload = coverage?.codeReload ?? "unregistered";
      const fiber = impact.snapshot.fibers.find(item => item.id === fiberId);
      const entry = fiber?.entryId ? impact.snapshot.entries.find(item => item.id === fiber.entryId) : undefined;
      // An enabled Fiber waiting for dependencies has no active Owner declaration.
      // Stop performs the authoritative empty-Fiber check before allowing the
      // configuration-only path; active generations still require full coverage.
      return fiber?.phase === "active" && (lifecycle !== "managed" || codeReload !== "registered" || record?.canonical !== true ||
        (!!entry?.manifest && record?.replacement !== entry.manifest.replacement));
    })) throw new PluginManagementError("management_plugin_nonconformant");
    const entries = impact.selection.entryIds.map(id => profile.owned(id));
    const controls = profile.controls();
    if (request.preference === "enabled" && entries.some(entry => {
      const saved = current.preferences[entry.id]?.preference;
      const view = impact.snapshot.entries.find(item => item.id === entry.id);
      // An already-active entry or an already-saved enabled intent is an
      // idempotent preference write: it cannot bypass a deployment gate.
      return saved !== "disabled" && saved !== "enabled" && view?.enabled !== true && controls[entry.id]?.canEnable !== true;
    })) {
      throw new PluginManagementError("management_enable_constrained");
    }
    // Re-enabling/restoring only starts absent gates or keeps already-active gates;
    // no uncontrolled disposal of pending/loading resources through a config write.
    if (request.preference !== "disabled" && entries.some(entry => {
      const view = impact.snapshot.entries.find(item => item.id === entry.id)!;
      return view.phase !== "active" && (view.phase !== "absent" || !entry.disabled);
    })) throw new PluginManagementError("management_target_unsettled");
    this.busy = true; this.emit();
    // Cancellation can arrive as soon as the persisted waiting phase becomes
    // observable. Arm cleanup before publishing that phase so `busy` cannot be
    // stranded between `scope.phase()` and `atSafePoint()`.
    const run = (async () => {
      await scope.phase("waiting-safe-point");
      return this.atSafePoint(impact.affected.map(item => item.fiberId), () =>
        this.perform(request, fingerprint, scope), undefined, scope.signal);
    })().finally(() => { this.busy = false; this.emit(); });
    this.active = run;
    return run;
  }
  private async perform(request: ManagedPluginRequest, fingerprint: string, scope: PluginChangeScope): Promise<ManagedPluginReceipt> {
    let staged = false;
    const transaction = new SafePluginChangeTransaction();
    try {
      const before = this.store.snapshot();
      await this.store.commit(request.revision, { preferences: before.preferences, receipts: before.receipts, pending: request });
      staged = true; this.emit();
      let receipt: ManagedPluginReceipt;
      if (request.preference === "disabled") {
        // Capture the committed generation before Stop removes its Fiber. The
        // restoration is armed only if Stop itself commits successfully.
        const restoration = this.preferenceRestoration(this.requireProfile(), before, request, fingerprint);
        const operation = await this.stops.disableWithin(request.selection, scope);
        if (operation.state.phase === "failed") {
          this.recoveryRequired = true; this.emit();
          throw new PluginManagementError("management_recovery_required");
        }
        const succeeded = operation.state.phase === "succeeded";
        if (succeeded) transaction.changed(restoration);
        receipt = { requestId: request.requestId, fingerprint, status: succeeded ? "succeeded" : "rejected",
          code: succeeded ? "management_saved" : "code" in operation.state ? operation.state.code : "management_stop_incomplete", operationId: operation.id };
      } else {
        const profile = this.requireProfile();
        const runtimeBefore = this.runtimeCheckpoint(profile);
        transaction.changed(this.preferenceRestoration(profile, before, request, fingerprint, runtimeBefore));
        await scope.phase("staging");
        await scope.phase("switching");
        await profile.apply(request.selection.entryIds, request.preference);
        await scope.phase("verifying");
        this.assertActiveConformance([...new Set([
          ...request.selection.entryIds,
          ...this.activatedSince(profile, runtimeBefore),
        ])]);
        receipt = { requestId: request.requestId, fingerprint, status: "succeeded", code: "management_saved" };
      }
      const current = this.store.snapshot();
      const preferences: Record<string, ManagedPluginPreference> = { ...current.preferences };
      if (receipt.status === "succeeded") for (const id of request.selection.entryIds) {
        if (request.preference === "inherit") delete preferences[id];
        else preferences[id] = { name: this.profile!.source.original(id).name, preference: request.preference };
      }
      await this.store.commit(current.revision, { preferences, pending: null, receipts: [...current.receipts, receipt].slice(-100) });
      transaction.commit();
      if (receipt.status === "rejected") await scope.reject(receipt.code);
      this.emit(); return Object.freeze(receipt);
    } catch (error) {
      const code = changeErrorCode(error, "management_apply_failed");
      if (this.recoveryRequired) {
        await scope.recovery(code);
        this.emit(); throw error;
      }
      if (staged && (error as { code?: string }).code !== "management_save_uncertain") {
        const outcome = await transaction.fail({ rejected: code, rolledBack: "management_change_rolled_back",
          recovery: "management_recovery_failed" });
        this.recoveryRequired = outcome.phase === "recovery-required";
        if (this.recoveryRequired) await scope.recovery(outcome.code);
        else await scope.reject(outcome.code);
        this.emit(); throw new PluginManagementError(outcome.code);
      }
      if (staged || (error as { code?: string }).code === "management_save_uncertain") {
        this.recoveryRequired = true;
        await scope.recovery(code);
      }
      this.emit(); throw error;
    }
  }

  private assertActiveConformance(entryIds: readonly string[]): void {
    const snapshot = this.snapshot();
    for (const id of entryIds) {
      const entry = snapshot.inspection.entries.find(item => item.id === id);
      if (entry?.managementClass !== "managed" || entry.phase !== "active") continue;
      if (snapshot.protocols.find(item => item.entryId === id)?.conformance !== "online") {
        throw new PluginManagementError("management_plugin_nonconformant");
      }
    }
  }
  /** After restart only: explicitly reconcile a pending intent by keeping its targets disabled. */
  async recoverDisabled(revision: string): Promise<void> {
    if (this.busy || this.changes.snapshot().active || this.changes.snapshot().queued.length || this.closed || !this.recoveryAvailable) {
      throw new PluginManagementError("management_busy");
    }
    const state = this.store.snapshot(), snapshot = this.inspection.inspect(), pending = state.pending;
    if (revision !== state.revision) throw new PluginManagementError("management_revision_conflict");
    if (!pending) throw new PluginManagementError("management_recovery_missing");
    if (pending.selection.instanceId === snapshot.instanceId) throw new PluginManagementError("management_restart_required");
    const profile = this.requireProfile();
    for (const id of pending.selection.entryIds) {
      if (pending.configuration && !profile.source.has(id)) continue;
      if (pending.configuration && profile.source.original(id).group) { profile.ownedGroup(id); continue; }
      const entry = profile.owned(id);
      if (!entry.disabled || entry.fiber) throw new PluginManagementError("management_recovery_unsettled");
    }
    this.busy = true; this.emit();
    const run = (async () => {
      const preferences = { ...profile.source.preferences };
      for (const id of pending.selection.entryIds) {
        if (pending.configuration && !profile.source.has(id)) delete preferences[id];
        else if (pending.configuration && profile.source.original(id).group) delete preferences[id];
        else preferences[id] = { name: profile.source.original(id).name, preference: "disabled" as const };
      }
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
    const snapshot = this.changes.snapshot();
    if (snapshot.active?.cancellable) this.changes.cancel(snapshot.active.id, "management_closed");
    for (const operation of snapshot.queued) this.changes.cancel(operation.id, "management_closed");
    await this.changes.wait().catch(() => {});
    await this.active.catch(() => {}); this.removeChanges(); this.removeCodeReload?.(); this.listeners.clear(); await this.store.close();
  }
  private preferenceRestoration(profile: ManagedProfile, before: ManagedPluginState, request: ManagedPluginRequest,
    fingerprint: string, runtimeBefore = this.runtimeCheckpoint(profile)): PluginChangeRestoration {
    const entries = request.selection.entryIds.map(id => {
      const entry = profile.owned(id);
      return { id, disabled: entry.disabled, fiber: entry.fiber, options: JSON.stringify(entry.options),
        fiberState: entry.fiber?.state,
        preference: before.preferences[id]?.preference ?? "inherit" as const };
    });
    return {
      restore: async () => {
        await profile.restoreEntries(entries.map(({ id, preference }) => ({ id, preference })));
        await this.repairFailedRuntime(profile, runtimeBefore, before);
        const current = this.store.snapshot();
        const receipt: ManagedPluginReceipt = { requestId: request.requestId, fingerprint, status: "rejected",
          code: "management_change_rolled_back" };
        await this.store.commit(current.revision, { preferences: before.preferences, pending: null,
          receipts: [...current.receipts, receipt].slice(-100) });
        this.emit();
      },
      verify: async () => {
        const current = this.store.snapshot();
        if (current.pending || JSON.stringify(current.preferences) !== JSON.stringify(before.preferences)) return false;
        return entries.every(expected => {
          try {
            const entry = profile.owned(expected.id);
            if (entry.disabled !== expected.disabled || JSON.stringify(entry.options) !== expected.options) return false;
            return expected.fiber ? entry.fiber !== expected.fiber && entry.fiber?.state === expected.fiberState : !entry.fiber;
          } catch { return false; }
        }) && this.runtimeRestored(profile, runtimeBefore, request.selection.entryIds);
      },
    };
  }
  private configurationRestoration(profile: ManagedProfile, source: ManagedProfileSource, before: ManagedPluginState,
    request: ManagedPluginIntent, active: readonly string[], runtimeBefore: readonly PluginEntryView[]): PluginChangeRestoration {
    const oldFibers = new Map(active.map(id => [id, profile.owned(id).fiber]));
    return {
      restore: async () => {
        await profile.restore(source, before.preferences);
        await this.repairFailedRuntime(profile, runtimeBefore, before);
        const current = this.store.snapshot();
        const receipt: ManagedPluginReceipt = { requestId: request.requestId, fingerprint: managementFingerprint(request),
          status: "rejected", code: "management_configuration_rolled_back" };
        await this.store.commit(current.revision, { preferences: before.preferences, pending: null,
          receipts: [...current.receipts, receipt].slice(-100) });
        this.emit();
      },
      verify: async () => {
        const current = this.store.snapshot();
        if (profile.source !== source || current.pending || JSON.stringify(current.preferences) !== JSON.stringify(before.preferences)) return false;
        return active.every(id => {
          try {
            const fiber = profile.owned(id).fiber;
            return fiber !== oldFibers.get(id) && fiber?.state === FiberState.ACTIVE;
          } catch { return false; }
        }) && this.runtimeRestored(profile, runtimeBefore, active);
      },
    };
  }
  /** Capture every entry in the managed profile, including enabled PENDING
   * consumers that can be activated indirectly by one Provider change.
   */
  private runtimeCheckpoint(profile: ManagedProfile,
    snapshot: PluginInspectionSnapshot = this.inspection.inspect()): readonly PluginEntryView[] {
    const ids = new Set(profile.source.ids());
    return Object.freeze(snapshot.entries.filter(entry => ids.has(entry.id)));
  }
  /** Return the complete runtime closure that became active during a change. */
  private activatedSince(profile: ManagedProfile, before: readonly PluginEntryView[]): readonly string[] {
    const previous = new Map(before.map(entry => [entry.id, entry]));
    return this.runtimeCheckpoint(profile).filter(entry =>
      entry.phase === "active" && previous.get(entry.id)?.phase !== "active").map(entry => entry.id);
  }
  /** Verify the whole old runtime graph after compensation. Fiber identity is
   * required to change for entries explicitly rebuilt by the transaction.
   */
  private runtimeRestored(profile: ManagedProfile, before: readonly PluginEntryView[], rebuilt: readonly string[]): boolean {
    const current = this.runtimeCheckpoint(profile), byId = new Map(current.map(entry => [entry.id, entry]));
    const rebuiltIds = new Set(rebuilt);
    if (current.length !== before.length) return false;
    return before.every(expected => {
      const actual = byId.get(expected.id);
      if (!actual || actual.name !== expected.name || actual.parentId !== expected.parentId || actual.kind !== expected.kind ||
        actual.gate !== expected.gate || actual.enabled !== expected.enabled || actual.phase !== expected.phase) return false;
      if (!rebuiltIds.has(expected.id)) return true;
      return expected.fiberId === null ? actual.fiberId === null
        : actual.fiberId !== null && actual.fiberId !== expected.fiberId;
    });
  }
  /** A failed Fiber keeps its startup error even after a required Provider is
   * removed. Recreate only generations that were healthy/pending before this
   * transaction and are still FAILED after the primary rollback.
   */
  private async repairFailedRuntime(profile: ManagedProfile, before: readonly PluginEntryView[],
    state: ManagedPluginState): Promise<void> {
    const current = new Map(this.runtimeCheckpoint(profile).map(entry => [entry.id, entry]));
    const repairs = before.filter(expected => expected.kind === "plugin" && expected.phase !== "failed" &&
      current.get(expected.id)?.phase === "failed").map(expected => ({
        id: expected.id,
        preference: state.preferences[expected.id]?.preference ?? "inherit" as const,
      }));
    if (repairs.length) await profile.restoreEntries(repairs);
  }
  private reserve(impact: PluginSelectionImpact): PluginDisableReservation {
    const profile = this.requireProfile(), pending = this.store.snapshot().pending;
    const configuration = pending?.requestId === this.configurationRequest?.requestId && this.configurationStop &&
      managementFingerprint(this.configurationStop) === managementFingerprint(impact.selection);
    const user = pending?.preference === "disabled" && managementFingerprint(pending.selection) === managementFingerprint(impact.selection);
    if (!this.busy || !this.recoveryAvailable || !pending || (!configuration && !user)) throw new PluginManagementError("management_reservation_invalid");
    const entries = impact.gatedEntryIds.map(id => profile.owned(id));
    const options = entries.map(entry => JSON.stringify(entry.options));
    const fibers = entries.map(entry => entry.fiber);
    const fiberStates = entries.map(entry => entry.fiber?.state);
    const preferences = entries.map(entry => ({ id: entry.id,
      preference: this.store.snapshot().preferences[entry.id]?.preference ?? "inherit" as const }));
    let released = false;
    return {
      current: () => !released && !this.closed && this.recoveryAvailable && profile.healthy() &&
        entries.every((entry, index) => { try { return profile.owned(entry.id) === entry && JSON.stringify(entry.options) === options[index]; } catch { return false; } }),
      apply: () => profile.apply(impact.selection.entryIds, "disabled"),
      verify: async () => profile.healthy() && entries.every(entry => entry.disabled && !entry.fiber),
      restore: () => profile.restoreEntries(preferences),
      verifyRestored: async () => profile.healthy() && entries.every((entry, index) => {
        try {
          const restored = profile.owned(entry.id);
          return !restored.disabled && restored.fiber !== fibers[index] && restored.fiber?.state === fiberStates[index] &&
            JSON.stringify(restored.options) === options[index];
        } catch { return false; }
      }),
      release: () => { released = true; },
    };
  }
  private requireProfile(): ManagedProfile {
    if (!this.profile || !this.profile.healthy()) throw new PluginManagementError("management_configuration_changed");
    return this.profile;
  }
  private async atSafePoint<T>(affected: readonly number[], action: () => Promise<T>, uncertain = () => this.recoveryRequired, signal?: AbortSignal): Promise<T> {
    const coordinator = this.root.get("codeReload");
    if (!coordinator) return action();
    return coordinator.pauseConfiguration(affected, action, {
      signal: AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])]), uncertain,
    });
  }
  private emit(): void { for (const listener of this.listeners) { try { void Promise.resolve(listener()).catch(() => {}); } catch { /* Advisory notifications. */ } } }
}

function requestPhase(phase: PluginChangeOperationView["phase"]): "queued" | "waiting" | "applying" {
  if (phase === "queued") return "queued";
  if (phase === "preflight" || phase === "waiting-safe-point") return "waiting";
  return "applying";
}

function waitForCaller<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new PluginManagementError(timeout.aborted ? "management_timeout" : "management_wait_cancelled"));
    };
    const cleanup = () => combined.removeEventListener("abort", abort);
    combined.addEventListener("abort", abort, { once: true });
    void work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (combined.aborted) abort();
  });
}

function projectPluginProtocols(
  inspection: PluginInspectionSnapshot,
  owners: ManagedPluginSnapshot["owners"],
): readonly ManagedPluginProtocolView[] {
  const byFiber = new Map(owners.map(owner => [owner.fiberId, owner]));
  return Object.freeze(inspection.entries.filter(entry => entry.managementClass === "managed").map(entry => {
    const fibers = inspection.fibers.filter(fiber => fiber.entryId === entry.id && fiber.phase === "active");
    if (!fibers.length) return Object.freeze({ entryId: entry.id, conformance: "inactive", stop: "inactive", codeUpdate: "inactive" });
    const coverage = fibers.map(fiber => byFiber.get(fiber.id)!);
    const stop: ManagedPluginProtocolView["stop"] = coverage.every(owner => owner.declaration === "canonical" && owner.lifecycle === "managed") ? "online"
      : coverage.some(owner => owner.declaration === "compatibility" || owner.lifecycle === "unregistered" ||
        (owner.lifecycle === "observe-only" && owner.codeReload !== "restart")) ? "missing" : "restart";
    const codeUpdate: ManagedPluginProtocolView["codeUpdate"] = coverage.some(owner => owner.declaration === "compatibility" || owner.codeReload === "unregistered") ? "missing"
      : coverage.some(owner => owner.codeReload === "restart") ? "restart"
      : entry.manifest && coverage.some(owner => owner.replacement !== entry.manifest!.replacement) ? "mismatch" : "online";
    const conformance: ManagedPluginProtocolView["conformance"] = stop === "missing" || codeUpdate === "missing" || codeUpdate === "mismatch" ? "incomplete"
      : stop === "restart" || codeUpdate === "restart" ? "restart" : "online";
    return Object.freeze({ entryId: entry.id, conformance, stop, codeUpdate });
  }));
}

function projectPluginControls(
  inspection: PluginInspectionSnapshot,
  protocols: readonly ManagedPluginProtocolView[],
  activation: Readonly<Record<string, ManagedPluginActivationControl>>,
  preferences: ManagedPluginState["preferences"],
): Readonly<Record<string, ManagedPluginControlView>> {
  const byEntry = new Map(protocols.map(protocol => [protocol.entryId, protocol]));
  const result: Record<string, ManagedPluginControlView> = {};
  for (const entry of inspection.entries) {
    const protocol = byEntry.get(entry.id);
    const enableAuthorized = preferences[entry.id]?.preference === "disabled" || activation[entry.id]?.canEnable === true;
    let reason: string | undefined;
    if (entry.managementClass === "kernel") reason = "management_kernel_read_only";
    else if (entry.managementClass === "structural") reason = "management_structural_read_only";
    else if (entry.managementClass === "noncompliant") reason = "management_manifest_required";
    else if (protocol?.stop === "missing") reason = "management_stop_protocol_missing";
    else if (protocol?.stop === "restart") reason = "management_stop_requires_restart";
    else if (protocol?.codeUpdate === "missing") reason = "management_code_update_missing";
    else if (protocol?.codeUpdate === "restart") reason = "management_code_update_requires_restart";
    else if (protocol?.codeUpdate === "mismatch") reason = "management_manifest_replacement_mismatch";
    else if (entry.enabled !== true) reason = enableAuthorized ? undefined : "management_enable_constrained";
    const canEnable = entry.managementClass === "managed" && entry.enabled !== true && enableAuthorized;
    const canDisable = entry.managementClass === "managed" && entry.enabled === true &&
      ((entry.phase === "active" && protocol?.conformance === "online") ||
        ((entry.phase === "pending" || entry.phase === "failed") && protocol?.conformance === "inactive"));
    const canReplace = entry.managementClass === "managed" && entry.phase === "active" && protocol?.conformance === "online";
    result[entry.id] = Object.freeze({
      managementClass: entry.managementClass,
      canEnable,
      canDisable,
      canReplace,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return Object.freeze(result);
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

function changeErrorCode(error: unknown, fallback: string): string {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code
    : error instanceof Error ? error.message : fallback;
  return /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : fallback;
}
