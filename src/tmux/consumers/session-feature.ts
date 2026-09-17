import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { TmuxObservationView } from "./observation-view.js";
export default { name: "tmux-session-feature", inject: ["application", "tmux", "sessions", "agents", "workspace"], apply(ctx: Context) {
  const captures = new Map<string, { sessionId: string; observedAt: string; output: string }>();
  async function sessions(sessionId: string) {
    const session = await ctx.sessions.manager.get({ sessionId });
    if (session.agentId !== ctx.agents.agentId || session.status !== "active") throw new Error("Tmux observation requires an owned active Session");
    const workspace = await ctx.workspace.resolve({ root: session.scope });
    return ctx.tmux.list({ workspaceRoot: workspace.root });
  }
  registerManagedSessionFeature(ctx, "tmux", {
    async inspect(sessionId) {
      const items = await sessions(sessionId);
      const data: TmuxObservationView = { kind: "tmux-observation", observedAt: new Date().toISOString(), sessions: items, capture: captures.get(sessionId) ?? null };
      return { key: "tmux", title: "tmux 进程观察", titleEn: "tmux process inspection", data, text: "只列出当前 Workspace 的 Wish 管理会话。attachCommand 在本机终端执行可进入同一 tmux；这里不是交互终端。\n\n" + JSON.stringify(data, null, 2),
        textEn: "Only Wish-managed sessions in this workspace are listed. Run attachCommand in your local terminal to join the same tmux session; this page is not an interactive terminal.\n\n" + JSON.stringify(data, null, 2), token: {}, actions: items.length ? [{ name: "capture", label: "读取 tmux 快照（填写 sessionId）", labelEn: "Read tmux snapshot (enter sessionId)", feedback: true }] : [] };
    },
    async act(sessionId, action, _token, feedback) {
      if (action !== "capture" || !feedback?.trim()) throw new Error("tmux sessionId required");
      const target = (await sessions(sessionId)).find(item => item.target.sessionId === feedback.trim())?.target;
      if (!target) throw new Error("tmux target is unavailable in this Workspace");
      const output = await ctx.tmux.capture({ target, lines: 120, maxChars: 32768 });
      captures.delete(sessionId); captures.set(sessionId, { sessionId: target.sessionId, observedAt: new Date().toISOString(), output });
      if (captures.size > 100) captures.delete(captures.keys().next().value!);
    },
  }, { codeReload: true });
} };
