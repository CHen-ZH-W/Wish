import type { Context } from "@deepseek-ai/cordis";
import { registerManagedWebUiControl } from "../../apps/webui/controls.js";
import type {} from "../occupancy-service.js";

export const CONTEXT_OCCUPANCY_WEBUI_CONTROL = "context-occupancy";
export default {
  name: "context-occupancy-webui-control",
  inject: ["contextOccupancy", "webUiControls"],
  apply(ctx: Context): void {
    registerManagedWebUiControl(ctx, CONTEXT_OCCUPANCY_WEBUI_CONTROL, {
      inspectSession(_application, sessionId, signal) { return ctx.contextOccupancy.inspect(sessionId, signal); },
    });
  },
};
