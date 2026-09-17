import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { Icon } from "../../../apps/webui/client/ui/primitives.js";
import { ModelsSettingsClientModel } from "./model.js";
import { ModelsSettingsPage } from "./view.js";
import { ReasoningClientModel } from "./reasoning-model.js";
import { NewSessionReasoningClientModel } from "./new-session-reasoning-model.js";
import { NewSessionReasoningComposerItem, ReasoningComposerItem } from "./reasoning-view.js";

/** Models owns both the setting namespace and its optional Browser presentation. */
export const ModelsClientUi = {
  name: "ui-models",
  inject: ["wishSettings", "wishConnection", "wishSession", "wishNewSession", "wishUiSlots"],
  apply(ctx: Context): void {
    const model = new ModelsSettingsClientModel(ctx.wishSettings, ctx.wishConnection);
    const reasoning = new ReasoningClientModel(ctx.wishConnection, ctx.wishSession);
    const newSessionReasoning = new NewSessionReasoningClientModel(ctx.wishConnection, ctx.wishSettings);
    ctx.effect(() => () => model.close(), "Models settings client model");
    ctx.effect(() => () => reasoning.close(), "Models reasoning client model");
    ctx.effect(() => () => newSessionReasoning.close(), "Models pre-Session reasoning client model");
    ctx.effect(() => ctx.wishNewSession.registerFirstMessageSetup("model-reasoning", () => {
      const apply = newSessionReasoning.capture();
      return apply && (async sessionId => { await apply(sessionId); await reasoning.refresh(); });
    }), "Models first-message selection");
    ctx.effect(() => {
      let phase = ctx.wishNewSession.getSnapshot().phase;
      return ctx.wishNewSession.subscribe(() => {
        const next = ctx.wishNewSession.getSnapshot().phase;
        if (phase !== "ready" && next === "ready") newSessionReasoning.reset();
        phase = next;
      });
    }, "Models new-session choice lifetime");
    ctx.effect(() => ctx.wishUiSlots.panel({
      id: "models",
      label: "模型配置",
      labelEn: "Models",
      area: "settings",
      Icon: () => <Icon name="model" />,
      View: () => <ModelsSettingsPage model={model} />,
    }), "Models UI contribution");
    ctx.effect(() => ctx.wishUiSlots.composer({
      id: "model-reasoning",
      View: ({ sessionId, busy }) => <ReasoningComposerItem model={reasoning} sessionId={sessionId} busy={busy} />,
    }), "Models composer contribution");
    ctx.effect(() => ctx.wishUiSlots.newSessionComposer({
      id: "model-reasoning",
      View: ({ disabled }) => <NewSessionReasoningComposerItem model={newSessionReasoning} disabled={disabled} />,
    }), "Models new-session composer contribution");
  },
};
