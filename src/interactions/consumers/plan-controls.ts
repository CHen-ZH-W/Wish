import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

/** Optional Plan policy projection, not a dependency of interaction state. */
export default { name: "interaction-plan-controls", inject: ["plan", "interactions"], apply(ctx: Context) {
  let remove: (() => void) | undefined;
  new PluginWorkOwner(ctx, { code: "interaction_plan_controls", codeReload: true, close: () => remove?.() });
  remove = ctx.plan.registerModeControl({ toolName: "ask_user", resourcePrefix: "interaction.ask:" });
} };
