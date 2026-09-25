import { Service, type Context } from "@deepseek-ai/cordis";
import { WorkflowContinuations } from "../continuations.js";
import { registerPluginOwner } from "../../boot/plugin-control/owner-registry.js";

/** Stable Workflow-owned parent relationships with generation replacement. */
export default class WorkflowContinuationService extends Service {
  readonly state = new WorkflowContinuations();
  constructor(ctx: Context) {
    super(ctx, "workflowContinuations");
    ctx.effect(() => () => this.state.close(), "workflow.continuations.close");
    registerPluginOwner(ctx, {
      replacement: "generation",
      status: () => ({ disposition: this.state.size ? "drain" : "direct",
        code: this.state.size ? "workflow_waiting_parents" : "workflow_continuations_idle", counts: { waiting_parents: this.state.size } }),
      prepare: () => {
        const release = this.state.suspendAdmission();
        return { drained: Promise.resolve(), release, deactivate: async () => { this.state.close(); } };
      },
    });
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context { workflowContinuations: WorkflowContinuationService }
}
