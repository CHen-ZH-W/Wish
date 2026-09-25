import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionFeature } from "../../apps/session-features.js";
import type { Plan } from "../types.js";

export function createPlanSessionFeature(plan: Plan): SessionFeature {
  return {
    async inspect(sessionId) {
      const state = await plan.get({ sessionId });
      if (!state?.active || !state.document) return undefined;
      const pending = state.review?.status === "pending";
      return {
        key: "plan", title: pending ? "计划等待评审" : "继续规划", titleEn: pending ? "Plan awaiting review" : "Continue planning",
        text: state.document.markdown + (state.document.artifacts?.length ? `\n\n此版本绑定的产物：\n${JSON.stringify(state.document.artifacts, null, 2)}` : "") + (state.review?.feedback ? `\n\n用户反馈：${state.review.feedback}` : ""),
        textEn: state.document.markdown + (state.document.artifacts?.length ? `\n\nArtifacts linked to this version:\n${JSON.stringify(state.document.artifacts, null, 2)}` : "") + (state.review?.feedback ? `\n\nUser feedback: ${state.review.feedback}` : ""),
        token: { reviewId: state.review?.id, expectedPlanVersion: state.document.version, digest: state.document.digest },
        actions: pending ? [
          { name: "approve", label: "批准此版本", labelEn: "Approve this version" },
          { name: "keep-planning", label: "继续规划", labelEn: "Keep planning", feedback: true },
          { name: "cancel", label: "取消评审", labelEn: "Cancel review" },
        ] : [],
      };
    },
    async act(sessionId, action, token, feedback) {
      if (action !== "approve" && action !== "keep-planning" && action !== "cancel") throw new Error("Unknown Plan review action");
      if (typeof token.reviewId !== "string" || typeof token.expectedPlanVersion !== "number" || typeof token.digest !== "string") throw new Error("Review identity is required");
      await plan.decide({ sessionId, reviewId: token.reviewId, expectedPlanVersion: token.expectedPlanVersion,
        digest: token.digest, decision: action, actor: "human-session-surface", ...(feedback === undefined ? {} : { feedback }),
      });
    },
    async beforeInput(sessionId, text) { await plan.feedback({ sessionId, text, actor: "human-message" }); },
  };
}

export default {
  name: "plan-session-feature", inject: ["application", "plan"],
  apply(ctx: Context) { registerManagedSessionFeature(ctx, "plan", createPlanSessionFeature(ctx.plan), { codeReload: true }); },
};
