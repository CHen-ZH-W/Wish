import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SessionFeature } from "../../apps/session-features.js";
import type { Goal, GoalRef } from "../types.js";
export function createGoalSessionFeature(goal: Goal): SessionFeature { return {
  async inspect(sessionId) { const state = await goal.get({ sessionId }); if (!state) return undefined; return { key: "goal", title: `目标 · ${state.phase}`, titleEn: `Goal · ${state.phase}`,
    text: `${state.objective}\n\n轮次：${state.roundsStarted}/${state.maxGoalRounds}\n激活：${state.activation}${state.blockedReason ? `\n阻塞：${state.blockedReason.message}` : ""}`, data: state,
    token: { goalId: state.id, revision: state.revision }, actions: state.phase === "active" ? [{ name: "pause", label: "暂停", labelEn: "Pause" }, { name: "complete", label: "标记完成", labelEn: "Mark complete" }, { name: "clear", label: "清除", labelEn: "Clear" }]
      : state.phase === "complete" ? [{ name: "clear", label: "清除", labelEn: "Clear" }]
      : [{ name: "resume", label: "恢复", labelEn: "Resume" }, { name: "complete", label: "标记完成", labelEn: "Mark complete" }, { name: "clear", label: "清除", labelEn: "Clear" }] };
  },
  async act(sessionId, action, token) { const ref = tokenRef(token); if (action === "pause") await goal.pause({ sessionId, ref }); else if (action === "resume") await goal.resume({ sessionId, ref }); else if (action === "complete") await goal.complete({ sessionId, ref }); else if (action === "clear") await goal.clear({ sessionId, ref }); else throw new Error("Unknown Goal action"); },
  async beforeRemoval(sessionId) { const state = await goal.get({ sessionId }); if (state && state.phase !== "complete") throw new Error("请先完成或清除当前 Goal。" ); },
}; }
function tokenRef(token: Readonly<Record<string, unknown>>): GoalRef { if (typeof token.goalId !== "string" || !Number.isSafeInteger(token.revision) || (token.revision as number) < 1) throw new Error("Goal identity is required"); return Object.freeze({ id: token.goalId, revision: token.revision as number }); }
export default { name: "goal-session-feature", inject: ["application", "goal"], apply(ctx: Context) { registerManagedSessionFeature(ctx, "goal", createGoalSessionFeature(ctx.goal), { codeReload: true }); } };
