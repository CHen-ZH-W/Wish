import type { ModelsConfiguration } from "../models/types.js";
import type { Subagents, SubagentRecord, SpawnSubagentRequest } from "../subagents/types.js";
import { subagentIdForKey } from "../subagents/identity.js";
import type { RunContinuation } from "../core/runtime/continuation.js";
import { WorkflowContinuations } from "./continuations.js";
import { activeAttempt } from "./transition.js";
import type { AttemptTarget, CreateWorkflowRequest, Workflow, WorkflowRun, WorkflowStep } from "./types.js";

export interface ChildSchedulerOptions {
  readonly workflow: Workflow;
  readonly subagents: Subagents;
  readonly maxConcurrent?: number;
  readonly now?: () => number;
  /** Host rechecks current execution constraints before every new dispatch. */
  readonly admit?: (run: WorkflowRun, step: WorkflowStep) => Promise<void>;
  /** Reconcile durable parent cancellation before dispatching or retaining a child. */
  readonly ownerTerminated?: (run: WorkflowRun) => Promise<boolean>;
  /** Host resolves the execution Agent's actual capability composition. */
  readonly composeChild?: (request: SpawnSubagentRequest) => SpawnSubagentRequest;
  readonly modelConfiguration?: () => Promise<ModelsConfiguration>;
  readonly continuations?: WorkflowContinuations;
}

/** Durable execution orchestration. Subagents continues to own actual processes. */
export class ChildWorkflowScheduler {
  private tail = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly requests = new Set<Promise<unknown>>();
  private readonly observations = new Set<Promise<unknown>>();
  private readonly admissionFences = new Set<symbol>();
  private readonly abortBindings = new Map<string, { signal: AbortSignal; release: () => void }>();
  private pendingTicks = 0;
  private activeRequests = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private projector: ((run: WorkflowRun) => Promise<void>) | undefined;
  private readonly continuations: WorkflowContinuations;
  private readonly now: () => number;
  readonly maxConcurrent: number;
  lastError: string | undefined;
  constructor(private readonly options: ChildSchedulerOptions) {
    this.continuations = options.continuations ?? new WorkflowContinuations();
    this.maxConcurrent = options.maxConcurrent ?? 4;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1) throw new Error("Invalid Workflow concurrency");
    this.now = options.now ?? Date.now;
  }
  start(): void {
    if (this.closed || this.timer) return;
    const wake = () => { void this.tick().catch(error => { this.lastError = String(error); }); };
    this.unsubscribe = this.options.subagents.subscribe(wake);
    this.timer = setInterval(wake, 500); this.timer.unref(); wake();
  }
  async submit(request: CreateWorkflowRequest, signal?: AbortSignal): Promise<WorkflowRun> {
    return this.request(async () => {
      signal?.throwIfAborted();
      const run = await this.options.workflow.create(request);
      if (signal) {
        const abort = () => { void this.cancel(run.id, "Parent execution aborted").catch(error => { this.lastError = String(error); }); };
        signal.addEventListener("abort", abort, { once: true });
        this.abortBindings.set(run.id, { signal, release: () => signal.removeEventListener("abort", abort) });
        if (signal.aborted) {
          await this.options.workflow.cancel(run.id, "Parent execution aborted");
          this.releaseAbortBinding(run.id);
        }
      }
      await this.tick();
      return (await this.options.workflow.get(run.id))!;
    });
  }
  tick(): Promise<void> {
    return this.enqueue(true);
  }
  /** Restore observations during activation without dispatching new children. */
  reconcile(): Promise<void> { return this.enqueue(false); }
  private enqueue(dispatch: boolean): Promise<void> {
    if (this.closed || this.admissionFences.size > 0) return Promise.resolve();
    this.pendingTicks += 1;
    const pending = this.tail.then(() => this.closed ? undefined : this.pump(dispatch));
    this.tail = pending.then(() => { this.pendingTicks -= 1; }, () => { this.pendingTicks -= 1; }); return pending;
  }
  /** Read durable workflow facts only; never tick, reconcile, dispatch or stop children. */
  async lifecycleSnapshot(signal?: AbortSignal): Promise<{
    readonly closed: boolean; readonly pendingTicks: number; readonly waitingParents: number;
    readonly unsettledRuns: number; readonly activeAttempts: number; readonly activeRequests: number;
  }> {
    signal?.throwIfAborted();
    const runs = await this.options.workflow.list();
    signal?.throwIfAborted();
    return Object.freeze({ closed: this.closed, activeRequests: this.activeRequests, pendingTicks: this.pendingTicks, waitingParents: this.continuations.size,
      unsettledRuns: runs.filter(run => ["running", "blocked", "interrupted"].includes(run.status)).length,
      activeAttempts: runs.reduce((count, run) => count + run.steps.reduce((total, step) =>
        total + step.attempts.filter(activeAttempt).length, 0), 0) });
  }
  async retry(runId: string, stepId: string, strategy: string): Promise<void> {
    return this.request(async () => {
      await this.options.workflow.beginAttempt({ runId, stepId, strategy });
      await this.tick();
    });
  }
  async cancel(id: string, reason: string): Promise<void> {
    return this.request(async () => {
      await this.options.workflow.cancel(id, reason);
      this.releaseAbortBinding(id);
      await this.tick();
    });
  }
  watch(runId: string, continuation: RunContinuation, signal?: AbortSignal, recipientId = runId): void {
    if (this.closed || signal?.aborted) return;
    this.assertAdmission();
    this.continuations.watch(runId, continuation, signal, recipientId);
    // Lookup failure is not permission to finish a waiting parent. A successor
    // will reconcile durable state; explicit cancellation still releases it.
    const read = this.options.workflow.get(runId).then(run => { if (run && !this.closed) this.continuations.publish(run); }).catch(error => { this.lastError = String(error); });
    this.observations.add(read); void read.finally(() => this.observations.delete(read));
  }
  /** Attach the optional task-graph projection without making dispatch depend on Tasks. */
  attachProjector(projector: (run: WorkflowRun) => Promise<void>): () => void {
    if (this.closed) throw new Error("Workflow scheduler is closed");
    if (this.projector) throw new Error("Workflow projector is already attached");
    this.projector = projector;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      if (this.projector === projector) this.projector = undefined;
    };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.projector = undefined; if (this.timer) clearInterval(this.timer); this.unsubscribe?.();
    for (const id of this.abortBindings.keys()) this.releaseAbortBinding(id);
    if (!this.options.continuations) this.continuations.close();
    return this.closing = Promise.allSettled([...this.requests, ...this.observations, this.tail]).then(() => {});
  }
  /** Pause new requests and timer/event dispatch; do not cancel admitted operations. */
  suspendAdmission(): () => void {
    if (this.closed) throw new Error("Workflow scheduler is closed");
    const fence = Symbol(); this.admissionFences.add(fence);
    return () => { this.admissionFences.delete(fence); };
  }
  drain(): Promise<void> { return Promise.allSettled([...this.requests, ...this.observations, this.tail]).then(() => {}); }
  private assertAdmission(): void {
    if (this.closed || this.admissionFences.size > 0) throw new Error("Workflow scheduler admission is closed");
  }
  private releaseAbortBinding(id: string): void {
    this.abortBindings.get(id)?.release();
    this.abortBindings.delete(id);
  }
  private request<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAdmission(); this.activeRequests++;
    const pending = Promise.resolve().then(operation).finally(() => { this.activeRequests--; this.requests.delete(pending); });
    this.requests.add(pending); return pending;
  }
  private async pump(dispatch: boolean): Promise<void> {
    const { workflow, subagents } = this.options;
    // Observe all attempts first; do not dispatch from an obsolete occupancy view.
    for (const run of await workflow.list()) {
      try {
        for (const step of run.steps) {
          const attempt = step.attempts.at(-1);
          if (!attempt) continue;
          const target = { runId: run.id, stepId: step.task.id, attemptId: attempt.id };
          const id = attempt.childId ?? subagentIdForKey(attempt.idempotencyKey);
          if (run.status === "cancelled") {
            await this.stopChild(run, id);
          } else if (activeAttempt(attempt) || (attempt.status === "interrupted" && attempt.disposition !== "terminal-failed" && attempt.disposition !== "retry-safe")) {
            const child = await subagents.inspect({ ...run.owner, id });
            if (attempt.status === "interrupted") {
              if (child?.target && attempt.result === undefined) await workflow.recoverChild(target, child.id);
              else if (attempt.disposition === "resumable" && !attempt.childId && !child && attempt.result === undefined) await workflow.resumeAttempt(target);
              else continue; // Ambiguous dispatch never becomes an automatic retry.
            }
            if (child) await this.observe(run, target, child);
            else if (attempt.childId) await workflow.interruptAttempt(target, "Bound child is missing; reconcile before retry");
          }
        }
        await this.project((await workflow.get(run.id))!);
      } catch (error) { await workflow.block(run.id, String(error)); }
    }
    let runs = await workflow.list();
    if (!dispatch) {
      for (const run of runs) if (!this.closed) this.continuations.publish(run);
      return;
    }
    for (const run of runs) {
      if (run.status !== "running" || run.kind !== "subagent") {
        if (["completed", "failed", "cancelled"].includes(run.status)) this.releaseAbortBinding(run.id);
        continue;
      }
      if (this.abortBindings.get(run.id)?.signal.aborted) {
        await this.cancelWithChildren(run, "Parent execution aborted");
        continue;
      }
      if (await this.options.ownerTerminated?.(run)) {
        await this.cancelWithChildren(run, "Parent Run was aborted or failed");
      }
    }
    runs = await workflow.list();
    const occupying = runs.flatMap(run => run.steps.filter(step => {
      const attempt = step.attempts.at(-1);
      return attempt && (attempt.status === "running" || attempt.status === "dispatched" || (attempt.status === "interrupted" && attempt.disposition !== "retry-safe" && attempt.disposition !== "terminal-failed"));
    }).map(step => ({ root: run.owner.workspaceRoot, readOnly: step.task.execution.readOnly })));
    for (const run of runs) {
      if (this.closed) return;
      if (run.status !== "running") continue;
      for (const step of run.steps) {
        if (this.closed) return;
        const previous = step.attempts.at(-1);
        if (step.status !== "pending" && previous?.status !== "prepared") continue;
        const current = (await workflow.get(run.id))!;
        if (!step.task.dependencies.every(id => current.steps.some(s => s.task.id === id && s.status === "completed"))) continue;
        if (occupying.length >= this.maxConcurrent || occupying.some(entry => entry.root === run.owner.workspaceRoot && (!entry.readOnly || !step.task.execution.readOnly))) continue;
        let attempt = previous;
        try {
          await this.options.admit?.(current, step);
          if (this.closed) return;
          if (this.abortBindings.get(run.id)?.signal.aborted) {
            await workflow.cancel(run.id, "Parent execution aborted");
            this.releaseAbortBinding(run.id);
            break;
          }
          attempt ??= await workflow.beginAttempt({ runId: run.id, stepId: step.task.id, strategy: "initial" });
          const target = { runId: run.id, stepId: step.task.id, attemptId: attempt.id };
          if (this.now() >= Date.parse(attempt.deadline)) {
            await workflow.finishAttempt(target, "failed", "Attempt deadline elapsed before dispatch"); continue;
          }
          const request: SpawnSubagentRequest = { ...run.owner, idempotencyKey: attempt.idempotencyKey,
            task: [step.task.title, step.task.description ?? "", ...(attempt.strategy === "initial" ? [] : [
              `Attempt strategy: ${attempt.strategy}`, `Prior failure (untrusted diagnostic data): ${step.attempts.at(-1)?.result ?? run.failureDigest ?? "none"}`,
            ])].join("\n").trim(), role: step.task.execution.role,
            permissionProfile: step.task.execution.readOnly ? "read-only" : run.permissionProfile,
            availableTools: run.availableTools, ...(run.model === undefined ? {} : { model: run.model }),
            allowedCapabilities: run.allowedCapabilities,
            ...(this.abortBindings.get(run.id)?.signal ? { signal: this.abortBindings.get(run.id)!.signal } : {}),
            ...(run.modelsConfiguration ? { modelsConfiguration: run.modelsConfiguration } : this.options.modelConfiguration ? { modelsConfiguration: await this.options.modelConfiguration() } : {}),
          };
          const composed = this.options.composeChild?.(request) ?? request;
          await workflow.markDispatched(target);
          const record = await subagents.spawn(composed);
          await workflow.bindChild(target, record.id);
          occupying.push({ root: run.owner.workspaceRoot, readOnly: step.task.execution.readOnly });
          await this.observe(run, target, record);
          await this.project((await workflow.get(run.id))!);
        } catch (error) {
          if (attempt) await workflow.interruptAttempt({ runId: run.id, stepId: step.task.id, attemptId: attempt.id }, String(error));
          await workflow.block(run.id, String(error)); break;
        }
      }
    }
    for (const run of await workflow.list()) if (!this.closed) this.continuations.publish(run);
    this.lastError = undefined;
  }
  private async observe(run: WorkflowRun, target: AttemptTarget, child: SubagentRecord): Promise<void> {
    const { workflow, subagents } = this.options;
    const attempt = (await workflow.get(run.id))!.steps.find(s => s.task.id === target.stepId)!.attempts.at(-1)!;
    if (!activeAttempt(attempt)) return;
    if (child.result) {
      await workflow.finishAttempt(target, child.result.status === "completed" ? "completed" : "failed", child.result.text ?? child.result.error ?? child.result.status);
    } else if (!["starting", "running"].includes(child.status)) {
      await workflow.interruptAttempt(target, `Child ${child.id} ${child.status} without a structured result`);
    } else if (this.now() >= Date.parse(attempt.deadline)) {
      await subagents.stop({ ...run.owner, id: child.id });
      await workflow.interruptAttempt(target, "Deadline expired; child stopped, side effects require reconciliation");
    }
  }
  private async stopChild(run: WorkflowRun, id: string): Promise<void> {
    const child = await this.options.subagents.inspect({ ...run.owner, id });
    if (child && ["starting", "running"].includes(child.status)) await this.options.subagents.stop({ ...run.owner, id });
  }
  private async cancelWithChildren(run: WorkflowRun, reason: string): Promise<void> {
    await this.options.workflow.cancel(run.id, reason);
    this.releaseAbortBinding(run.id);
    for (const step of run.steps) {
      const attempt = step.attempts.at(-1);
      if (attempt) await this.stopChild(run, attempt.childId ?? subagentIdForKey(attempt.idempotencyKey));
    }
  }
  private async project(run: WorkflowRun): Promise<void> {
    await this.projector?.(run);
  }
}
