import { randomUUID } from "node:crypto";
import { FiberState, type Context } from "@deepseek-ai/cordis";

export type PluginChangeKind = "enable" | "disable" | "reconfigure" | "replace";
export type PluginChangeSource = "management" | "configuration" | "hmr" | "standalone-stop";
export type PluginChangePhase =
  | "queued"
  | "preflight"
  | "waiting-safe-point"
  | "fencing"
  | "draining"
  | "staging"
  | "switching"
  | "retiring"
  | "verifying"
  | "succeeded"
  | "rejected"
  | "recovery-required";

export interface PluginChange {
  readonly kind: PluginChangeKind;
  readonly source: PluginChangeSource;
  readonly requestId?: string;
  readonly entryIds?: readonly string[];
  /** Host-only idempotency metadata. */
  readonly fingerprint?: string;
  readonly submittedRevision?: string;
}

export interface PluginChangeOperationView {
  readonly id: string;
  readonly kind: PluginChangeKind;
  readonly source: PluginChangeSource;
  readonly requestId: string | null;
  readonly entryIds: readonly string[];
  readonly fingerprint: string | null;
  readonly submittedRevision: string | null;
  readonly phase: PluginChangePhase;
  readonly code: string | null;
  readonly cancellable: boolean;
}

export interface PluginChangeSnapshot {
  readonly revision: number;
  readonly active: PluginChangeOperationView | null;
  readonly queued: readonly PluginChangeOperationView[];
  readonly last: PluginChangeOperationView | null;
}

export interface PluginChangeScope {
  readonly change: PluginChange;
  readonly signal: AbortSignal;
  phase(phase: Exclude<PluginChangePhase, "queued" | "succeeded" | "rejected" | "recovery-required">): Promise<void>;
  target(entryIds: readonly string[]): Promise<void>;
  reject(code: string): Promise<void>;
  recovery(code: string): Promise<void>;
}

export interface PluginChangeHandle<T> {
  readonly id: string;
  /** Settles only after the queued operation is durable. */
  readonly accepted: Promise<PluginChangeOperationView>;
  /** Host-owned completion; disconnecting a caller never cancels it. */
  readonly completion: Promise<T>;
}

export interface PluginChangeJournal {
  latest(): PluginChangeOperationView | null;
  record(operation: PluginChangeOperationView): Promise<void>;
}

export class PluginChangeError extends Error {
  constructor(readonly code: string) { super(code); }
}

interface QueueItem {
  readonly change: PluginChange;
  readonly task: (scope: PluginChangeScope) => Promise<unknown>;
  readonly controller: AbortController;
  readonly acceptedResolve: (view: PluginChangeOperationView) => void;
  readonly acceptedReject: (error: unknown) => void;
  readonly completionResolve: (value: unknown) => void;
  readonly completionReject: (error: unknown) => void;
  readonly accepted: Promise<PluginChangeOperationView>;
  readonly completion: Promise<unknown>;
  readonly externalSignal?: AbortSignal;
  readonly externalAbort?: () => void;
  view: PluginChangeOperationView;
  ready: boolean;
  cancelled: boolean;
  cancelError?: PluginChangeError;
  settled: boolean;
  outcome?: { readonly phase: "rejected" | "recovery-required"; readonly code: string };
}

declare module "@deepseek-ai/cordis" {
  interface Context { pluginChanges: PluginChangeCoordinator }
}

export function installPluginChangeCoordinator(root: Context): PluginChangeCoordinator {
  if (root.fiber.uid !== 0) throw new Error("Plugin change coordinator must be installed on the process Root");
  if (root.get("pluginChanges") !== undefined) throw new Error("Plugin change coordinator is already installed");
  const coordinator = new PluginChangeCoordinator(root);
  root.provide("pluginChanges", coordinator);
  return coordinator;
}

/** Standalone lifecycle adapters compose the same Root service in any install order. */
export function getOrInstallPluginChangeCoordinator(root: Context): PluginChangeCoordinator {
  return root.get("pluginChanges") ?? installPluginChangeCoordinator(root);
}

const phaseOrder: Readonly<Record<PluginChangePhase, number>> = Object.freeze({
  queued: 0,
  preflight: 1,
  "waiting-safe-point": 2,
  fencing: 3,
  draining: 4,
  staging: 5,
  switching: 6,
  retiring: 7,
  verifying: 8,
  succeeded: 9,
  rejected: 9,
  "recovery-required": 9,
});
const cancellable = new Set<PluginChangePhase>(["queued", "preflight", "waiting-safe-point"]);

/** Root authority for durable, serialized top-level plugin changes. */
export class PluginChangeCoordinator {
  private currentRevision = 0;
  private active: QueueItem | undefined;
  private readonly queue: QueueItem[] = [];
  private last: PluginChangeOperationView | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly closing = new AbortController();
  private journal?: PluginChangeJournal;
  private persistence: Promise<void> = Promise.resolve();

  constructor(private readonly root: Context) {
    root.effect(() => () => {
      const error = new PluginChangeError("plugin_change_closed");
      this.closing.abort(error);
      for (const item of [...this.queue]) this.cancel(item.view.id, error.code);
      this.active?.controller.abort(error);
    }, "plugin change coordinator");
  }

  attachJournal(journal: PluginChangeJournal): void {
    this.assertOpen();
    if (this.journal || this.active || this.queue.length) throw new PluginChangeError("plugin_change_journal_unavailable");
    this.journal = journal;
    this.last = journal.latest();
    this.bump();
  }

  snapshot(): PluginChangeSnapshot {
    return Object.freeze({ revision: this.currentRevision, active: this.active?.view ?? null,
      queued: Object.freeze(this.queue.map(item => item.view)), last: this.last });
  }

  subscribe(listener: () => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Waits for all accepted operations; it never admits or retries work. */
  wait(signal?: AbortSignal): Promise<void> {
    if (!this.active && !this.queue.length) return Promise.resolve();
    const combined = AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])]);
    return new Promise((resolve, reject) => {
      const finish = () => { remove(); combined.removeEventListener("abort", abort); resolve(); };
      const abort = () => { remove(); reject(combined.reason); };
      const remove = this.subscribe(() => { if (!this.active && !this.queue.length) finish(); });
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
      else if (!this.active && !this.queue.length) finish();
    });
  }

  submit<T>(change: PluginChange, task: (scope: PluginChangeScope) => Promise<T>, options: { readonly signal?: AbortSignal } = {}): PluginChangeHandle<T> {
    this.assertOpen();
    if (this.queue.length >= 64) throw new PluginChangeError("plugin_change_queue_full");
    const captured = captureChange(change);
    options.signal?.throwIfAborted();
    let acceptedResolve!: QueueItem["acceptedResolve"], acceptedReject!: QueueItem["acceptedReject"];
    let completionResolve!: (value: T) => void, completionReject!: QueueItem["completionReject"];
    const accepted = new Promise<PluginChangeOperationView>((resolve, reject) => { acceptedResolve = resolve; acceptedReject = reject; });
    const completion = new Promise<T>((resolve, reject) => { completionResolve = resolve; completionReject = reject; });
    // `run()` does not expose acceptance, while HTTP submission need not retain completion.
    void accepted.catch(() => {});
    void completion.catch(() => {});
    const id = randomUUID();
    const view = freezeView(id, captured, "queued", null);
    const item: QueueItem = { change: captured, task, controller: new AbortController(), acceptedResolve, acceptedReject,
      completionResolve: completionResolve as (value: unknown) => void, completionReject, accepted, completion, view, ready: false, cancelled: false, settled: false,
      ...(options.signal ? { externalSignal: options.signal } : {}) };
    if (options.signal) {
      const abort = () => { this.cancel(id, "plugin_change_cancelled"); };
      (item as { externalAbort?: () => void }).externalAbort = abort;
      options.signal.addEventListener("abort", abort, { once: true });
    }
    this.queue.push(item);
    this.bump();
    void this.persist(view).then(() => {
      item.ready = true; acceptedResolve(view); this.bump(); this.pump();
      if (item.cancelled) this.cancelQueued(item, item.cancelError ?? new PluginChangeError("plugin_change_cancelled"));
    }, error => {
      this.removeQueued(item);
      item.settled = true; acceptedReject(error); completionReject(error);
      this.last = freezeView(id, captured, "rejected", "plugin_change_persistence_failed");
      this.bump(); this.pump();
    });
    return Object.freeze({ id, accepted, completion });
  }

  run<T>(change: PluginChange, task: (scope: PluginChangeScope) => Promise<T>, options: { readonly signal?: AbortSignal } = {}): Promise<T> {
    return this.submit(change, task, options).completion;
  }

  cancel(operationId: string, code = "plugin_change_cancelled"): boolean {
    const queued = this.queue.find(item => item.view.id === operationId);
    if (queued) {
      if (queued.cancelled || queued.settled) return false;
      queued.cancelled = true; queued.cancelError = new PluginChangeError(code);
      if (queued.ready) this.cancelQueued(queued, queued.cancelError);
      return true;
    }
    if (!this.active || this.active.view.id !== operationId || !cancellable.has(this.active.view.phase)) return false;
    this.active.controller.abort(new PluginChangeError(code));
    return true;
  }

  private pump(): void {
    if (this.active || this.closing.signal.aborted) return;
    const item = this.queue.find(candidate => candidate.ready && !candidate.cancelled);
    if (!item) return;
    this.removeQueued(item); this.active = item; this.bump();
    void this.execute(item);
  }

  private async execute(item: QueueItem): Promise<void> {
    const signal = AbortSignal.any([this.closing.signal, item.controller.signal]);
    const update = async (next: PluginChangeOperationView) => {
      item.view = next; this.bump();
      try { await this.persist(next); this.bump(); }
      catch (error) { item.controller.abort(new PluginChangeError("plugin_change_persistence_failed")); throw error; }
    };
    const mark = async (phase: "rejected" | "recovery-required", code: string) => {
      if (item.outcome) return;
      item.outcome = { phase, code: safeCode(code) };
      // Expose the decided outcome to in-process observers, but publish it to
      // the durable journal only when owned work has actually settled.
      item.view = freezeView(item.view.id, { ...item.change, entryIds: item.view.entryIds }, phase, item.outcome.code);
      this.bump();
    };
    const scope: PluginChangeScope = Object.freeze({
      change: item.change,
      signal,
      phase: async (phase: Exclude<PluginChangePhase, "queued" | "succeeded" | "rejected" | "recovery-required">) => {
        signal.throwIfAborted();
        this.assertScope(item);
        if (phaseOrder[phase] < phaseOrder[item.view.phase]) throw new PluginChangeError("plugin_change_phase_regression");
        if (phase !== item.view.phase) await update(freezeView(item.view.id, { ...item.change, entryIds: item.view.entryIds }, phase, null));
        signal.throwIfAborted();
      },
      target: async (entryIds: readonly string[]) => {
        signal.throwIfAborted();
        this.assertScope(item);
        const target = captureEntryIds(entryIds);
        if (item.view.entryIds.length && JSON.stringify(item.view.entryIds) !== JSON.stringify(target)) {
          throw new PluginChangeError("plugin_change_target_changed");
        }
        if (!item.view.entryIds.length && target.length) {
          await update(freezeView(item.view.id, { ...item.change, entryIds: target }, item.view.phase, item.view.code));
        }
        signal.throwIfAborted();
      },
      reject: (code: string) => mark("rejected", code),
      recovery: (code: string) => mark("recovery-required", code),
    });
    try {
      await update(freezeView(item.view.id, item.change, "preflight", null));
      signal.throwIfAborted();
      const result = await item.task(scope);
      await this.finish(item, item.outcome?.phase ?? "succeeded", item.outcome?.code ?? null);
      item.completionResolve(result);
    } catch (error) {
      const phase = item.outcome?.phase ?? "rejected";
      const code = item.outcome?.code ?? (item.controller.signal.aborted ? errorCode(item.controller.signal.reason) : errorCode(error));
      await this.finish(item, phase, code).catch(() => {});
      item.completionReject(error);
    }
  }

  private async finish(item: QueueItem, phase: "succeeded" | "rejected" | "recovery-required", code: string | null): Promise<void> {
    if (item.settled) return;
    item.settled = true;
    const terminal = item.view.phase === phase && item.view.code === code ? item.view
      : freezeView(item.view.id, { ...item.change, entryIds: item.view.entryIds }, phase, code);
    item.view = terminal;
    try { await this.persist(terminal); }
    finally {
      this.removeExternalAbort(item);
      if (this.active === item) this.active = undefined;
      this.last = terminal; this.bump(); this.pump();
    }
  }

  private cancelQueued(item: QueueItem, error: PluginChangeError): void {
    if (item.settled || !item.ready) return;
    item.cancelled = true; item.settled = true;
    const terminal = freezeView(item.view.id, item.change, "rejected", error.code);
    item.view = terminal; this.bump();
    void this.persist(terminal).catch(() => {}).finally(() => {
      this.removeQueued(item); this.removeExternalAbort(item); this.last = terminal;
      item.completionReject(error); this.bump(); this.pump();
    });
  }

  private assertScope(item: QueueItem): void {
    if (item.outcome || item.settled || this.active !== item) throw new PluginChangeError("plugin_change_scope_inactive");
  }

  private removeQueued(item: QueueItem): void {
    const index = this.queue.indexOf(item);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private removeExternalAbort(item: QueueItem): void {
    if (item.externalSignal && item.externalAbort) item.externalSignal.removeEventListener("abort", item.externalAbort);
  }

  private persist(view: PluginChangeOperationView): Promise<void> {
    if (!this.journal) return Promise.resolve();
    const write = this.persistence.then(() => this.journal!.record(view));
    this.persistence = write.catch(() => {});
    return write;
  }

  private assertOpen(): void {
    if (this.closing.signal.aborted || this.root.fiber.state !== FiberState.ACTIVE) {
      throw new PluginChangeError("plugin_change_closed");
    }
  }

  private bump(): void {
    this.currentRevision += 1;
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* Observers cannot control a change. */ } }
  }
}

function captureChange(change: PluginChange): PluginChange {
  if (!change || !["enable", "disable", "reconfigure", "replace"].includes(change.kind) ||
    !["management", "configuration", "hmr", "standalone-stop"].includes(change.source)) {
    throw new PluginChangeError("plugin_change_invalid");
  }
  const entryIds = captureEntryIds(change.entryIds ?? []);
  if (change.requestId !== undefined && !validText(change.requestId)) throw new PluginChangeError("plugin_change_invalid");
  if (change.fingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(change.fingerprint)) throw new PluginChangeError("plugin_change_invalid");
  if (change.submittedRevision !== undefined && !validText(change.submittedRevision)) throw new PluginChangeError("plugin_change_invalid");
  return Object.freeze({ kind: change.kind, source: change.source, entryIds,
    ...(change.requestId === undefined ? {} : { requestId: change.requestId }),
    ...(change.fingerprint === undefined ? {} : { fingerprint: change.fingerprint }),
    ...(change.submittedRevision === undefined ? {} : { submittedRevision: change.submittedRevision }) });
}

function captureEntryIds(entryIds: readonly string[]): readonly string[] {
  if (!Array.isArray(entryIds) || entryIds.length > 512 || entryIds.some(entryId => !validText(entryId)) ||
    new Set(entryIds).size !== entryIds.length) throw new PluginChangeError("plugin_change_invalid");
  return Object.freeze([...entryIds]);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f]/u.test(value);
}

function safeCode(code: string): string {
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : "plugin_change_failed";
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return safeCode(error.code);
  if (error instanceof Error && /^(?:plugin_change|management|code_reload|stop)_[a-z0-9_]+$/u.test(error.message)) return safeCode(error.message);
  return "plugin_change_failed";
}

function freezeView(id: string, change: PluginChange, phase: PluginChangePhase, code: string | null): PluginChangeOperationView {
  return Object.freeze({ id, kind: change.kind, source: change.source, requestId: change.requestId ?? null,
    entryIds: Object.freeze([...(change.entryIds ?? [])]), fingerprint: change.fingerprint ?? null,
    submittedRevision: change.submittedRevision ?? null, phase, code,
    cancellable: cancellable.has(phase) });
}
