import { randomUUID } from "node:crypto";
import { normalizeTasks } from "../tasks/graph.js";
import { snapshotChildCapabilities } from "../subagents/identity.js";
import { activeAttempt, deriveRun, fingerprint, replaceStep } from "./transition.js";
import type { AttemptTarget, BeginAttemptRequest, CreateWorkflowRequest, Workflow, WorkflowAttempt, WorkflowBudget, WorkflowRun, WorkflowStore } from "./types.js";

export class WorkflowRuntime implements Workflow {
  private tail = Promise.resolve();
  private closed = false;
  private suspended = false;
  private closing: Promise<void> | undefined;
  private executionStarted = false;
  constructor(private readonly store: WorkflowStore, private readonly now: () => Date = () => new Date()) {}
  async get(id: string) { return this.serial(() => this.store.get(id)); }
  async list() { return this.serial(() => this.store.list()); }
  create(request: CreateWorkflowRequest): Promise<WorkflowRun> {
    if (!request.key.trim() || request.key.length > 4096) throw new Error("Invalid Workflow key");
    const tasks = normalizeTasks(request.tasks);
    const allowedCapabilities = snapshotChildCapabilities(request.allowedCapabilities ?? ["filesystem.read", "runtime.read"]);
    const budget: WorkflowBudget = { maxTotalAttempts: 200, maxAttemptsPerStep: 2, maxCallsPerEdge: 2, circuitThreshold: 3, ...request.budget };
    for (const value of Object.values(budget)) if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error("Invalid Workflow budget");
    return this.serial(async () => {
      const id = `wf-${fingerprint(request.key)}`;
      const current = await this.store.get(id);
      if (current) {
        if (JSON.stringify(current.owner) !== JSON.stringify(request.owner) || JSON.stringify(current.steps.map((s) => s.task)) !== JSON.stringify(tasks) ||
            current.permissionProfile !== request.permissionProfile || current.model !== request.model ||
            JSON.stringify(current.availableTools) !== JSON.stringify(request.availableTools) || current.kind !== request.kind ||
            JSON.stringify(current.graph) !== JSON.stringify(request.graph) || current.approvedPlanDigest !== request.approvedPlanDigest ||
            JSON.stringify(current.modelsConfiguration) !== JSON.stringify(request.modelsConfiguration) ||
            JSON.stringify(current.allowedCapabilities) !== JSON.stringify(allowedCapabilities) ||
            JSON.stringify(current.budget) !== JSON.stringify(budget)) throw new Error("Workflow idempotency conflict");
        return current;
      }
      const timestamp = this.timestamp();
      const run: WorkflowRun = deriveRun({ schemaVersion: 1, id, revision: 1, key: request.key, kind: request.kind,
        owner: { ...request.owner }, budget, status: "running", createdAt: timestamp, updatedAt: timestamp, circuitFailures: 0,
        allowedCapabilities,
        permissionProfile: request.permissionProfile, availableTools: [...request.availableTools],
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.modelsConfiguration === undefined ? {} : { modelsConfiguration: request.modelsConfiguration }),
        ...(request.graph === undefined ? {} : { graph: { ...request.graph } }),
        ...(request.approvedPlanDigest === undefined ? {} : { approvedPlanDigest: request.approvedPlanDigest }),
        steps: tasks.map((task) => ({ task, status: "pending", attempts: [] })),
        events: [{ sequence: 1, type: "workflow.created", at: timestamp }],
      });
      await this.store.put(run, 0); return (await this.store.get(id))!;
    });
  }
  beginAttempt(request: BeginAttemptRequest): Promise<WorkflowAttempt> {
    this.executionStarted = true;
    if (!request.strategy.trim()) throw new Error("Attempt strategy required");
    let created!: WorkflowAttempt;
    return this.change(request.runId, "attempt.prepared", request.stepId, undefined, (run) => {
      if (["completed", "cancelled", "failed"].includes(run.status)) throw new Error("Workflow is terminal");
      const step = run.steps.find((s) => s.task.id === request.stepId);
      if (!step || step.status === "completed" || step.status === "cancelled" || step.attempts.some(activeAttempt)) throw new Error("Step cannot begin another Attempt");
      const previous = step.attempts.at(-1);
      if (previous?.status === "interrupted" && previous.disposition !== "retry-safe") throw new Error(`Interrupted Attempt requires ${previous.disposition === "resumable" ? "same-Attempt resume" : "reconciliation"}`);
      if (!step.task.dependencies.every((dep) => run.steps.some((s) => s.task.id === dep && s.status === "completed"))) throw new Error("Workflow dependencies unmet");
      const used = run.steps.reduce((total, s) => total + s.attempts.length, 0);
      if (used >= run.budget.maxTotalAttempts || step.attempts.length >= run.budget.maxAttemptsPerStep) throw new Error("Workflow Attempt budget exhausted");
      const edge = request.edge ?? step.task.id;
      if (step.attempts.filter((a) => a.edge === edge).length >= run.budget.maxCallsPerEdge) throw new Error("Workflow edge budget exhausted");
      if (run.circuitFailures >= run.budget.circuitThreshold) throw new Error("Workflow circuit is open");
      if (previous?.errorFingerprint && step.attempts.some((a) => a.errorFingerprint === previous.errorFingerprint && a.strategy === request.strategy)) throw new Error("Repeated error and strategy blocked");
      const timestamp = this.timestamp();
      created = { id: randomUUID(), ordinal: step.attempts.length + 1, status: "prepared",
        idempotencyKey: `${run.id}/${step.task.id}/${step.attempts.length + 1}`, strategy: request.strategy, edge,
        recoveryPolicy: request.recoveryPolicy ?? "needs-reconciliation", startedAt: timestamp,
        deadline: new Date(this.now().getTime() + step.task.execution.timeoutMs).toISOString(),
      };
      return replaceStep(run, step.task.id, (s) => ({ ...s, status: "running", attempts: [...s.attempts, created] }));
    }).then(() => Object.freeze(created));
  }
  async markDispatched(target: AttemptTarget): Promise<void> {
    await this.attempt(target, "attempt.dispatched", (attempt) => {
      if (attempt.status !== "prepared") throw new Error("Attempt must be prepared before dispatch");
      return { ...attempt, status: "dispatched" };
    });
  }
  async bindChild(target: AttemptTarget, childId: string): Promise<void> {
    await this.attempt(target, "attempt.child-bound", (attempt) => {
      if (attempt.childId === childId) return attempt;
      if (attempt.status !== "dispatched" || attempt.childId) throw new Error("Attempt binding conflict");
      return { ...attempt, status: "running", childId };
    });
  }
  async finishAttempt(target: AttemptTarget, status: "completed" | "failed" | "cancelled", result: string): Promise<void> {
    await this.change(target.runId, `attempt.${status}`, target.stepId, target.attemptId, (run) => {
      if (run.status === "cancelled" && status !== "cancelled") throw new Error("Cancelled Workflow cannot complete");
      let failure = false;
      const next = replaceStep(run, target.stepId, (step) => {
        const last = step.attempts.at(-1);
        if (!last || last.id !== target.attemptId) throw new Error("Stale Workflow Attempt result");
        if (last.status === status && last.result === result) return step;
        if (!activeAttempt(last)) throw new Error("Terminal Attempt cannot change");
        failure = status === "failed";
        const finished: WorkflowAttempt = { ...last, status, result: result.slice(0, 100_000), endedAt: this.timestamp(),
          ...(failure ? { errorFingerprint: fingerprint(result) } : {}),
        };
        return { ...step, status, attempts: [...step.attempts.slice(0, -1), finished] };
      });
      return failure ? { ...next, circuitFailures: next.circuitFailures + 1, failureDigest: result.slice(0, 2000) } : next;
    });
  }
  async recoverChild(target: AttemptTarget, childId: string): Promise<void> {
    this.executionStarted = true;
    await this.attempt(target, "attempt.child-recovered", (attempt) => {
      if (attempt.status !== "interrupted" || (attempt.childId && attempt.childId !== childId)) throw new Error("Recovery binding conflict");
      const { disposition: _disposition, ...rest } = attempt;
      return { ...rest, childId, status: "running" };
    }, "running");
  }
  resumeAttempt(target: AttemptTarget): Promise<WorkflowAttempt> {
    this.executionStarted = true;
    return this.attempt(target, "attempt.resumed", (attempt) => {
      if (attempt.status !== "interrupted" || attempt.disposition !== "resumable") throw new Error("Attempt is not resumable");
      const { disposition: _disposition, endedAt: _endedAt, ...active } = attempt;
      return { ...active, status: attempt.childId ? "running" : "prepared" };
    }, "running");
  }
  async reconcile(target: AttemptTarget, outcome: "completed" | "not-completed" | "unknown", actor: string, evidence: string): Promise<void> {
    if (!actor.trim() || !evidence.trim()) throw new Error("Reconciliation requires actor and evidence");
    await this.attempt(target, `attempt.reconciled:${outcome}:${actor}:${fingerprint(evidence)}`, (attempt) => {
      if (attempt.status !== "interrupted" || attempt.disposition !== "needs-reconciliation") throw new Error("Attempt does not require reconciliation");
      return { ...attempt,
        status: outcome === "completed" ? "completed" : "interrupted",
        disposition: outcome === "not-completed" ? "retry-safe" : "terminal-failed",
        result: evidence.slice(0, 2000),
      };
    }, outcome === "completed" ? "completed" : "blocked");
  }
  recoverInterrupted(): Promise<readonly WorkflowRun[]> {
    return this.serial(async () => {
      if (this.executionStarted) throw new Error("Workflow recovery is startup-only");
      const recovered: WorkflowRun[] = [];
      for (const run of await this.store.list()) {
        if (["completed", "cancelled", "failed"].includes(run.status)) continue;
        let changed = false;
        const steps = run.steps.map((step) => ({ ...step, attempts: step.attempts.map((attempt) => {
          if (!activeAttempt(attempt)) return attempt;
          changed = true;
          return { ...attempt, status: "interrupted" as const,
            disposition: attempt.status === "prepared" || attempt.childId ? "resumable" as const : "needs-reconciliation" as const };
        }), status: step.attempts.some(activeAttempt) ? "interrupted" as const : step.status }));
        if (!changed) continue;
        const next = this.event(deriveRun({ ...run, steps }), "workflow.interrupted");
        await this.store.put(next, run.revision); recovered.push(next);
      }
      return recovered;
    });
  }
  async interruptAttempt(target: AttemptTarget, reason: string): Promise<void> {
    await this.attempt(target, `attempt.interrupted:${reason.slice(0, 1000)}`, (attempt) => {
      if (!activeAttempt(attempt)) return attempt;
      return { ...attempt, status: "interrupted", disposition: "needs-reconciliation", result: reason.slice(0, 2000) };
    }, "interrupted");
  }
  async block(id: string, reason: string): Promise<void> {
    await this.change(id, "workflow.blocked", undefined, undefined, (run) => {
      if (["completed", "cancelled", "failed"].includes(run.status)) return run;
      return { ...run, status: "blocked", failureDigest: reason.slice(0, 2000) };
    });
  }
  async cancel(id: string, reason: string): Promise<void> {
    await this.change(id, "workflow.cancelled", undefined, undefined, (run) => {
      if (["completed", "failed"].includes(run.status)) throw new Error("Workflow already terminal");
      return { ...run, status: "cancelled", failureDigest: reason,
        steps: run.steps.map((step) => step.status === "completed" ? step : { ...step, status: "cancelled",
          attempts: step.attempts.map((a) => activeAttempt(a) || a.status === "interrupted" ? { ...a, status: "cancelled", endedAt: this.timestamp() } : a) }),
      };
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.tail.then(() => this.store.close());
  }
  private async attempt(target: AttemptTarget, event: string, fn: (attempt: WorkflowAttempt) => WorkflowAttempt, status?: import("./types.js").WorkflowStep["status"]): Promise<WorkflowAttempt> {
    let result!: WorkflowAttempt;
    await this.change(target.runId, event, target.stepId, target.attemptId, (run) => {
      if (run.status === "cancelled") throw new Error("Workflow cancelled");
      return replaceStep(run, target.stepId, (step) => {
        const last = step.attempts.at(-1);
        if (!last || last.id !== target.attemptId) throw new Error("Stale Workflow Attempt");
        result = fn(last);
        return { ...step, ...(status === undefined ? {} : { status }), attempts: [...step.attempts.slice(0, -1), result] };
      });
    });
    return Object.freeze(result);
  }
  private change(id: string, event: string, stepId: string | undefined, attemptId: string | undefined, fn: (run: WorkflowRun) => WorkflowRun): Promise<void> {
    return this.serial(async () => {
      const run = await this.store.get(id);
      if (!run) throw new Error("Workflow not found");
      const next = fn(run);
      if (JSON.stringify(next) === JSON.stringify(run)) return;
      await this.store.put(this.event(next, event, stepId, attemptId), run.revision);
    });
  }
  private event(run: WorkflowRun, type: string, stepId?: string, attemptId?: string): WorkflowRun {
    const at = this.timestamp();
    return { ...run, revision: run.revision + 1, updatedAt: at, events: [...run.events, {
      sequence: run.events.length + 1, type, at, ...(stepId ? { stepId } : {}), ...(attemptId ? { attemptId } : {}),
    }] };
  }
  private timestamp() { return this.now().toISOString(); }
  prepareReload(): { drained: Promise<void>; release(): void } {
    if (this.closed || this.suspended) throw Error("Workflow service closed");
    this.suspended = true;
    return { drained: this.tail, release: () => { if (!this.closed) this.suspended = false; } };
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed || this.suspended) return Promise.reject(new Error("Workflow service closed"));
    const result = this.tail.then(fn); this.tail = result.then(() => {}, () => {}); return result;
  }
}
