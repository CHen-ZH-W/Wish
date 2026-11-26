import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import type { ConversationInteraction } from "../../types.js";
import { InteractionClientModel, INTERACTION_VIEW } from "./model.js";
import { InteractionView } from "./view.js";

export const InteractionsClientUi = {
  name: "ui-interactions", inject: ["wishFeatures", "wishSession", "wishUiSlots"],
  apply(ctx: Context) {
    const model = new InteractionClientModel(ctx.wishFeatures, ctx.wishSession);
    const View = ({ block }: { block: LedgerBlock }) => <InteractionView request={block.data as ConversationInteraction} model={model} />;
    ctx.effect(() => () => model.close(), "conversation interaction client model");
    ctx.effect(() => ctx.wishUiSlots.ledger({ id: INTERACTION_VIEW, placement: "message", source: model, View }), "in-place conversation interactions");
  },
};
