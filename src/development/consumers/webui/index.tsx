import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { DevelopmentClientModel } from "./model.js";
import { DevelopmentConversationCard } from "./view.js";

/** Product presentation follows its Host capability; the ordinary conversation remains independent. */
export const DevelopmentClientUi = {
  name: "ui-development", inject: ["wishConnection", "wishSession", "wishUiSlots"],
  apply(ctx: Context): void {
    const model = new DevelopmentClientModel(ctx.wishConnection, ctx.wishSession);
    ctx.effect(() => () => model.close(), "Wish development client");
    ctx.effect(() => ctx.wishUiSlots.conversationCard({ id: "wish-development", order: 5, View: ({ sessionId }) => <DevelopmentConversationCard model={model} sessionId={sessionId} /> }), "Wish development conversation card");
  },
};
