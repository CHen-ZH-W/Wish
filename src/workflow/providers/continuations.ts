import { Service, type Context } from "@deepseek-ai/cordis";
import { WorkflowContinuations } from "../continuations.js";
import type {} from "../../boot/plugin-control/lifecycle.js";

/** Stable Workflow-owned parent relationships. Not a code-reloadable owner. */
export default class WorkflowContinuationService extends Service {
  readonly state = new WorkflowContinuations();
  constructor(ctx: Context) {
    super(ctx, "workflowContinuations");
    ctx.effect(() => () => this.state.close(), "workflow.continuations.close");
    ctx.root.get("pluginLifecycle")?.register(ctx, () => ({ disposition: this.state.size ? "blocked" : "direct",
      code: this.state.size ? "workflow_waiting_parents" : "workflow_continuations_idle", counts: { waiting_parents: this.state.size } }), () => {
      const release = this.state.suspendAdmission();
      return { release, close: async () => { if (this.state.size) throw Error("Workflow still has waiting parents"); this.state.close(); } };
    });
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context { workflowContinuations: WorkflowContinuationService }
}
