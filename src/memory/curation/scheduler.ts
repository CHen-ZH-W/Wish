import type { Memory, MemoryContent } from "../types.js";
import { content, hash } from "../validation.js";
import type { CurationEvidence, CurationEvidenceSource, CurationJob, CurationState, CurationStore, MemoryCandidateExtractor } from "./types.js";
import { evidenceJobId, snapshotCurationState, snapshotEvidence } from "./validation.js";

export interface MemoryCurationOptions {
  readonly store: CurationStore;
  readonly memory: Pick<Memory, "libraryId" | "propose">;
  readonly extractor: MemoryCandidateExtractor;
  readonly maxConcurrent?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
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

/** Owns durable curation jobs only; accepting a candidate is never a scheduler action. */
export class MemoryCurationScheduler {
  private readonly sources = new Map<string, EvidenceRegistration>();
  private readonly active = new Map<string, AbortController>();
  private tail = Promise.resolve();
  private ticking: Promise<void> | undefined;
  private scanning: Promise<number> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly closingSignal = new AbortController();
  private closing: Promise<void> | undefined;
  private suspended = false;
  readonly maxConcurrent: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  constructor(private readonly options: MemoryCurationOptions) {
    this.maxConcurrent = positive(options.maxConcurrent ?? 1, 16);
    this.maxAttempts = positive(options.maxAttempts ?? 3, 32);
    this.timeoutMs = positive(options.timeoutMs ?? 30_000, 300_000);
  }
  registerSource(source: CurationEvidenceSource): () => Promise<void> {
    this.assertOpen();
    if (this.sources.has(source.id)) throw new Error("Duplicate curation evidence source");
    const registration = { source, cancellation: new AbortController(), reads: new Set<Promise<readonly CurationEvidence[]>>() };
    this.sources.set(source.id, registration);
    return () => this.removeSource(registration);
  }
  async state(signal?: AbortSignal): Promise<CurationState> { this.assertOpen(); return this.options.store.read(signal); }
  async recover(): Promise<void> {
    this.assertOpen();
    if (this.ticking || this.active.size) throw new Error("Cannot recover while curation jobs are executing");
    await this.update(state => ({ ...state, jobs: state.jobs.map(job =>
      job.status === "running" || job.status === "proposing"
        ? { ...job, status: job.proposals !== undefined || job.attempts < this.maxAttempts ? "queued" : "failed", updatedAt: this.now(), error: "Previous curation execution interrupted" }
        : job) }));
  }
  scan(signal?: AbortSignal): Promise<number> {
    this.assertOpen();
    if (this.scanning) return this.scanning;
    const combined = combine(this.closingSignal.signal, signal);
    this.scanning = (async () => {
      let added = 0;
      for (const registration of [...this.sources.values()]) {
        combined.throwIfAborted();
        const { source } = registration;
        const sourceSignal = AbortSignal.any([combined, registration.cancellation.signal, AbortSignal.timeout(this.timeoutMs)]);
        const pending = source.scan(sourceSignal);
        registration.reads.add(pending);
        void pending.finally(() => registration.reads.delete(pending)).catch(() => {});
        const evidence = await abortable(pending, sourceSignal);
        sourceSignal.throwIfAborted();
        await this.update(state => {
          const ids = new Set(state.jobs.map(job => job.id)), jobs = [...state.jobs];
          for (const raw of evidence) {
            const item = snapshotEvidence(raw);
            if (item.sourceId !== source.id) throw new Error("Curation source identity mismatch");
            const id = evidenceJobId(item);
            if (ids.has(id)) continue;
            if (jobs.length >= 1000) throw new Error("Curation job budget exhausted");
            const at = this.now();
            jobs.push({ id, evidence: item, status: "queued", attempts: 0, candidateIds: [], createdAt: at, updatedAt: at });
            ids.add(id); added++;
          }
          return jobs.length === state.jobs.length ? state : { ...state, jobs };
        }, sourceSignal);
      }
      return added;
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  tick(): Promise<void> {
    this.assertOpen();
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const state = await this.options.store.read(this.closingSignal.signal);
      const queued = state.jobs.filter(job => job.status === "queued").slice(0, this.maxConcurrent);
      await Promise.all(queued.map(job => this.execute(job.id)));
    })().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  async cancel(id: string): Promise<void> {
    this.assertOpen();
    this.active.get(id)?.abort(new Error("Curation cancelled"));
    await this.change(id, job => ["queued", "running", "proposing"].includes(job.status)
      ? { ...job, status: "cancelled", updatedAt: this.now(), error: "Cancelled by host" } : job);
  }
  start(intervalMs = 5_000): void {
    this.assertOpen(); positive(intervalMs, 3_600_000);
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scan().then(() => this.tick()).catch(error => {
        if (!this.closingSignal.signal.aborted) this.options.onError?.(error);
      });
    }, intervalMs);
    this.timer.unref?.();
  }
  lifecycleSnapshot(): MemoryCurationLifecycleSnapshot {
    return Object.freeze({ activeJobs: this.active.size, scanning: this.scanning ? 1 : 0, ticking: this.ticking ? 1 : 0,
      sourceReads: [...this.sources.values()].reduce((count, source) => count + source.reads.size, 0) });
  }
  suspendAdmissions(): () => void {
    this.assertOpen();
    if (this.suspended) throw new Error("Memory curation admission is already suspended");
    this.suspended = true;
    let active = true;
    return () => { if (active && !this.closing) this.suspended = false; active = false; };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.timer) clearInterval(this.timer);
    this.closingSignal.abort(new Error("Memory curation closed"));
    for (const controller of this.active.values()) controller.abort(this.closingSignal.signal.reason);
    return this.closing = (async () => {
      await Promise.allSettled([this.scanning, this.ticking]);
      await this.tail;
      await Promise.all([...this.sources.values()].map(source => this.removeSource(source)));
      await this.options.store.close();
    })();
  }
  private async execute(id: string): Promise<void> {
    if (this.closingSignal.signal.aborted) return;
    const controller = new AbortController(), signal = combine(controller.signal, this.closingSignal.signal);
    this.active.set(id, controller);
    const timer = setTimeout(() => controller.abort(new Error("Curation time budget exhausted")), this.timeoutMs);
    try {
      let job = await this.change(id, current => current.status !== "queued" ? current
        : { ...current, status: "running", attempts: current.attempts + 1, updatedAt: this.now() });
      if (job.status !== "running") return;
      signal.throwIfAborted();
      if (job.proposals === undefined) {
        const extracted = await abortable(this.options.extractor.extract(job.evidence, signal), signal);
        signal.throwIfAborted();
        if (!Array.isArray(extracted) || extracted.length > 8) throw new Error("Curation proposal budget exceeded");
        const references = new Set(job.evidence.references.map(reference => hash(reference)));
        const proposals: readonly MemoryContent[] = extracted.map(item => {
          const proposal = content(item);
          if (proposal.evidence.some(reference => !references.has(hash(reference)))) throw new Error("Extractor invented evidence references");
          return proposal;
        });
        job = await this.change(id, current => current.status === "running"
          ? { ...current, proposals, status: "proposing", updatedAt: this.now() } : current);
      }
      if (!["running", "proposing"].includes(job.status)) return;
      for (let index = job.candidateIds.length; index < job.proposals!.length; index++) {
        signal.throwIfAborted();
        const proposal = job.proposals![index]!;
        const candidate = await abortable(this.options.memory.propose({ ...proposal,
          operationId: `${id}:${index}`, targetId: `recap-${hash(`${id}:${index}`).slice(0, 48)}`,
          expectedDocumentVersion: 0, actor: { kind: "curation", id: "memory-curation",
            ...(job.evidence.sessionId ? { sessionId: job.evidence.sessionId } : {}), ...(job.evidence.runId ? { runId: job.evidence.runId } : {}) },
          reason: `Unreviewed ${job.evidence.outcome} execution evidence; no validation claim or automatic acceptance`, signal,
        }), signal);
        signal.throwIfAborted();
        job = await this.change(id, current => current.status === "cancelled" ? current
          : { ...current, status: "proposing", candidateIds: [...current.candidateIds, candidate.id], updatedAt: this.now() });
        if (job.status === "cancelled") return;
      }
      await this.change(id, current => current.status === "cancelled" ? current : { ...current, status: "completed", updatedAt: this.now() });
    } catch (error) {
      await this.change(id, current => current.status === "cancelled" ? current : {
        ...current, status: this.closingSignal.signal.aborted || current.attempts < this.maxAttempts ? "queued" : "failed",
        updatedAt: this.now(), error: (error instanceof Error ? error.message : "Curation execution failed").slice(0, 2000) || "Curation failed",
      });
    } finally { clearTimeout(timer); this.active.delete(id); }
  }
  private async change(id: string, transform: (job: CurationJob) => CurationJob): Promise<CurationJob> {
    let result: CurationJob | undefined;
    await this.update(state => {
      const jobs = state.jobs.map(job => job.id !== id ? job : (result = transform(job)));
      if (!result) throw new Error("Unknown curation job");
      return { ...state, jobs };
    });
    if (!result) throw new Error("Unknown curation job");
    return result;
  }
  private update(transform: (state: CurationState) => CurationState, signal?: AbortSignal): Promise<void> {
    const operation = this.tail.then(async () => {
      signal?.throwIfAborted();
      const state = await this.options.store.read(signal);
      if (state.libraryId !== this.options.memory.libraryId) throw new Error("Curation and Memory library mismatch");
      const changed = transform(state); if (changed === state) return;
      const result = snapshotCurationState({ ...changed, revision: state.revision + 1 });
      await this.options.store.commit(result, state.revision, signal);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
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
function positive(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("Invalid curation budget"); return value;
}
function combine(first: AbortSignal, second?: AbortSignal): AbortSignal { return second ? AbortSignal.any([first, second]) : first; }
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
