import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";

import { ContextOccupancyClientModel } from "./model.js";
import { ContextOccupancyStatus } from "./view.js";

/** Context telemetry follows its independently removable Session status seat. */
export const ContextOccupancyClientUi = {
  name: "ui-context-occupancy",
  inject: ["wishConnection", "wishSession", "wishUiSlots"],
  apply(ctx: Context): void {
    const model = new ContextOccupancyClientModel(ctx.wishConnection, ctx.wishSession);
    ctx.effect(() => () => model.close(), "Context occupancy client model");
    ctx.effect(() => ctx.wishUiSlots.sessionStatus({
      id: "context-occupancy",
      View: ({ sessionId }) => <ContextOccupancyStatus model={model} sessionId={sessionId} />,
    }), "Context occupancy Session status contribution");
  },
};
