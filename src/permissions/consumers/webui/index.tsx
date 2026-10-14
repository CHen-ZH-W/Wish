import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { PermissionProfileClientModel } from "./profile-model.js";
import { NewSessionPermissionProfileClientModel } from "./new-session-profile-model.js";
import {
  NewSessionPermissionProfileComposerItem,
  PermissionProfileComposerItem,
} from "./profile-view.js";

export const PermissionsClientUi = {
  name: "ui-permissions",
  inject: ["wishSettings", "wishConnection", "wishSession", "wishNewSession", "wishUiSlots"],
  apply(ctx: Context): void {
    const current = new PermissionProfileClientModel(ctx.wishConnection, ctx.wishSession);
    const next = new NewSessionPermissionProfileClientModel(ctx.wishConnection, ctx.wishSettings);
    ctx.effect(() => () => current.close(), "Permissions Session profile client model");
    ctx.effect(() => () => next.close(), "Permissions pre-Session profile client model");
    ctx.effect(() => ctx.wishNewSession.registerFirstMessageSetup("permission-profile", () => {
      const apply = next.capture();
      return async (sessionId) => { await apply(sessionId); await current.refresh(); };
    }), "Permissions first-message selection");
    ctx.effect(() => {
      let phase = ctx.wishNewSession.getSnapshot().phase;
      return ctx.wishNewSession.subscribe(() => {
        const changed = ctx.wishNewSession.getSnapshot().phase;
        if (phase !== "ready" && changed === "ready") next.reset();
        phase = changed;
      });
    }, "Permissions new-session choice lifetime");
    ctx.effect(() => ctx.wishUiSlots.composer({
      id: "permission-profile",
      View: ({ sessionId, busy }) => <PermissionProfileComposerItem model={current} sessionId={sessionId} busy={busy} />,
    }), "Permissions composer contribution");
    ctx.effect(() => ctx.wishUiSlots.newSessionComposer({
      id: "permission-profile",
      View: ({ disabled }) => <NewSessionPermissionProfileComposerItem model={next} disabled={disabled} />,
    }), "Permissions new-session composer contribution");
  },
};
