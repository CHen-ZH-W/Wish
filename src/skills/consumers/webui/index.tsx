import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { Icon } from "../../../apps/webui/client/ui/primitives.js";
import { SkillsClientModel } from "./model.js";
import { SkillsNavigation, SkillsPage } from "./view.js";

/** Skills owns this contribution; the shell knows neither its name nor its content. */
export const SkillsClientUi = {
  name: "ui-skills", inject: ["wishUiSlots", "wishFeatures"],
  apply(ctx: Context): void {
    const model = new SkillsClientModel(ctx.wishFeatures), slots = ctx.wishUiSlots;
    ctx.effect(() => () => model.close(), "Skills client model");
    ctx.effect(() => slots.panel({ id: "skills", label: "Skills", area: "workspace", navigation: "rail", Icon: () => <Icon name="book" />,
      onOpen: () => { void model.refresh(); }, Sidebar: () => <SkillsNavigation model={model} slots={slots} />, View: () => <SkillsPage model={model} /> }), "Skills UI contribution");
  },
};
