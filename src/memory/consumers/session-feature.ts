import type { Context } from "@deepseek-ai/cordis";
import type { SessionFeature } from "../../apps/session-features.js";
import type { Memory } from "../types.js";
import { hash } from "../validation.js";

/** Human surface only; no model Tool exposes the accept/reject authority. */
export function createMemorySessionFeature(memory: Memory): SessionFeature {
  return {
    async inspect(sessionId) {
      const state = await memory.state();
      const candidate = state.candidates.find(item => item.status === "pending" && (item.reviewSessionId ?? item.actor.sessionId) === sessionId);
      if (!candidate) return undefined;
      return { key: "memory", title: "记忆候选等待审核", titleEn: "Memory proposal awaiting review", text: `${candidate.title}\n\n适用范围：${candidate.appliesTo}\n来源：${JSON.stringify(candidate.evidence)}\n理由：${candidate.reason}\n\n${candidate.content}`,
        textEn: `${candidate.title}\n\nApplies to: ${candidate.appliesTo}\nSource: ${JSON.stringify(candidate.evidence)}\nReason: ${candidate.reason}\n\n${candidate.content}`,
        token: { libraryId: memory.libraryId, candidateId: candidate.id, version: candidate.version, digest: hash(candidate) },
        actions: [{ name: "accept", label: "采纳此版本", labelEn: "Accept this version", feedback: true }, { name: "reject", label: "拒绝此候选", labelEn: "Reject proposal", feedback: true }] };
    },
    async act(sessionId, action, token, feedback) {
      if ((action !== "accept" && action !== "reject") || token.libraryId !== memory.libraryId || typeof token.candidateId !== "string" || typeof token.version !== "number") throw new Error("Invalid Memory review action");
      const candidate = (await memory.state()).candidates.find(item => item.id === token.candidateId);
      if (!candidate || (candidate.reviewSessionId ?? candidate.actor.sessionId) !== sessionId || hash(candidate) !== token.digest) throw new Error("Memory review identity or version changed");
      await memory.decide({ candidateId: candidate.id, expectedCandidateVersion: token.version, decision: action,
        operationId: `review:${candidate.id}:${token.version}:${action}`, actor: { kind: "human", id: "human-session-surface", sessionId }, reason: feedback?.trim() || `Human ${action} decision` });
    },
  };
}
export default { name: "memory-session-feature", inject: ["memory", "application"], apply(ctx: Context) { ctx.application.registerSessionFeature("memory", createMemorySessionFeature(ctx.memory)); } };
