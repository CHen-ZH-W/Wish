import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SubagentObservationView } from "./observation-view.js";
export default { name: "subagents-session-feature", inject: ["application", "subagents", "sessions", "agents"], apply(ctx: Context) {
  const captures = new Map<string, { id: string; observedAt: string; output: string }>();
  async function records(sessionId: string) {
    const session = await ctx.sessions.manager.get({ sessionId });
    if (session.agentId !== ctx.agents.agentId) throw new Error("Subagent observation requires an owned Session");
    return ctx.subagents.observeSession({ parentAgentId: session.agentId, parentSessionId: sessionId, workspaceRoot: session.scope });
  }
  registerManagedSessionFeature(ctx, "subagents", {
    async beforeRemoval(sessionId) {
      if ((await records(sessionId)).some(item => ["starting", "running", "lost"].includes(item.status))) {
        throw new Error("关联子 Agent 尚未结束或状态不明，请先核对子 Agent。 ");
      }
    },
    async inspect(sessionId) {
      const items = await records(sessionId);
      const data: SubagentObservationView = { kind: "subagent-observation", records: items, capture: captures.get(sessionId) ?? null };
      return { key: "subagents", title: "Subagent 记录与终端快照", titleEn: "Subagent records and terminal snapshots", data, text: "这些是当前会话的持久记录，不将旧状态宣称为进程实时状态。填写子 Agent ID 可读取终端快照；没有启动、发送输入或强杀操作。\n\n" + JSON.stringify(data, null, 2),
        textEn: "These are durable records for this session, not live process status. Enter a subagent ID to read a terminal snapshot; this view cannot start, send input to, or force-kill a subagent.\n\n" + JSON.stringify(data, null, 2), token: {}, actions: items.some(item => item.target) ? [{ name: "capture", label: "读取子 Agent 快照（填写 ID）", labelEn: "Read subagent snapshot (enter ID)", feedback: true }] : [] };
    },
    async act(sessionId, action, _token, feedback) {
      if (action !== "capture" || !feedback?.trim()) throw new Error("Subagent ID required");
      const record = (await records(sessionId)).find(item => item.id === feedback.trim());
      if (!record?.target) throw new Error("Subagent target is unavailable in this Session");
      const output = await ctx.subagents.capture({ id: record.id, parentAgentId: record.parentAgentId, parentSessionId: sessionId, parentRunId: record.parentRunId, workspaceRoot: record.workspaceRoot, lines: 120, maxChars: 32768 });
      captures.delete(sessionId); captures.set(sessionId, { id: record.id, observedAt: new Date().toISOString(), output });
      if (captures.size > 100) captures.delete(captures.keys().next().value!);
    },
  }, { codeReload: true });
} };
