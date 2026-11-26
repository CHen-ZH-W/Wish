import type { Context } from "@deepseek-ai/cordis";
import { bindPageReadiness } from "../../../apps/webui/client/plugins.js";
import { Icon } from "../../../apps/webui/client/ui/primitives.js";
import { WebSearchSettingsModel } from "./model.js";
import { WebSearchSettingsPage } from "./view.js";

export const WebSearchClientUi = {
  name: "ui-web-search",
  inject: ["wishSettings", "wishManagement", "wishConnection", "wishUiSlots"],
  apply(ctx: Context): void {
    const model = new WebSearchSettingsModel(ctx.wishSettings, ctx.wishManagement, ctx.wishConnection);
    ctx.effect(() => () => model.close(), "Web search settings model");
    ctx.effect(() => bindPageReadiness(ctx, "web-search-settings", ["web-search"], ctx.wishSettings.readiness, false));
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "web-search", label: "网页搜索", labelEn: "Web search", area: "settings", preserveState: true,
      Icon: () => <Icon name="gear" />, View: () => <WebSearchSettingsPage model={model} /> }), "Web search settings panel");
  },
};
