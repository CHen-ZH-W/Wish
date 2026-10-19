import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

/** Entry guidance is visible before Plan mode is active. */
export default {
  name: "plan-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "plan_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "plan.entry",
      order: 500,
      requiredTools: ["enter_plan_mode"],
      content: [
        "Use enter_plan_mode when the user asks for a plan or wants a human-reviewed plan before implementation.",
        "Do not enter Plan mode solely because the task has multiple steps. Plan review is a human decision; submitting a Plan does not authorize execution.",
        "For a read-only analysis request, inspect the evidence and deliver the findings directly in your response. A Plan review is not required to answer the user.",
      ].join("\n"),
    });
  },
};
