import type { SubagentRecord, Subagents } from "../subagents/types.js";
import type { Workflow, WorkflowStatus } from "../workflow/types.js";
import type { Todo, TodoChildWorkRequest } from "./types.js";

interface Link {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly itemId: string;
  readonly childId: string;
}

/** Converts explicit Todo/child links into Host-observed progress. */
export class TodoSubagentProgress {
  private readonly links = new Map<string, Link>();
  private readonly workflowTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly todo: Todo, private readonly subagents: Subagents, private readonly workflow?: () => Workflow | undefined) {
    this.unsubscribe = subagents.subscribe(event => {
      const link = this.links.get(event.record.id);
      if (link) void this.update(link, event.record).catch(() => undefined);
    });
  }

  async validate(link: Omit<Link, "childId">): Promise<void> {
    const state = await this.todo.get(link.sessionId);
    if (!state || state.runId !== link.runId || state.userTurnId !== link.userTurnId ||
        !state.items.some(item => item.id === link.itemId)) {
      throw new Error(`Todo item ${link.itemId} is not in the current UserTurn`);
    }
  }

  async beginDispatch(link: Omit<Link, "childId">, dispatchId: string): Promise<void> {
    await this.todo.bindChild({ ...link, childId: `dispatch:${dispatchId}`, status: "running" });
  }

  async finishDispatch(link: Omit<Link, "childId">, dispatchId: string, status: "completed" | "failed"): Promise<void> {
    await this.todo.updateChild({ ...link, childId: `dispatch:${dispatchId}`, status });
  }

  async bind(link: Omit<Link, "childId">, record: SubagentRecord): Promise<void> {
    const full = Object.freeze({ ...link, childId: record.id });
    const state = await this.todo.bindChild({ ...full, status: childStatus(record) });
    if (!state) return; // The parent turn ended during launch.
    this.links.set(record.id, full);
    // The child may have completed before the subscription knew its identity.
    void this.subagents.inspect({
      id: record.id,
      parentAgentId: record.parentAgentId,
      parentSessionId: record.parentSessionId,
      parentRunId: record.parentRunId,
      workspaceRoot: record.workspaceRoot,
    }).then(latest => latest ? this.update(full, latest) : undefined).catch(() => undefined);
  }

  async bindWorkflow(link: Omit<Link, "childId">, workflowRunId: string): Promise<void> {
    const workflow = this.workflow?.();
    if (!workflow) throw new Error("Workflow progress service is unavailable");
    const run = await workflow.get(workflowRunId);
    if (!run || run.owner.parentSessionId !== link.sessionId || run.owner.parentRunId !== link.runId) {
      throw new Error("Workflow owner does not match the Todo UserTurn");
    }
    const full = Object.freeze({ ...link, childId: `workflow:${workflowRunId}` });
    const state = await this.todo.bindChild({ ...full, status: workflowStatus(run.status) });
    if (!state || isTerminalWorkflow(run.status)) return;
    if (this.workflowTimers.has(workflowRunId)) return;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const latest = await workflow.get(workflowRunId);
        if (!latest) return;
        const updated = await this.todo.updateChild({
          sessionId: full.sessionId, runId: full.runId, userTurnId: full.userTurnId,
          childId: full.childId, status: workflowStatus(latest.status),
        });
        if (!updated || isTerminalWorkflow(latest.status)) this.stopWorkflowTimer(workflowRunId);
      } catch { /* Keep the observation alive; the next tick reconciles. */ }
      finally { checking = false; }
    };
    const timer = setInterval(() => { void check(); }, 500);
    timer.unref?.();
    this.workflowTimers.set(workflowRunId, timer);
    void check();
  }

  close(): void {
    this.unsubscribe();
    this.links.clear();
    for (const timer of this.workflowTimers.values()) clearInterval(timer);
    this.workflowTimers.clear();
  }

  private stopWorkflowTimer(id: string): void {
    const timer = this.workflowTimers.get(id);
    if (timer) clearInterval(timer);
    this.workflowTimers.delete(id);
  }

  private async update(link: Link, record: SubagentRecord): Promise<void> {
    const state = await this.todo.updateChild({
      sessionId: link.sessionId, runId: link.runId,
      userTurnId: link.userTurnId, childId: link.childId,
      status: childStatus(record),
    });
    if (!state || (childStatus(record) !== "running" &&
        !(record.status === "exited" && record.result === undefined))) this.links.delete(link.childId);
  }
}

function workflowStatus(status: WorkflowStatus): TodoChildWorkRequest["status"] {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "blocked" || status === "interrupted") return "failed";
  if (status === "cancelled") return "stopped";
  return "running";
}

function isTerminalWorkflow(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function childStatus(record: SubagentRecord): TodoChildWorkRequest["status"] {
  if (record.result?.status === "completed") return "completed";
  if (record.result?.status === "failed") return "failed";
  if (record.result?.status === "aborted" || record.status === "stopped") return "stopped";
  if (record.status === "failed" || record.status === "lost" || record.status === "exited") return "failed";
  return "running";
}
