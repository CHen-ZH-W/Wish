import type { Plan } from "../plan/types.js";
import type { Tasks } from "../tasks/types.js";
import type { ChildWorkflowScheduler } from "./child-scheduler.js";
import { activeAttempt } from "./transition.js";
import type { CreateWorkflowRequest, Workflow, WorkflowRun, WorkflowStep } from "./types.js";

/** Admission for an approved version. Neither Tasks nor Plan owns execution. */
export class TaskGraphScheduler {
  private activeStarts = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly starts = new Set<Promise<unknown>>();
  private readonly projections = new Set<Promise<unknown>>();
  private readonly admissionFences = new Set<symbol>();
  constructor(private readonly plan: Plan, private readonly tasks: Tasks, private readonly children: ChildWorkflowScheduler, private readonly workflow?: Workflow) {}
  lifecycleSnapshot(): { readonly activeStarts: number; readonly activeProjections: number } {
    return Object.freeze({ activeStarts: this.activeStarts, activeProjections: this.projections.size });
  }
  async start(request: Omit<CreateWorkflowRequest, "kind" | "tasks" | "graph" | "approvedPlanDigest" | "key">) {
    if (this.closed || this.admissionFences.size > 0) throw new Error("Task graph admission is closed");
    this.activeStarts += 1;
    const pending = this.startGraph(request); this.starts.add(pending);
    try { return await pending; } finally { this.activeStarts -= 1; this.starts.delete(pending); }
  }
  suspendAdmission(): () => void {
    if (this.closed) throw new Error("Task graph scheduler is closed");
    const fence = Symbol(); this.admissionFences.add(fence);
    return () => { this.admissionFences.delete(fence); };
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= Promise.allSettled([...this.starts, ...this.projections]).then(() => {});
  }
  drain(): Promise<void> { return Promise.allSettled([...this.starts, ...this.projections]).then(() => {}); }
  project(run: WorkflowRun): Promise<void> {
    if (this.closed || !run.graph) return Promise.resolve();
    const pending = this.projectRun(run).finally(() => this.projections.delete(pending));
    this.projections.add(pending);
    return pending;
  }
  private assertOpen(): void { if (this.closed) throw new Error("Task graph scheduler is closed"); }
  private async startGraph(request: Omit<CreateWorkflowRequest, "kind" | "tasks" | "graph" | "approvedPlanDigest" | "key">) {
    const sessionId = request.owner.parentSessionId;
    const plan = await this.plan.get({ sessionId });
    this.assertOpen();
    if (!plan?.document?.approvedAt || plan.active || plan.review?.status !== "approved") throw new Error("Task graph needs an explicitly approved Plan review");
    const artifact = plan.document.artifacts?.find(ref => ref.kind === "tasks" && ref.id === sessionId);
    if (!artifact) throw new Error("Approved Plan has no task graph");
    const graph = await this.tasks.get(sessionId, artifact.version);
    this.assertOpen();
    if (!graph || graph.digest !== artifact.digest) throw new Error("Approved task graph mismatch");
    const ref = { sessionId, version: graph.version, digest: graph.digest };
    const key = `task-graph/${request.owner.parentAgentId}/${sessionId}/${graph.version}/${graph.digest}`;
    const existing = (await this.workflow?.list())?.find(run => run.key === key);
    this.assertOpen();
    if (existing) {
      if (existing.owner.workspaceRoot !== request.owner.workspaceRoot) throw new Error("Task graph Workflow belongs to another workspace");
      return existing;
    }
    await this.tasks.freeze(ref, plan.document.digest);
    this.assertOpen();
    return this.children.submit({ ...request, key,
      kind: "task-graph", tasks: graph.tasks, graph: ref, approvedPlanDigest: plan.document.digest });
  }
  private async projectRun(run: WorkflowRun): Promise<void> {
    // Workflow is canonical for Attempts; Tasks is an idempotent result projection.
    const ordered: WorkflowStep[] = [];
    const visit = (step: WorkflowStep) => {
      if (ordered.includes(step)) return;
      for (const id of step.task.dependencies) visit(run.steps.find(candidate => candidate.task.id === id)!);
      ordered.push(step);
    };
    run.steps.forEach(visit);
    for (const step of ordered) for (const attempt of step.attempts) {
      const graph = (await this.tasks.get(run.graph!.sessionId, run.graph!.version))!;
      const task = graph.tasks.find(candidate => candidate.id === step.task.id)!;
      if (step.attempts.findIndex(candidate => candidate.id === task.attemptId) > attempt.ordinal - 1) continue;
      const status = activeAttempt(attempt) ? "running" : attempt.status === "interrupted" ? "blocked" : attempt.status;
      if (task.status === status && task.attemptId === attempt.id) continue;
      if (task.attemptId !== attempt.id && !["completed", "cancelled"].includes(task.status)) await this.tasks.transition(run.graph!, task.id, "running", attempt.id);
      else if (["blocked", "failed"].includes(task.status) && ["completed", "failed"].includes(status)) await this.tasks.transition(run.graph!, task.id, "running", attempt.id);
      await this.tasks.transition(run.graph!, task.id, status as "running" | "completed" | "failed" | "blocked" | "cancelled", attempt.id, attempt.result);
    }
  }
}
