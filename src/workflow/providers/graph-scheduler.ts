import { Service, type Context } from "@deepseek-ai/cordis";
import { registerPluginOwner } from "../../boot/plugin-control/owner-registry.js";
import { WorkflowGraphSchedulerService } from "../service.js";
import { TaskGraphScheduler } from "../task-graph-scheduler.js";
import type {} from "./schedulers.js";

export default class WorkflowGraphScheduler extends WorkflowGraphSchedulerService {
  static readonly inject = ["workflow", "workflowScheduler", "plan", "tasks"];
  readonly graphs: TaskGraphScheduler;
  private detachProjector: (() => void) | undefined;

  constructor(ctx: Context) {
    super(ctx);
    this.graphs = new TaskGraphScheduler(ctx.plan, ctx.tasks, ctx.workflowScheduler.children, ctx.workflow.state);
    let closing: Promise<void> | undefined;
    const attach = () => {
      this.detachProjector ??= ctx.workflowScheduler.children.attachProjector(run => this.graphs.project(run));
    };
    const detach = () => { this.detachProjector?.(); this.detachProjector = undefined; };
    const close = () => closing ??= (detach(), this.graphs.close());
    attach();
    ctx.effect(() => close, "workflow.graph-scheduler.close");
    registerPluginOwner(ctx, {
      replacement: "drain",
      status: () => {
        const snapshot = this.graphs.lifecycleSnapshot();
        const busy = snapshot.activeStarts > 0 || snapshot.activeProjections > 0;
        return { disposition: closing ? "blocked" : busy ? "drain" : "direct", code: closing ? "workflow_graph_closing" : busy ? "workflow_graph_busy" : "workflow_graph_idle",
          counts: { active_graph_starts: snapshot.activeStarts, active_graph_projections: snapshot.activeProjections } };
      },
      prepare: change => {
        const resumeGraphs = this.graphs.suspendAdmission();
        detach();
        return {
          drained: this.graphs.drain(),
          deactivate: change.kind === "replace" ? async () => {} : close,
          release: () => { if (!closing) { attach(); resumeGraphs(); } },
        };
      },
    });
  }

  async [Service.init]() {
    await this.ctx.workflowScheduler.children.reconcile();
  }
}
