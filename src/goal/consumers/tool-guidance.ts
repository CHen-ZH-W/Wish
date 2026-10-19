import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

export default {
  name: "goal-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "goal_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "goal.entry",
      order: 520,
      requiredTools: ["create_goal"],
      content: [
        "Use create_goal when a direct human request calls for pursuing one objective across multiple Agent rounds. It arms continuation for that Session.",
        "Do not create a Goal merely to display a checklist or complete one bounded response. Goal completion requires the objective to be achieved.",
      ].join("\n"),
    });
  },
};
