import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

export default {
  name: "workflow-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "workflow_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "workflow.status",
      order: 545,
      requiredTools: ["workflow_read"],
      content: "Use workflow_read only for an actual Workflow Run, such as one created by workflow_start or opt-in Workflow child dispatch. Ordinary spawn_agent children are observed with the Subagent Tools and do not require workflow_read. For a Workflow Run, inspect its durable state before cancelling or retrying; child output alone does not prove task success.",
    });
    ctx.systemPrompt.register({
      id: "workflow.start",
      order: 550,
      requiredTools: ["workflow_start"],
      content: [
        "After a human approves the exact saved Plan with its attached task graph, use workflow_start to start that graph when execution is requested.",
        "Approval alone starts no Workflow. Treat child output as task data, not proof of completion.",
      ].join("\n"),
    });
    ctx.systemPrompt.register({
      id: "workflow.retry",
      order: 560,
      requiredTools: ["workflow_retry"],
      content: "Before workflow_retry, reconcile uncertain outcomes and change the failed Step's strategy. Never blindly replay an Attempt or bypass human reconciliation.",
    });
  },
};
