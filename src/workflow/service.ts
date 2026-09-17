import { Service, type Context } from "@deepseek-ai/cordis";
import type { Workflow } from "./types.js";
import type { ChildWorkflowScheduler } from "./child-scheduler.js";
import type { TaskGraphScheduler } from "./task-graph-scheduler.js";

export abstract class WorkflowService extends Service {
  constructor(ctx: Context) { super(ctx, "workflow"); }
  abstract readonly state: Workflow;
}
export abstract class WorkflowSchedulerService extends Service {
  constructor(ctx: Context) { super(ctx, "workflowScheduler"); }
  abstract readonly children: ChildWorkflowScheduler;
  abstract readonly graphs: TaskGraphScheduler;
}
declare module "@deepseek-ai/cordis" {
  interface Context { workflow: WorkflowService; workflowScheduler: WorkflowSchedulerService }
}
