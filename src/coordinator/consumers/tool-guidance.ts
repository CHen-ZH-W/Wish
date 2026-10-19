import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

export default {
  name: "coordinator-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "coordinator_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "coordinator.entry",
      order: 530,
      requiredTools: ["enter_coordinator_mode"],
      content: [
        "Use enter_coordinator_mode when the current Run's work is chiefly delegating to and reconciling child Agents.",
        "Entering this mode restricts direct editing and shell execution. Do not enter solely to make one bounded child-Agent call.",
      ].join("\n"),
    });
  },
};
