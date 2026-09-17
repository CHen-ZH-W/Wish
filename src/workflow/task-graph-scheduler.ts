import type { Plan } from "../plan/types.js";
import type { Tasks } from "../tasks/types.js";
import type { ChildWorkflowScheduler } from "./child-scheduler.js";
import type { CreateWorkflowRequest, Workflow } from "./types.js";

/** Admission for an approved version. Neither Tasks nor Plan owns execution. */
export class TaskGraphScheduler {
  private activeStarts = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly starts = new Set<Promise<unknown>>();
  private readonly admissionFences = new Set<symbol>();
  constructor(private readonly plan: Plan, private readonly tasks: Tasks, private readonly children: ChildWorkflowScheduler, private readonly workflow?: Workflow) {}
  lifecycleSnapshot(): { readonly activeStarts: number } { return Object.freeze({ activeStarts: this.activeStarts }); }
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
    return this.closing ??= Promise.allSettled([...this.starts]).then(() => {});
  }
  drain(): Promise<void> { return Promise.allSettled([...this.starts]).then(() => {}); }
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
}
