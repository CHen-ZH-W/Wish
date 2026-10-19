import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type {} from "../../apps/webui/host/management.js";
import { fail, text } from "../validation.js";

/** Authenticated local operator API for an already running WebUI Host. */
export default {
  name: "candidate-management", inject: ["candidates", "agentProfiles", "experiments", "application", "launch"],
  apply(ctx: Context) {
    const host = ctx.root.get("webManagementHost"); if (!host) return;
    const retired = new AbortController();
    const owner = new PluginWorkOwner(ctx, { code: "candidate_management", codeReload: true, beforeDrain: () => retired.abort() });
    const registration = host.registerControl("candidates", (action, input, signal) => owner.run(async () => {
      const combined = AbortSignal.any([signal, retired.signal]);
      if (action === "list") return ctx.candidates.list();
      if (action === "history") return ctx.candidates.history();
      if (action === "reconcile") return ctx.candidates.reconcile(text(input.promotionId));
      if (action === "submit") return ctx.candidates.submit(input);
      if (action === "validate") return ctx.candidates.validate(input, combined);
      if (action === "evaluate") return ctx.candidates.evaluate(input, combined);
      if (action === "review") return ctx.candidates.prepareReview(input);
      if (action === "promote") return ctx.candidates.promote(input.review, text(input.approvedReviewDigest, 64), combined);
      if (action === "rollback") return ctx.candidates.rollback(text(input.promotionId), text(input.approvedReviewDigest, 64), combined);
      if (action === "profile-register") return ctx.agentProfiles.register(input);
      if (action === "profile-capture") return ctx.agentProfiles.capture(text(input.selection), await ctx.application.resolve());
      if (action === "dataset") return ctx.experiments.registerDataset(input);
      if (action === "experiment") return ctx.experiments.get(text(input.id));
      fail("candidate_management_action_unknown");
    }), 8 * 1024 * 1024);
    ctx.effect(() => () => registration.release(), "candidate operator management API");
  },
};
