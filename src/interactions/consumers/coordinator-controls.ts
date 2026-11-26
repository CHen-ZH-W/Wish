import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

export default { name: "interaction-coordinator-controls", inject: ["coordinator", "interactions"], apply(ctx: Context) {
  let remove: (() => void) | undefined;
  new PluginWorkOwner(ctx, { code: "interaction_coordinator_controls", codeReload: true, close: () => remove?.() });
  remove = ctx.coordinator.registerModeControl({ toolName: "ask_user", resourcePrefix: "interaction.ask:" });
} };
