import type { Context } from "@deepseek-ai/cordis";
import { registerManagedWebUiControl, WebUiControlError } from "../../apps/webui/controls.js";
import type { EvolutionService } from "../service.js";
import type { EvolutionTarget } from "../types.js";
import type {} from "../service.js";
import type {} from "./trigger-service.js";
import { campaignView } from "../presentation.js";
import { digest } from "../../agent-profiles/validation.js";

export const EVOLUTION_CONTROL = "wish-evolution";
export function createEvolutionControl(evolution: EvolutionService, trigger?: () => Context["evolutionTrigger"] | undefined) {
  return {
    inspectDefault: async () => ({ available: evolution.available, evaluation: "not-requested" }),
    async inspectSession(application: import("../../apps/types.js").WishApplication, sessionId: string, signal: AbortSignal) {
      const session = await application.getSession({ sessionId, signal });
      const [all, traces] = await Promise.all([evolution.list(), evolution.traces()]);
      return { available: evolution.available,
        trigger: await trigger?.()?.inspectSession(sessionId) ?? null,
        campaigns: all.filter(item => item.spec.context?.workspaceRoot === session.scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20).map(campaignView),
        traces: traces.filter(item => item.sessionId === sessionId).slice(-20).map(item => ({ id: item.id, summary: item.summary, terminalStatus: item.terminalStatus, capturedAt: item.capturedAt })),
      };
    },
    async querySession(application: import("../../apps/types.js").WishApplication, sessionId: string, body: Readonly<Record<string, unknown>>, signal: AbortSignal) {
      return translate(async () => {
        if (Object.keys(body).some(key => !["action", "campaignId", "attemptId", "sourceDigest"].includes(key)) || body.action !== "source" || typeof body.campaignId !== "string" || typeof body.attemptId !== "string" || typeof body.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(body.sourceDigest)) throw new WebUiControlError(400, "evolution_invalid_query", "An exact source identity is required");
        const session = await application.getSession({ sessionId, signal }), campaign = await evolution.get(body.campaignId);
        if (campaign.spec.context?.workspaceRoot !== session.scope) throw new WebUiControlError(404, "evolution_not_found", "This improvement belongs to another workspace");
        const index = campaign.attempts.findIndex(item => item.id === body.attemptId), proposal = campaign.attempts[index]?.proposal;
        if (!proposal || digest(proposal.source) !== body.sourceDigest) throw new WebUiControlError(409, "evolution_source_changed", "The selected source identity is unavailable");
        const previous = campaign.attempts.slice(0, index).filter(item => item.proposal).at(-1)?.proposal?.source;
        return { sourceDigest: body.sourceDigest, source: proposal.source, ...(previous ? { previousSource: previous } : {}) };
      });
    },
    async updateSession(application: import("../../apps/types.js").WishApplication, sessionId: string, body: Readonly<Record<string, unknown>>, signal: AbortSignal) {
      return translate(async () => {
      if (Object.keys(body).some(key => !["action", "requestId", "campaignId", "expectedRevision", "objective", "target", "generator", "hypothesis", "feedback"].includes(key)) ||
          typeof body.action !== "string" || typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 256) throw new WebUiControlError(400, "evolution_invalid_request", "An action and request identity are required");
      const session = await application.getSession({ sessionId, signal });
      if (session.status !== "active") throw new WebUiControlError(409, "session_archived", "Archived Session is read-only");
      if (body.action === "create") {
        if (typeof body.objective !== "string" || !body.objective.trim() || body.objective.length > 12_000 ||
            body.target !== undefined && !["prompt", "skill", "tool", "plugin"].includes(String(body.target)) ||
            body.generator !== undefined && !["structured", "runtime"].includes(String(body.generator)) ||
            body.hypothesis !== undefined && (typeof body.hypothesis !== "string" || body.hypothesis.length > 12_000)) throw new WebUiControlError(400, "evolution_invalid_request", "Describe an improvement objective");
        return { campaign: campaignView(await evolution.begin({ objective: body.objective, requestId: body.requestId, sessionId, workspaceRoot: session.scope,
          ...(body.target ? { target: body.target as EvolutionTarget } : {}), ...(body.generator ? { generator: body.generator as "structured" | "runtime" } : {}), ...(typeof body.hypothesis === "string" ? { hypothesis: body.hypothesis } : {}) })) };
      }
      if (typeof body.campaignId !== "string" || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new WebUiControlError(400, "evolution_invalid_request", "An exact campaign revision is required");
      const campaign = await evolution.get(body.campaignId);
      if (campaign.spec.context?.workspaceRoot !== session.scope) throw new WebUiControlError(404, "evolution_not_found", "This improvement belongs to another workspace");
      if (body.action === "continue") {
        if (typeof body.feedback !== "string" || !body.feedback.trim() || body.feedback.length > 12_000) throw new WebUiControlError(400, "evolution_feedback_required", "Describe the next improvement");
        return { campaign: campaignView(await evolution.continue(campaign.id, { expectedRevision: Number(body.expectedRevision), requestId: body.requestId, feedback: body.feedback })) };
      }
      if (!["pause", "cancel", "resume", "recover"].includes(body.action)) throw new WebUiControlError(400, "evolution_invalid_action", "Unknown improvement action");
      return { campaign: campaignView(await evolution.control(campaign.id, body.action as "pause" | "cancel" | "resume" | "recover", Number(body.expectedRevision))) };
      });
    },
  };
}
async function translate<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof WebUiControlError) throw error;
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message : "";
    if (code.startsWith("evolution_") || code === "storage_conflict") {
      throw new WebUiControlError(code.includes("invalid") || code.includes("required") ? 400 : code.includes("not_found") ? 404 : 409, code, error instanceof Error ? error.message : code);
    }
    throw error;
  }
}
export default { name: "evolution-webui-control", inject: ["evolution", "webUiControls"], apply(ctx: Context): void {
  registerManagedWebUiControl(ctx, EVOLUTION_CONTROL, createEvolutionControl(ctx.evolution, () => ctx.get("evolutionTrigger")));
} };
