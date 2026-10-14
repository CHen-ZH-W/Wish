import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../../apps/webui/client/plugins.js";

import { ModelUsageClientModel } from "./model.js";
import { ModelUsageStatus } from "./view.js";

/** A separately gated Models telemetry seat; model settings do not depend on it. */
export const ModelUsageClientUi = {
  name: "ui-model-usage",
  inject: ["wishConnection", "wishSession", "wishUiSlots"],
  apply(ctx: Context): void {
    const model = new ModelUsageClientModel(ctx.wishConnection, ctx.wishSession);
    ctx.effect(() => () => model.close(), "Model usage client model");
    ctx.effect(() => ctx.wishUiSlots.sessionStatus({
      id: "model-usage",
      View: ({ sessionId }) => <ModelUsageStatus model={model} sessionId={sessionId} />,
    }), "Model usage Session status contribution");
  },
};
