import { digest, EvolutionError, EvolutionStageError, fail, text, validateReceipt, validateSpec, validateStageFailure } from "./validation.js";
import type {
  EvolutionApprovalOptions, EvolutionAttempt, EvolutionCampaign, EvolutionCampaignSpec,
  EvolutionControlOptions, EvolutionFeedback, EvolutionOperation, EvolutionPorts,
  EvolutionPublicationReceipt, EvolutionStage, EvolutionStageContext, EvolutionStageReceipt,
  EvolutionState, EvolutionStore, EvolutionUsage, EvolutionVerdict, EvolutionStageFailure,
} from "./types.js";

interface ActiveWork {
  readonly abort: AbortController; readonly id: string; readonly tasks: Set<Promise<unknown>>;
  readonly contexts: Map<string, EvolutionStageContext>;
  promise: Promise<EvolutionCampaign>; context?: EvolutionStageContext; fenced: boolean;
  accountedAt: number;
}
const zeroUsage = (): EvolutionUsage => ({ modelCalls: 0, tokens: 0, costByCurrency: {}, complete: true });
const ordinaryStages: readonly EvolutionStage[] = ["evidence", "generate", "candidate", "evaluate", "feedback"];
const terminal = new Set<EvolutionState>(["completed", "cancelled", "failed"]);

/** Durable stage intents precede external calls; an uncertain intent is reconciled, never replayed. */
export class EvolutionController {
  private readonly active = new Map<string, ActiveWork>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly drains = new Set<Promise<unknown>>();
  private readonly drainingIds = new Map<string, Promise<unknown>>();
  private readonly ownedIds = new Set<string>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private suspended = false;
  private readonly now: () => number;
  constructor(private readonly options: { readonly store: EvolutionStore; readonly ports: EvolutionPorts; readonly now?: () => number }) {
    this.now = options.now ?? Date.now;
  }
  get activeCount(): number { return this.active.size; }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private assertOpen(): void { if (this.closed || this.suspended) fail("evolution_closed"); }
  /** Synchronous retirement fence. Storage remains leased until close() after accepted work drains. */
  suspend(): void { this.suspended = true; this.abortActive(); }
  abortActive(): void { for (const work of this.active.values()) { work.fenced = true; work.abort.abort(new EvolutionError("evolution_owner_retiring")); } }
  async get(id: string): Promise<EvolutionCampaign> {
    const value = await this.options.store.read(text(id)); if (!value) fail("evolution_not_found"); return value;
  }
  list(): Promise<readonly EvolutionCampaign[]> { this.assertOpen(); return this.options.store.list(); }
  async create(value: EvolutionCampaignSpec | unknown, requestId: string): Promise<EvolutionCampaign> {
    this.assertOpen(); const spec = validateSpec(value), key = text(requestId), id = `evolution-${digest(key)}`;
    return this.lock(id, async () => {
      const current = await this.options.store.read(id);
      this.assertOpen();
      if (current) { if (current.specDigest !== digest(spec)) fail("evolution_request_conflict"); return current; }
      const at = this.timestamp();
      const campaign: EvolutionCampaign = { schemaVersion: 1, id, requestId: key, specDigest: digest(spec), spec,
        revision: 1, state: "waiting-input", createdAt: at, updatedAt: at, elapsedMs: 0,
        usage: zeroUsage(), attempts: [], nonImprovingRounds: 0 };
      try { return await this.options.store.create(campaign); }
      catch (error) {
        if (!(error instanceof EvolutionError) || error.code !== "evolution_conflict") throw error;
        const found = await this.get(id); if (found.specDigest !== campaign.specDigest) fail("evolution_request_conflict"); return found;
      }
    });
  }
  async run(id: string, options: EvolutionControlOptions = {}): Promise<EvolutionCampaign> {
    this.assertOpen(); let result!: Promise<EvolutionCampaign>;
    await this.lock(id, async () => {
      const current = await this.get(id); this.expected(current, options.expectedRevision);
      this.assertOpen();
      const active = this.active.get(id); if (active) { result = active.promise; return; }
      if (this.drainingIds.has(id)) fail("evolution_draining");
      if (terminal.has(current.state) || ["awaiting-review", "awaiting-external-validation", "paused", "reconciliation-required"].includes(current.state)) fail("evolution_run_state");
      if (current.state === "running" || pending(current)) fail("evolution_recovery_required");
      if (options.signal?.aborted) throw options.signal.reason;
      this.ownedIds.add(id);
      const running = await this.save(current, { state: "running" });
      if (this.closed || this.suspended) { result = Promise.resolve(await this.save(running, { state: "interrupted", stopReason: "owner-closed" })); return; }
      const work = this.newWork(id, options.signal);
      this.active.set(id, work);
      result = work.promise = Promise.resolve().then(() => this.drive(running, work)).finally(() => this.finish(work));
    });
    return result;
  }
  pause(id: string, options: EvolutionControlOptions = {}): Promise<EvolutionCampaign> { return this.stop(id, "paused", options); }
  cancel(id: string, options: EvolutionControlOptions = {}): Promise<EvolutionCampaign> { return this.stop(id, "cancelled", options); }
  async resume(id: string, options: EvolutionControlOptions = {}): Promise<EvolutionCampaign> {
    this.assertOpen();
    return this.lock(id, async () => {
      const current = await this.get(id); this.expected(current, options.expectedRevision);
      this.assertOpen();
      if (!["paused", "interrupted"].includes(current.state)) fail("evolution_resume_state");
      if (this.active.has(id) || this.drainingIds.has(id)) fail("evolution_draining");
      return this.save(current, { state: pending(current) ? "reconciliation-required" : resumableState(current) });
    });
  }
  /** Explicit human/new-evidence continuation; deferred candidates never start another round themselves. */
  async continue(id: string, input: { readonly expectedRevision: number; readonly requestId: string; readonly feedback: string; readonly traceIds?: readonly string[] }): Promise<EvolutionCampaign> {
    this.assertOpen(); text(input.requestId); text(input.feedback);
    return this.lock(id, async () => {
      const current = await this.get(id);
      this.assertOpen();
      const previous = current.inputs?.find(item => item.requestId === input.requestId);
      if (previous) {
        if (previous.feedback !== input.feedback || digest(previous.traceIds) !== digest(input.traceIds ?? [])) fail("evolution_request_conflict");
        return current;
      }
      this.expected(current, input.expectedRevision);
      if (current.state !== "awaiting-external-validation" && !(current.state === "failed" && current.attempts.at(-1)?.operations.some(item => item.status === "failed") && !pending(current))) fail("evolution_continue_state");
      if (current.attempts.length >= current.spec.maxRounds || budgetReason(current)) fail("evolution_budget_exhausted");
      const ids = input.traceIds ?? []; if (ids.length > 100 || ids.some(id => !id.trim() || id.length > 4_096)) fail("evolution_invalid_trace_ids");
      if (input.feedback.length > 12_000) fail("evolution_input_limit");
      const { error: _error, stopReason: _stop, ...clean } = current;
      return this.save(clean, { state: "waiting-input", inputs: [...(current.inputs ?? []), {
        requestId: input.requestId, feedback: input.feedback, traceIds: [...ids], createdAt: this.timestamp(),
      }] });
    });
  }
  /** Recovery only looks up an existing operation. undefined cannot authorize duplicate execution. */
  async recover(id: string, options: EvolutionControlOptions = {}): Promise<EvolutionCampaign> {
    this.assertOpen(); let result!: Promise<EvolutionCampaign>;
    await this.lock(id, async () => {
      const current = await this.get(id); this.expected(current, options.expectedRevision);
      this.assertOpen(); if (options.signal?.aborted) throw options.signal.reason;
      if (this.active.has(id) || this.drainingIds.has(id)) fail("evolution_draining");
      if (!["running", "interrupted", "reconciliation-required", "paused", "failed"].includes(current.state)) fail("evolution_recover_state");
      const operation = pending(current);
      if (!operation) { result = this.save(current, { state: resumableState(current) }); return; }
      const attempt = current.attempts.at(-1)!;
      this.ownedIds.add(id);
      const fenced = await this.save(current, { state: "reconciliation-required" });
      if (this.closed || this.suspended) { result = Promise.resolve(await this.save(fenced, { state: "interrupted", stopReason: "owner-closed" })); return; }
      const work = this.newWork(id, options.signal); this.active.set(id, work);
      const context: EvolutionStageContext = { campaign: fenced, attempt, operationId: operation.id, signal: work.abort.signal }; work.context = context; work.contexts.set(attempt.id, context);
      result = work.promise = Promise.resolve().then(async () => {
        const reconcile = this.options.ports.reconcile;
        if (!reconcile) return this.get(id);
        const receipt = await this.call(work, () => reconcile(context, operation), fenced.spec.budget.timeoutMs);
        if (receipt === undefined) return this.get(id);
        return this.lock(id, async () => {
          const latest = await this.get(id); if (!this.live(work) || latest.state !== "reconciliation-required") return latest;
          if ("kind" in receipt && receipt.kind === "stage-failure") return this.recordFailure(latest, operation, receipt);
          const updated = await this.record(latest, attempt, operation, receipt as EvolutionStageReceipt, 0);
          if (operation.stage === "publish") return updated;
          return this.save(updated, { state: "waiting-input" });
        });
      }).catch(async error => {
        return this.error(work, error, "reconciliation-required");
      }).finally(() => this.finish(work));
    });
    return result;
  }
  /** This Host-only method is never exposed as a generator/model capability. */
  async approve(id: string, input: EvolutionApprovalOptions): Promise<EvolutionCampaign> {
    this.assertOpen(); text(input.requestId); let result!: Promise<EvolutionCampaign>;
    await this.lock(id, async () => {
      const current = await this.get(id);
      this.assertOpen(); if (input.signal?.aborted) throw input.signal.reason;
      if (current.publication?.approvedDigest === input.approvedDigest) { result = Promise.resolve(current); return; }
      this.expected(current, input.expectedRevision);
      if (current.state !== "awaiting-review" || !current.review || current.review.digest !== input.approvedDigest) fail("evolution_approval_digest_mismatch");
      if (!this.options.ports.publish) fail("evolution_publisher_unavailable");
      if (this.active.has(id) || this.drainingIds.has(id)) fail("evolution_draining");
      const attempt = current.attempts.at(-1); if (!attempt) fail("evolution_attempt_missing");
      const operation: EvolutionOperation = { id: `${attempt.id}-publish`, stage: "publish", status: "pending", startedAt: this.timestamp() };
      this.ownedIds.add(id);
      const attempts = replaceAttempt(current, { ...attempt, operations: [...attempt.operations, operation] });
      const started = await this.save(current, { state: "running", attempts, usage: summarizeUsage(attempts) });
      if (this.closed || this.suspended) { result = Promise.resolve(await this.save(started, { state: "interrupted", stopReason: "owner-closed" })); return; }
      const work = this.newWork(id, input.signal); this.active.set(id, work);
      const context: EvolutionStageContext = { campaign: started, attempt, operationId: operation.id, signal: work.abort.signal }; work.context = context; work.contexts.set(attempt.id, context);
      result = work.promise = Promise.resolve().then(async () => {
        const receipt = await this.call(work, () => this.options.ports.publish!(context, input.approvedDigest), current.spec.budget.timeoutMs);
        return this.lock(id, async () => {
          const latest = await this.get(id); if (!this.live(work) || latest.state !== "running") return latest;
          return this.record(latest, attempt, operation, receipt, 0);
        });
      }).catch(error => this.error(work, error, "reconciliation-required")).finally(() => this.finish(work));
    });
    return result;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.suspended = true;
    return this.closing = this.closeOwned();
  }
  private async closeOwned(): Promise<void> {
    const works = [...this.active.values()];
    for (const work of works) { work.fenced = true; work.abort.abort(new EvolutionError("evolution_closed")); }
    for (const id of this.ownedIds) {
      await this.lock(id, async () => {
        const current = await this.get(id);
        if (["running", "reconciliation-required"].includes(current.state)) await this.save(current, { state: "interrupted", usage: summarizeUsage(current.attempts), stopReason: "owner-closed" });
      });
    }
    await Promise.allSettled(works.map(work => work.promise));
    await Promise.allSettled([...this.drains]);
    await this.options.store.close?.();
  }
  private async drive(initial: EvolutionCampaign, work: ActiveWork): Promise<EvolutionCampaign> {
    let campaign = initial;
    try {
      while (this.live(work)) {
        campaign = await this.get(work.id);
        let attempt = campaign.attempts.at(-1);
        if (!attempt || attempt.endedAt) {
          const reason = budgetReason(campaign); if (reason) return this.transition(work, "completed", reason);
          if (campaign.attempts.length >= campaign.spec.maxRounds) return this.transition(work, "completed", "max-rounds");
          const round = campaign.attempts.length + 1;
          attempt = { id: `${campaign.id}-round-${round}`, round, startedAt: this.timestamp(), operations: [], ...(attempt ? { parentAttemptId: attempt.id } : {}) };
          campaign = await this.mutate(work, current => ({ attempts: [...current.attempts, attempt!] }));
        }
        const stages = ordinaryStages.filter(stage => stage !== "evaluate" || (campaign.spec.evaluationMode === "external" && !!this.options.ports.evaluate));
        const next = stages.find(stage => !attempt!.operations.some(operation => operation.stage === stage && operation.status === "completed"));
        const reason = budgetReason(campaign, next === undefined || next === "candidate" || next === "feedback");
        if (reason) return this.transition(work, "completed", reason);
        if (!next) {
          if (campaign.spec.evaluationMode !== "external") return this.transition(work, "awaiting-external-validation", "technical-candidate-ready");
          if (!attempt.verdict) return this.transition(work, "awaiting-external-validation", "external-evaluator-unavailable");
          if (attempt.verdict?.decision === "accepted") return this.transition(work, "awaiting-review", "host-review-ready");
          const improving = attempt.verdict && attempt.verdict.candidateScore > (campaign.bestScore ?? attempt.verdict.baselineScore);
          const nonImprovingRounds = improving ? 0 : campaign.nonImprovingRounds + 1;
          campaign = await this.mutate(work, current => ({ nonImprovingRounds,
            ...(attempt!.verdict ? { bestScore: Math.max(current.bestScore ?? attempt!.verdict.baselineScore, attempt!.verdict.candidateScore) } : {}),
            attempts: replaceAttempt(current, { ...attempt!, endedAt: this.timestamp() }),
          }));
          if (nonImprovingRounds >= campaign.spec.patience) return this.transition(work, "completed", "patience");
          continue;
        }
        if (next === "generate" && !attempt.evidence?.tickets.length) return this.transition(work, "waiting-input", "no-actionable-evidence");
        if (attempt.operations.some(operation => operation.status === "pending")) return this.transition(work, "reconciliation-required", "pending-operation");
        if (next === "evaluate" && !this.options.ports.evaluate) return this.transition(work, "awaiting-external-validation", "external-evaluator-unavailable");
        const operation: EvolutionOperation = { id: `${attempt.id}-${next}`, stage: next, status: "pending", startedAt: this.timestamp() };
        campaign = await this.mutate(work, current => {
          const attempts = replaceAttempt(current, { ...attempt!, operations: [...attempt!.operations, operation] });
          return { attempts, usage: summarizeUsage(attempts) };
        });
        const context: EvolutionStageContext = { campaign, attempt: campaign.attempts.at(-1)!, operationId: operation.id, signal: work.abort.signal }; work.context = context; work.contexts.set(attempt.id, context);
        const began = this.now(), receipt = await this.call(work, () => this.invoke(next, context), Math.max(1, campaign.spec.budget.timeoutMs - campaign.elapsedMs));
        campaign = await this.lock(work.id, async () => {
          const latest = await this.get(work.id); if (!this.live(work) || latest.state !== "running") return latest;
          const recorded = await this.record(latest, latest.attempts.at(-1)!, operation, receipt, Math.max(0, this.now() - began));
          work.accountedAt = this.now(); return recorded;
        });
        if (campaign.state !== "running") return campaign;
      }
      return this.get(work.id);
    } catch (error) {
      if (error instanceof EvolutionStageError) return this.lock(work.id, async () => {
        const current = await this.get(work.id), operation = pending(current);
        if (!this.live(work) || current.state !== "running" || !operation) return current;
        return this.recordFailure(current, operation, error.failure, Math.max(0, this.now() - work.accountedAt));
      });
      return this.error(work, error, pending(await this.get(work.id)) ? "reconciliation-required" : "failed");
    }
  }
  private invoke(stage: EvolutionStage, context: EvolutionStageContext): Promise<EvolutionStageReceipt> {
    const ports = this.options.ports;
    if (stage === "evidence") return ports.evidence(context);
    if (stage === "generate") return ports.generate(context);
    if (stage === "candidate") return ports.candidate(context);
    if (stage === "evaluate" && ports.evaluate) return ports.evaluate(context);
    if (stage === "feedback") return ports.feedback(context);
    fail("evolution_stage_unavailable");
  }
  private async record(current: EvolutionCampaign, attempt: EvolutionAttempt, operation: EvolutionOperation, raw: EvolutionStageReceipt, elapsedMs: number): Promise<EvolutionCampaign> {
    if (!current.attempts.at(-1)?.operations.some(item => item.id === operation.id && item.status === "pending")) fail("evolution_operation_fenced");
    attempt = current.attempts.at(-1)!;
    const receipt = validateReceipt(operation.stage, raw, current, attempt);
    const updated: EvolutionAttempt = { ...attempt, operations: attempt.operations.map(item => item.id === operation.id ? { ...item, status: "completed", receipt, endedAt: this.timestamp() } : item),
      ...(operation.stage === "evidence" ? { evidence: receipt as NonNullable<EvolutionAttempt["evidence"]> } : {}),
      ...(operation.stage === "generate" ? { proposal: receipt as NonNullable<EvolutionAttempt["proposal"]> } : {}),
      ...(operation.stage === "candidate" ? { candidate: receipt as NonNullable<EvolutionAttempt["candidate"]> } : {}),
      ...(operation.stage === "evaluate" ? { verdict: receipt as EvolutionVerdict } : {}),
      ...(operation.stage === "feedback" ? { feedback: receipt as EvolutionFeedback } : {}),
    };
    if (operation.stage === "generate") {
      const source = updated.proposal!.source;
      const contentDigest = digest({ entry: source.entry, files: source.files, tests: source.tests, manifest: source.manifest, config: source.config });
      const duplicate = current.attempts.slice(0, -1).find(item => item.contentDigest === contentDigest);
      Object.assign(updated, { contentDigest, ...(duplicate ? { duplicateOf: duplicate.id, endedAt: this.timestamp() } : {}) });
    }
    const publication = operation.stage === "publish" ? receipt as EvolutionPublicationReceipt : undefined;
    const attempts = replaceAttempt(current, updated);
    return this.save(current, { attempts, elapsedMs: current.elapsedMs + elapsedMs,
      usage: summarizeUsage(attempts),
      ...(updated.duplicateOf ? { state: "completed", stopReason: "duplicate-candidate" } : {}),
      ...(operation.stage === "evaluate" && (receipt as EvolutionVerdict).review ? { review: (receipt as EvolutionVerdict).review! } : {}),
      ...(publication ? { publication, state: publication.status === "active" ? "completed" : publication.status === "rejected" ? "failed" : "reconciliation-required" } : {}),
    });
  }
  private recordFailure(current: EvolutionCampaign, operation: EvolutionOperation, raw: EvolutionStageFailure, elapsedMs = 0): Promise<EvolutionCampaign> {
    const failure = validateStageFailure(raw, operation.stage), attempt = current.attempts.at(-1)!;
    if (!attempt.operations.some(item => item.id === operation.id && item.status === "pending")) fail("evolution_operation_fenced");
    const attempts = replaceAttempt(current, { ...attempt, endedAt: this.timestamp(), operations: attempt.operations.map(item => item.id === operation.id ? { ...item, status: "failed", failure, endedAt: this.timestamp() } : item) });
    return this.save(current, { state: "failed", error: failure.reason, stopReason: "stage-failed", attempts, usage: summarizeUsage(attempts), elapsedMs: current.elapsedMs + elapsedMs });
  }
  private async stop(id: string, state: "paused" | "cancelled", options: EvolutionControlOptions): Promise<EvolutionCampaign> {
    this.assertOpen();
    return this.lock(id, async () => {
      const current = await this.get(id); this.expected(current, options.expectedRevision);
      this.assertOpen();
      if (terminal.has(current.state)) { if (current.state === state) return current; fail("evolution_terminal"); }
      const work = this.active.get(id); if (work) { work.fenced = true; work.abort.abort(new EvolutionError(`evolution_${state}`)); }
      return this.save(current, { state, usage: summarizeUsage(current.attempts), elapsedMs: current.elapsedMs + (work ? Math.max(0, this.now() - work.accountedAt) : 0) });
    });
  }
  private async transition(work: ActiveWork, state: EvolutionState, stopReason: string): Promise<EvolutionCampaign> {
    return this.mutate(work, current => {
      const attempt = current.attempts.at(-1), end = ["completed", "awaiting-review", "awaiting-external-validation"].includes(state);
      return { state, stopReason, ...(end && attempt ? { attempts: replaceAttempt(current, { ...attempt, endedAt: this.timestamp() }) } : {}) };
    });
  }
  private async error(work: ActiveWork, error: unknown, state: EvolutionState): Promise<EvolutionCampaign> {
    return this.lock(work.id, async () => {
      const current = await this.get(work.id);
      if (!this.live(work) || !["running", "reconciliation-required"].includes(current.state)) return current;
      return this.save(current, { state, elapsedMs: current.elapsedMs + Math.max(0, this.now() - work.accountedAt), error: String(error instanceof Error ? error.message : error).slice(0, 4_096) });
    });
  }
  private newWork(id: string, signal?: AbortSignal): ActiveWork {
    const abort = new AbortController();
    const work: ActiveWork = { id, abort, tasks: new Set(), contexts: new Map(), fenced: false, accountedAt: this.now(), promise: undefined as never }; this.ownedIds.add(id);
    if (signal) {
      const cancel = () => abort.abort(signal.reason); signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      void Promise.resolve().then(() => work.promise).finally(() => signal.removeEventListener("abort", cancel)).catch(() => {});
    }
    return work;
  }
  private live(work: ActiveWork): boolean { return !work.fenced && this.active.get(work.id) === work; }
  private async call<T>(work: ActiveWork, invoke: () => Promise<T>, timeoutMs: number): Promise<T> {
    work.abort.signal.throwIfAborted();
    const task = Promise.resolve().then(invoke); work.tasks.add(task);
    void task.finally(() => work.tasks.delete(task)).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(work.abort.signal.reason ?? new EvolutionError("evolution_aborted"));
      work.abort.signal.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => work.abort.abort(new EvolutionError("evolution_timeout")), timeoutMs);
      if (work.abort.signal.aborted) aborted();
    });
    try { return await Promise.race([task, interrupted]); }
    finally { if (timer) clearTimeout(timer); if (aborted) work.abort.signal.removeEventListener("abort", aborted); }
  }
  private finish(work: ActiveWork): void {
    if (this.active.get(work.id) === work) this.active.delete(work.id);
    {
      // An uncooperative late call is fenced immediately, but its owned files are removed only after it drains.
      const drain = Promise.allSettled([...work.tasks]).then(async () => {
        for (const context of work.contexts.values()) await this.options.ports.cleanup?.(context);
      });
      this.drains.add(drain); this.drainingIds.set(work.id, drain);
      void drain.finally(() => { this.drains.delete(drain); if (this.drainingIds.get(work.id) === drain) this.drainingIds.delete(work.id); }).catch(() => {});
    }
  }
  private expected(current: EvolutionCampaign, expectedRevision?: number): void { if (expectedRevision !== undefined && current.revision !== expectedRevision) fail("evolution_conflict"); }
  private async mutate(work: ActiveWork, change: (current: EvolutionCampaign) => Partial<EvolutionCampaign>): Promise<EvolutionCampaign> {
    return this.lock(work.id, async () => { const current = await this.get(work.id); if (!this.live(work) || current.state !== "running") return current; return this.save(current, change(current)); });
  }
  private save(current: EvolutionCampaign, change: Partial<EvolutionCampaign>): Promise<EvolutionCampaign> {
    return this.options.store.compareAndSwap(current.id, current.revision, { ...current, ...change, revision: current.revision + 1, updatedAt: this.timestamp() });
  }
  private lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action); this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {}); return next;
  }
}
function replaceAttempt(campaign: EvolutionCampaign, attempt: EvolutionAttempt): readonly EvolutionAttempt[] { return campaign.attempts.map(item => item.id === attempt.id ? attempt : item); }
function pending(campaign: EvolutionCampaign): EvolutionOperation | undefined { return campaign.attempts.at(-1)?.operations.find(item => item.status === "pending"); }
function resumableState(campaign: EvolutionCampaign): EvolutionState {
  const attempt = campaign.attempts.at(-1);
  if (!attempt?.endedAt) return "waiting-input";
  if (attempt.verdict?.decision === "accepted" && campaign.review) return "awaiting-review";
  if (attempt.candidate && attempt.feedback && !attempt.verdict && (campaign.inputs?.length ?? 0) < campaign.attempts.length) return "awaiting-external-validation";
  return "waiting-input";
}
function addUsage(left: EvolutionUsage, right: EvolutionUsage): EvolutionUsage {
  const costs: Record<string, number | null> = { ...left.costByCurrency };
  for (const [currency, cost] of Object.entries(right.costByCurrency)) costs[currency] = cost === null || costs[currency] === null ? null : (costs[currency] ?? 0) + cost;
  return { modelCalls: left.modelCalls + right.modelCalls, tokens: left.tokens + right.tokens, costByCurrency: costs, complete: left.complete && right.complete };
}
function summarizeUsage(attempts: readonly EvolutionAttempt[]): EvolutionUsage {
  let usage = zeroUsage();
  for (const attempt of attempts) for (const operation of attempt.operations) {
    if (operation.status === "pending") { usage = { ...usage, complete: false }; continue; }
    if (operation.receipt && "usage" in operation.receipt && operation.receipt.usage) usage = addUsage(usage, operation.receipt.usage);
    if (operation.failure) usage = addUsage(usage, operation.failure.usage);
  }
  return usage;
}
function budgetReason(campaign: EvolutionCampaign, finishLocal = false): string | undefined {
  const { usage, spec } = campaign;
  if (!usage.complete) return "usage-incomplete";
  if (usage.modelCalls > spec.budget.modelCalls || usage.tokens > spec.budget.tokens || (!finishLocal && (usage.modelCalls === spec.budget.modelCalls || usage.tokens === spec.budget.tokens)) || campaign.elapsedMs >= spec.budget.timeoutMs) return "budget-exhausted";
  if (usage.modelCalls > 0 && Object.keys(spec.budget.costByCurrency).length > 0 && !Object.keys(usage.costByCurrency).length) return "price-unknown";
  for (const [currency, maximum] of Object.entries(spec.budget.costByCurrency)) {
    const cost = usage.costByCurrency[currency];
    if (cost === null) return "price-unknown";
    if (cost !== undefined && (cost > maximum || (!finishLocal && cost === maximum))) return "budget-exhausted";
  }
  return undefined;
}
