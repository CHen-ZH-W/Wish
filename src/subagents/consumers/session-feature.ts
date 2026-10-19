import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SessionFeature } from "../../apps/session-features.js";
import type { SubagentObservationView } from "./observation-view.js";
import type { Subagents } from "../types.js";

export function createSubagentSessionFeature(
  subagents: Pick<Subagents, "observeSession" | "stop" | "capture" | "purge">,
  getSession: (sessionId: string) => Promise<{ readonly agentId: string; readonly scope: string }>,
  agentId: string,
): SessionFeature {
  const captures = new Map<string, { id: string; observedAt: string; output: string }>();
  async function records(sessionId: string) {
    const session = await getSession(sessionId);
    if (session.agentId !== agentId) throw new Error("Subagent observation requires an owned Session");
    return subagents.observeSession({ parentAgentId: session.agentId, parentSessionId: sessionId, workspaceRoot: session.scope });
  }
  return {
    purgeOrder: 20,
    async purgeRun(sessionId, runId) {
      for (const item of (await records(sessionId)).filter(item => item.parentRunId === runId)) {
        await subagents.purge({ id: item.id, parentAgentId: item.parentAgentId, parentSessionId: item.parentSessionId,
          parentRunId: item.parentRunId, workspaceRoot: item.workspaceRoot });
      }
      captures.delete(sessionId);
    },
    async purgeSession(sessionId) {
      for (const item of await records(sessionId)) {
        await subagents.purge({ id: item.id, parentAgentId: item.parentAgentId, parentSessionId: item.parentSessionId,
          parentRunId: item.parentRunId, workspaceRoot: item.workspaceRoot });
      }
      captures.delete(sessionId);
    },
    async beforeRemoval(sessionId, operation) {
      const items = await records(sessionId);
      if (operation === "delete") {
        for (const item of items.filter(item => ["starting", "running", "lost"].includes(item.status) && item.target)) {
          await subagents.stop({ id: item.id, parentAgentId: item.parentAgentId, parentSessionId: item.parentSessionId,
            parentRunId: item.parentRunId, workspaceRoot: item.workspaceRoot });
        }
      }
      if ((await records(sessionId)).some(item => ["starting", "running", "lost"].includes(item.status))) {
        throw new Error("关联子 Agent 尚未结束或状态不明，请先核对子 Agent。 ");
      }
    },
    async inspect(sessionId) {
      const items = await records(sessionId);
      const data: SubagentObservationView = { kind: "subagent-observation", records: items, capture: captures.get(sessionId) ?? null };
      return { key: "subagents", title: "Subagent 记录与终端快照", titleEn: "Subagent records and terminal snapshots", data, text: "这些是当前会话的持久记录，不将旧状态宣称为进程实时状态。填写子 Agent ID 可读取终端快照或停止未结束的子 Agent。\n\n" + JSON.stringify(data, null, 2),
        textEn: "These are durable records for this session, not live process status. Enter a subagent ID to read its terminal snapshot or stop an unfinished child.\n\n" + JSON.stringify(data, null, 2), token: {}, actions: [
          ...(items.some(item => item.target) ? [{ name: "capture", label: "读取子 Agent 快照（填写 ID）", labelEn: "Read subagent snapshot (enter ID)", feedback: true }] : []),
          ...(items.some(item => item.target && !["stopped", "exited"].includes(item.status)) ? [{ name: "stop", label: "停止子 Agent（填写 ID）", labelEn: "Stop subagent (enter ID)", feedback: true }] : []),
        ] };
    },
    async act(sessionId, action, _token, feedback) {
      if ((action !== "capture" && action !== "stop") || !feedback?.trim()) throw new Error("Subagent ID required");
      const record = (await records(sessionId)).find(item => item.id === feedback.trim());
      if (!record?.target) throw new Error("Subagent target is unavailable in this Session");
      if (action === "stop") {
        if (["stopped", "exited"].includes(record.status)) return;
        await subagents.stop({ id: record.id, parentAgentId: record.parentAgentId, parentSessionId: sessionId,
          parentRunId: record.parentRunId, workspaceRoot: record.workspaceRoot });
        return;
      }
      const output = await subagents.capture({ id: record.id, parentAgentId: record.parentAgentId, parentSessionId: sessionId, parentRunId: record.parentRunId, workspaceRoot: record.workspaceRoot, lines: 120, maxChars: 32768 });
      captures.delete(sessionId); captures.set(sessionId, { id: record.id, observedAt: new Date().toISOString(), output });
      if (captures.size > 100) captures.delete(captures.keys().next().value!);
    },
  };
}

export default { name: "subagents-session-feature", inject: ["application", "subagents", "sessions", "agents"], apply(ctx: Context) {
  registerManagedSessionFeature(ctx, "subagents", createSubagentSessionFeature(
    ctx.subagents, sessionId => ctx.sessions.manager.get({ sessionId }), ctx.agents.agentId,
  ), { codeReload: true });
} };
