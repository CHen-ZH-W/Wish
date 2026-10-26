import type { Memory, MemoryEvidence } from "../types.js";
import { MemoryRevisionConflictError } from "../types.js";
import { content, hash } from "../validation.js";
import type { ConsolidationInput, ConsolidationPlan, CurationEvidence, CurationEvidenceSource, CurationJob, CurationScanContext, CurationState, CurationStore, MemoryConsolidator, MemoryExtractor } from "./types.js";
import { evidenceJobId, snapshotCurationState, snapshotEvidence, snapshotPlan, snapshotRawMemory, validateConsolidation } from "./validation.js";

type Eligibility = (job: CurationJob) => Promise<boolean>;
export interface MemoryCurationOptions {
  readonly store: CurationStore;
  readonly memory: Pick<Memory, "libraryId" | "state" | "consolidate">;
  readonly extractor: MemoryExtractor;
  readonly consolidator: MemoryConsolidator;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly maintenance?: boolean;
  readonly maxUnusedDays?: number;
  readonly sourceAvailable?: (job: CurationJob) => Promise<boolean>;
}
interface EvidenceRegistration {
  readonly source: CurationEvidenceSource;
  readonly cancellation: AbortController;
  readonly reads: Set<Promise<readonly CurationEvidence[]>>;
}
export interface MemoryCurationLifecycleSnapshot {
  readonly activeJobs: number;
  readonly scanning: number;
  readonly ticking: number;
  readonly sourceReads: number;
}

/** One serialized pipeline per library: durable extraction -> atomic consolidation. */
export class MemoryCurationScheduler {
  private readonly sources = new Map<string, EvidenceRegistration>();
  private readonly active = new Map<string, AbortController>();
  private readonly pendingWork = new Set<Promise<unknown>>();
  private readonly stateReads = new Set<Promise<CurationState>>();
  private tail = Promise.resolve();
  private ticking: Promise<void> | undefined;
  private scanning: Promise<number> | undefined;
  private readonly closingSignal = new AbortController();
  private closing: Promise<void> | undefined;
  private suspended = false;
  private registrationWhileSuspended = false;
  private consolidationController: AbortController | undefined;
  private consolidatingIds: readonly string[] = [];
  constructor(private readonly options: MemoryCurationOptions) {}

  registerSource(source: CurationEvidenceSource): () => Promise<void> {
    if (!this.registrationWhileSuspended) this.assertOpen();
    else if (this.closingSignal.signal.aborted) throw new Error("Memory curation is closed");
    if (this.sources.has(source.id)) throw new Error("Duplicate curation evidence source");
    const registration = { source, cancellation: new AbortController(), reads: new Set<Promise<readonly CurationEvidence[]>>() };
    this.sources.set(source.id, registration);
    return () => this.removeSource(registration);
  }
  async state(signal?: AbortSignal): Promise<CurationState> {
    this.assertOpen();
    const read = Promise.resolve().then(() => this.options.store.read(signal));
    this.stateReads.add(read);
    try { return await read; } finally { this.stateReads.delete(read); }
  }
  async recover(): Promise<void> {
    this.assertOpen();
    if (this.ticking || this.pendingWork.size) throw new Error("Cannot recover while curation is executing");
    await this.update(state => ({ ...state, jobs: state.jobs.map(job =>
      ["running", "proposing", "consolidating", "failed"].includes(job.status)
        ? { ...job, status: job.rawMemories === undefined ? "queued" : job.rawMemories.length ? "extracted" : "completed", updatedAt: this.now() }
        : job) }));
  }
  /** Explicit retention/correction/deletion is an append-only note, not a review candidate. */
  async addNote(input: { operationId: string; text: string; evidence: readonly MemoryEvidence[]; appliesTo?: string }, signal?: AbortSignal): Promise<{ noteId: string; status: "recorded" }> {
    this.assertOpen();
    const at = this.now();
    const evidence = snapshotEvidence({ id: `note-${hash(input.operationId)}`, sourceId: "memory-notes", outcome: "unknown",
      occurredAt: at, text: input.text, appliesTo: input.appliesTo ?? "Explicit memory update", references: input.evidence });
    const id = evidenceJobId(evidence);
    await this.update(state => {
      const previous = state.jobs.find(job => job.evidence.id === evidence.id);
      if (previous) {
        if (previous.id !== id) throw new Error("Memory note idempotency conflict");
        return state;
      }
      const raw = content({ title: "Explicit memory note", content: input.text, appliesTo: evidence.appliesTo, keywords: [], evidence: input.evidence });
      return { ...state, jobs: [...state.jobs, { id, evidence, status: "extracted", rawMemories: [raw], attempts: 0, candidateIds: [], createdAt: at, updatedAt: at }] };
    }, signal);
    return { noteId: id, status: "recorded" };
  }
  /** Usage is associated with cited source IDs, never inferred from the existence of a summary. */
  async recordUsage(sourceIds: readonly string[], signal?: AbortSignal): Promise<void> {
    this.assertOpen(); const ids = new Set(sourceIds), at = this.now();
    await this.update(state => {
      if (!state.jobs.some(job => ids.has(job.id))) return state;
      return { ...state, jobs: state.jobs.map(job => ids.has(job.id) ? { ...job, usageCount: (job.usageCount ?? 0) + 1, lastUsedAt: at } : job) };
    }, signal);
  }
  scan(signal?: AbortSignal, context?: CurationScanContext): Promise<number> {
    this.assertOpen();
    if (this.scanning) return this.scanning;
    const combined = combine(this.closingSignal.signal, signal);
    this.scanning = (async () => {
      let added = 0;
      for (const registration of [...this.sources.values()]) {
        combined.throwIfAborted();
        const { source } = registration;
        const sourceSignal = AbortSignal.any([combined, registration.cancellation.signal]);
        const pending = source.scan(sourceSignal, context);
        registration.reads.add(pending);
        void pending.finally(() => registration.reads.delete(pending)).catch(() => {});
        const evidence = await abortable(pending, sourceSignal);
        sourceSignal.throwIfAborted();
        await this.update(state => {
          const jobs = [...state.jobs]; let changed = false;
          for (const raw of evidence) {
            const item = snapshotEvidence(raw);
            if (item.sourceId !== source.id) throw new Error("Curation source identity mismatch");
            const index = jobs.findIndex(job => job.evidence.id === item.id && job.evidence.sourceId === item.sourceId);
            if (index !== -1) {
              const previous = jobs[index]!;
              if (previous.evidence.occurredAt === undefined && item.occurredAt !== undefined) {
                jobs[index] = { ...previous, evidence: { ...previous.evidence, occurredAt: item.occurredAt } }; changed = true;
              }
              continue;
            }
            const at = this.now();
            jobs.push({ id: evidenceJobId(item), evidence: item, status: "queued", attempts: 0, candidateIds: [], createdAt: at, updatedAt: at });
            added++; changed = true;
          }
          return changed ? { ...state, jobs } : state;
        }, sourceSignal);
      }
      return added;
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  tick(accepts?: Eligibility): Promise<void> {
    this.assertOpen();
    if (this.ticking) return this.ticking;
    if (this.pendingWork.size) return Promise.resolve();
    this.ticking = (async () => {
      const state = await this.options.store.read(this.closingSignal.signal);
      // Each captured job is attempted once per wake. Failures wait for a later event.
      for (const job of state.jobs) {
        if (this.closingSignal.signal.aborted || this.suspended || this.pendingWork.size) break;
        if (job.status === "queued" && await this.eligible(job, accepts)) await this.extract(job.id, accepts);
      }
      if (!this.closingSignal.signal.aborted && !this.suspended && !this.pendingWork.size) {
        await this.consolidate(accepts);
        if (this.options.maintenance && !this.closingSignal.signal.aborted) await this.pruneHistory();
      }
    })().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  async cancel(id: string): Promise<void> {
    this.assertOpen();
    this.active.get(id)?.abort(new Error("Curation cancelled"));
    if (this.consolidatingIds.includes(id)) this.consolidationController?.abort(new Error("Curation cancelled"));
    await this.change(id, job => ["completed", "cancelled"].includes(job.status) ? job
      : { ...job, status: "cancelled", updatedAt: this.now(), error: "Cancelled by host" });
  }
  lifecycleSnapshot(): MemoryCurationLifecycleSnapshot {
    return Object.freeze({ activeJobs: Math.max(this.active.size + Number(this.consolidationController !== undefined), this.pendingWork.size),
      scanning: this.scanning ? 1 : 0, ticking: this.ticking ? 1 : 0,
      sourceReads: [...this.sources.values()].reduce((count, source) => count + source.reads.size, this.stateReads.size) });
  }
  suspendAdmissions(options: { readonly allowRegistration?: boolean } = {}): () => void {
    this.assertOpen(); this.suspended = true; this.registrationWhileSuspended = options.allowRegistration === true;
    let active = true;
    return () => { if (active && !this.closing) { this.suspended = false; this.registrationWhileSuspended = false; } active = false; };
  }
  async drain(): Promise<void> {
    await Promise.allSettled([this.scanning, this.ticking, ...this.stateReads, ...[...this.sources.values()].flatMap(source => [...source.reads])]);
    await this.tail;
    await Promise.allSettled([...this.pendingWork]);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closingSignal.abort(new Error("Memory curation closed"));
    return this.closing = (async () => {
      await this.drain();
      await Promise.all([...this.sources.values()].map(source => this.removeSource(source)));
      await this.options.store.close();
    })();
  }
  private async eligible(job: CurationJob, accepts?: Eligibility): Promise<boolean> {
    return job.evidence.sourceId === "memory-notes" || !accepts || (this.sources.has(job.evidence.sourceId) && await accepts(job));
  }
  private async extract(id: string, accepts?: Eligibility): Promise<void> {
    const controller = new AbortController(), signal = combine(controller.signal, this.closingSignal.signal);
    this.active.set(id, controller);
    try {
      const current = (await this.options.store.read(signal)).jobs.find(job => job.id === id);
      if (!current || current.status !== "queued" || !await this.eligible(current, accepts)) return;
      const job = await this.change(id, value => value.status !== "queued" ? value
        : { ...withoutError(value), status: "running", attempts: value.attempts + 1, updatedAt: this.now() });
      if (job.status !== "running") return;
      signal.throwIfAborted();
      const extracted = await abortable(this.track(this.options.extractor.extract(job.evidence, signal)), signal);
      signal.throwIfAborted();
      if (!Array.isArray(extracted)) throw new Error("Invalid extracted memories");
      const references = new Set(job.evidence.references.map(reference => hash(reference)));
      const rawMemories = extracted.map(item => {
        const memory = snapshotRawMemory(item);
        if (memory.evidence.some(reference => !references.has(hash(reference)))) throw new Error("Extractor invented evidence references");
        return memory;
      });
      await this.change(id, value => value.status !== "running" ? value
        : { ...value, rawMemories, status: rawMemories.length ? "extracted" : "completed", updatedAt: this.now() });
    } catch (error) {
      await this.change(id, job => job.status === "cancelled" ? job : { ...job, status: "queued", updatedAt: this.now(), error: message(error) });
      if (!signal.aborted) this.report(error);
    } finally { this.active.delete(id); }
  }
  private async consolidate(accepts?: Eligibility): Promise<void> {
    const controller = new AbortController(), signal = combine(controller.signal, this.closingSignal.signal);
    this.consolidationController = controller;
    try {
      let state = await this.options.store.read(signal), plan = state.consolidation;
      if (!plan) {
        const jobs: CurationJob[] = this.options.maintenance ? await this.selected(state.jobs) : [];
        if (!this.options.maintenance) for (const job of state.jobs) if (job.status === "extracted" && await this.eligible(job, accepts)) jobs.push(job);
        const memory = await this.options.memory.state(signal);
        const workspaceFingerprint = await this.options.consolidator.inputFingerprint?.();
        const inputDigest = hash([...jobs].sort((a, b) => a.id.localeCompare(b.id)).map(job => ({ id: job.id, raw: job.rawMemories })));
        if (this.options.maintenance) {
          const unchanged = inputDigest === state.inputDigest && memory.revision === state.libraryRevision;
          if (unchanged && (!workspaceFingerprint || workspaceFingerprint === hash({}))) return;
        } else if (!jobs.length) return;
        this.consolidatingIds = jobs.map(job => job.id);
        const input: ConsolidationInput = {
          rawMemories: [...jobs.flatMap(job => job.rawMemories!.map((item, index) => ({ ...item, id: `${job.id}:${index}` }))), ...workspaceEvidence(workspaceFingerprint, this.options.maintenance === true && !jobs.length && !memory.documents.length)],
          documents: this.options.maintenance ? memory.documents : memory.documents.filter(item => item.status === "accepted"),
          ...(this.options.maintenance ? { jobs, removedJobIds: (state.selectedJobIds ?? []).filter(id => !jobs.some(job => job.id === id)) } : {}),
        };
        const changes = validateConsolidation(await abortable(this.track(this.options.consolidator.consolidate(input, signal)), signal), input);
        signal.throwIfAborted();
        const jobIds = jobs.map(job => job.id);
        plan = snapshotPlan({ ...changes, jobIds, expectedRevision: memory.revision,
          ...(this.options.maintenance ? { inputDigest } : {}), ...(workspaceFingerprint === undefined ? {} : { workspaceFingerprint }),
          operationId: `consolidate-${hash({ jobIds, revision: memory.revision, changes })}` });
        const saved = plan;
        await this.update(value => ({ ...value, consolidation: saved }));
        state = await this.options.store.read(signal);
      }
      this.consolidatingIds = plan.jobIds;
      const memory = await this.options.memory.state(signal);
      const committed = memory.audit.some(item => item.operationId === plan!.operationId);
      if (!committed) {
        for (const id of plan.jobIds) {
          const job = state.jobs.find(item => item.id === id);
          if (!job || job.status === "cancelled" || !(this.options.maintenance ? await this.available(job) : await this.eligible(job, accepts))) { await this.clearPlan(); return; }
        }
        if (memory.revision !== plan.expectedRevision) throw new MemoryRevisionConflictError();
        if (plan.workspaceFingerprint !== undefined && plan.workspaceFingerprint !== await this.options.consolidator.inputFingerprint?.()) throw new MemoryRevisionConflictError();
        validateConsolidation(plan, {
          rawMemories: [...state.jobs.filter(job => plan!.jobIds.includes(job.id)).flatMap(job =>
            job.rawMemories!.map((item, index) => ({ ...item, id: `${job.id}:${index}` }))), ...workspaceEvidence(plan.workspaceFingerprint, this.options.maintenance === true && !plan.jobIds.length && !memory.documents.length)],
          documents: this.options.maintenance ? memory.documents : memory.documents.filter(item => item.status === "accepted"),
        });
      }
      signal.throwIfAborted();
      const libraryRevision = await abortable(this.track(this.options.memory.consolidate({ ...plan,
        actor: { kind: "curation", id: "memory-curation" }, reason: "Automatic consolidation of durable execution evidence", signal })), signal);
      signal.throwIfAborted();
      if (plan.files) await this.options.consolidator.publish?.(plan.files, signal, plan.workspaceBefore);
      const completed = plan;
      await this.update(value => {
        const { consolidation: _plan, ...rest } = value;
        return { ...rest, ...(completed.inputDigest === undefined ? {} : { inputDigest: completed.inputDigest, selectedJobIds: completed.jobIds, libraryRevision }),
          jobs: value.jobs.map(job => !completed.jobIds.includes(job.id) ? job : {
          ...withoutError(job), status: job.status === "cancelled" ? "cancelled" : "completed", updatedAt: this.now(),
          documentIds: completed.upserts.map(item => item.id),
        }) };
      });
    } catch (error) {
      if (error instanceof MemoryRevisionConflictError) await this.clearPlan();
      await this.update(state => ({ ...state, jobs: state.jobs.map(job => !this.consolidatingIds.includes(job.id) || job.status === "cancelled" ? job
        : { ...job, error: message(error), updatedAt: this.now() }) }));
      if (!signal.aborted) this.report(error);
    } finally { this.consolidatingIds = []; this.consolidationController = undefined; }
  }
  private async pruneHistory(): Promise<void> {
    const state = await this.options.store.read(this.closingSignal.signal);
    if (state.consolidation) return;
    const current = await this.selected(state.jobs);
    if (hash([...current].sort((a, b) => a.id.localeCompare(b.id)).map(job => ({ id: job.id, raw: job.rawMemories }))) !== state.inputDigest) return;
    const selected = new Set(state.selectedJobIds ?? []), discarded = new Set<string>();
    const latest = latestSessionJobs(state.jobs);
    for (const job of state.jobs) {
      if (selected.has(job.id) || job.evidence.sourceId === "memory-notes") continue;
      const replacement = job.evidence.sessionId && latest.get(job.evidence.sessionId);
      const replaced = job.evidence.sourceId === "runtime-sessions" && replacement && replacement.id !== job.id;
      if (replaced || !await this.available(job)) discarded.add(job.id);
    }
    if (!discarded.size) return;
    await this.update(value => value.consolidation ? value : { ...value,
      retiredEvidenceIds: [...new Set([...(value.retiredEvidenceIds ?? []), ...value.jobs.filter(job => discarded.has(job.id)).map(job => job.evidence.id)])],
      jobs: value.jobs.filter(job => !discarded.has(job.id)) });
  }
  private async available(job: CurationJob): Promise<boolean> {
    if (job.evidence.sourceId === "memory-notes") return true;
    if (this.options.sourceAvailable && !await this.options.sourceAvailable(job)) return false;
    const reference = Date.parse(job.lastUsedAt ?? job.evidence.occurredAt ?? job.updatedAt);
    return reference >= Date.parse(this.now()) - (this.options.maxUnusedDays ?? 30) * 86_400_000;
  }
  private async selected(jobs: readonly CurationJob[]): Promise<CurationJob[]> {
    const selected: CurationJob[] = [], latest = latestSessionJobs(jobs);
    for (const job of jobs) {
      if (!["extracted", "completed"].includes(job.status) || !job.rawMemories?.length || !await this.available(job)) continue;
      if (job.evidence.sourceId === "runtime-sessions" && job.evidence.sessionId && latest.get(job.evidence.sessionId)?.id !== job.id) continue;
      selected.push(job);
    }
    return selected.sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0) || a.id.localeCompare(b.id));
  }
  private clearPlan(): Promise<void> {
    return this.update(state => { const { consolidation: _plan, ...rest } = state; return rest; });
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pendingWork.add(promise);
    void promise.finally(() => this.pendingWork.delete(promise)).catch(() => {});
    return promise;
  }
  private async change(id: string, transform: (job: CurationJob) => CurationJob): Promise<CurationJob> {
    let result: CurationJob | undefined;
    await this.update(state => {
      const jobs = state.jobs.map(job => job.id !== id ? job : (result = transform(job)));
      if (!result) throw new Error("Unknown curation job");
      return { ...state, jobs };
    });
    return result!;
  }
  private update(transform: (state: CurationState) => CurationState, signal?: AbortSignal): Promise<void> {
    const operation = this.tail.then(async () => {
      signal?.throwIfAborted();
      const state = await this.options.store.read(signal);
      if (state.libraryId !== this.options.memory.libraryId) throw new Error("Curation and Memory library mismatch");
      const changed = transform(state); if (changed === state) return;
      await this.options.store.commit(snapshotCurationState({ ...changed, revision: state.revision + 1 }), state.revision, signal);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* Isolated diagnostics. */ } }
  private async removeSource(registration: EvidenceRegistration): Promise<void> {
    if (this.sources.get(registration.source.id) === registration) this.sources.delete(registration.source.id);
    registration.cancellation.abort(new Error("Memory evidence source retired"));
    await Promise.allSettled([...registration.reads]);
  }
  private assertOpen(): void {
    if (this.closingSignal.signal.aborted) throw new Error("Memory curation is closed");
    if (this.suspended) throw new Error("Memory curation admission is suspended");
  }
}
/** Empty extraction replaces the previous snapshot too; sequence resolves equal timestamps. */
function latestSessionJobs(jobs: readonly CurationJob[]): Map<string, CurationJob> {
  const latest = new Map<string, CurationJob>();
  const sequence = (job: CurationJob) => Math.max(0, ...job.evidence.references.map(ref => ref.kind === "session" ? ref.throughSequence ?? 0 : 0));
  for (const job of jobs) {
    if (job.evidence.sourceId !== "runtime-sessions" || !job.evidence.sessionId || !["extracted", "completed"].includes(job.status) || job.rawMemories === undefined) continue;
    const previous = latest.get(job.evidence.sessionId);
    if (!previous || sequence(job) > sequence(previous) || (sequence(job) === sequence(previous) &&
      Date.parse(job.evidence.occurredAt ?? job.createdAt) >= Date.parse(previous.evidence.occurredAt ?? previous.createdAt))) latest.set(job.evidence.sessionId, job);
  }
  return latest;
}
function withoutError(job: CurationJob): CurationJob { const { error: _error, ...rest } = job; return rest; }
function message(error: unknown): string { return error instanceof Error && error.message ? error.message : "Memory curation failed"; }
function combine(first: AbortSignal, second?: AbortSignal): AbortSignal { return second ? AbortSignal.any([first, second]) : first; }
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function workspaceEvidence(fingerprint?: string, initialize = false) {
  fingerprint ??= hash({});
  return !initialize && fingerprint === hash({}) ? [] : [{ id: `workspace-${fingerprint}`,
    ...content({ title: "Memory workspace edits", content: "Host-captured external memory changes; read phase2_workspace_diff.md for the actual edited files.", appliesTo: "Memory workspace", keywords: [],
      evidence: [{ kind: "operator", id: "memory-workspace", revision: fingerprint, digest: fingerprint }] }) }];
}
