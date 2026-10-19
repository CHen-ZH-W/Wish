import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SessionFeature } from "../../apps/session-features.js";
import type { Tmux, TmuxSessionSnapshot } from "../types.js";
import type { TmuxObservationView, TmuxPaneCapture } from "./observation-view.js";

interface TmuxObservationTargetToken {
  readonly sessionId: string;
  readonly target: string;
  readonly createdAt: string;
}

interface TmuxSessionFeatureOptions {
  readonly tmux: Pick<Tmux, "list" | "capture" | "stop">;
  readonly agentId: string;
  readonly getSession: (sessionId: string) => Promise<{
    readonly agentId: string;
    readonly status: string;
    readonly scope: string;
  }>;
  readonly resolveWorkspaceRoot: (scope: string) => Promise<string>;
  readonly now?: () => string;
}

/** Session-scoped observation and explicit removal; tmux remains the process owner. */
export function createTmuxSessionFeature(options: TmuxSessionFeatureOptions): SessionFeature {
  const captures = new Map<string, Map<string, TmuxPaneCapture>>();
  const now = options.now ?? (() => new Date().toISOString());
  async function sessions(sessionId: string) {
    const session = await options.getSession(sessionId);
    if (session.agentId !== options.agentId || session.status !== "active") throw new Error("Tmux observation requires an owned active Session");
    return options.tmux.list({ workspaceRoot: await options.resolveWorkspaceRoot(session.scope) });
  }
  function captureMap(sessionId: string): Map<string, TmuxPaneCapture> {
    const existing = captures.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Map<string, TmuxPaneCapture>();
    captures.set(sessionId, created);
    if (captures.size > 100) captures.delete(captures.keys().next().value!);
    return created;
  }
  return {
    purgeOrder: 45,
    async purgeSession(sessionId) { captures.delete(sessionId); },
    async inspect(sessionId) {
      const items = await sessions(sessionId);
      const ids = new Set(items.map(item => item.target.sessionId));
      const saved = captureMap(sessionId);
      for (const id of saved.keys()) if (!ids.has(id)) saved.delete(id);
      const data: TmuxObservationView = { kind: "tmux-observation", observedAt: now(), sessions: items, captures: [...saved.values()] };
      return { key: "tmux", title: "tmux 进程观察", titleEn: "tmux process inspection", data, text: "运行中的终端画面持续更新；进程退出后保留最终画面，直到用户手动删除。attachCommand 可在本机终端进入同一 tmux。\n\n" + JSON.stringify(data, null, 2),
        textEn: "Running terminal views update continuously. Their final view remains after exit until manually deleted. Run attachCommand locally to join the same tmux.\n\n" + JSON.stringify(data, null, 2), token: observationToken(items), actions: items.length ? [
          { name: "capture", label: "同步 tmux 画面（填写 sessionId）", labelEn: "Sync tmux view (enter sessionId)", feedback: true },
          { name: "delete", label: "删除 tmux 会话（填写 sessionId）", labelEn: "Delete tmux session (enter sessionId)", feedback: true },
        ] : [] };
    },
    async act(sessionId, action, token, feedback) {
      if (action !== "capture" && action !== "delete") throw new Error("Unknown tmux action");
      const targetId = feedback?.trim();
      if (!targetId) throw new Error("tmux sessionId required");
      const item = (await sessions(sessionId)).find(candidate => candidate.target.sessionId === targetId);
      if (!item) throw new Error("tmux target is unavailable in this Workspace");
      const observed = observationTarget(token, targetId);
      if (!observed || observed.target !== item.target.target || observed.createdAt !== item.createdAt) {
        throw new Error("tmux target changed; refresh before acting");
      }
      if (action === "capture") {
        const output = await options.tmux.capture({ target: item.target, lines: 120, maxChars: 32768 });
        captureMap(sessionId).set(targetId, { sessionId: targetId, observedAt: now(), output, active: item.active });
        return;
      }
      if (action === "delete") {
        await options.tmux.stop({ target: item.target });
        captureMap(sessionId).delete(targetId);
        return;
      }
    },
  };
}

function observationToken(items: readonly TmuxSessionSnapshot[]): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    targets: Object.freeze(items.map(item => Object.freeze({
      sessionId: item.target.sessionId,
      target: item.target.target,
      createdAt: item.createdAt,
    }))),
  });
}

function observationTarget(token: Readonly<Record<string, unknown>>, sessionId: string): TmuxObservationTargetToken | undefined {
  if (token.schemaVersion !== 1 || !Array.isArray(token.targets)) return undefined;
  const value = token.targets.find(candidate => candidate !== null && typeof candidate === "object" &&
    (candidate as Record<string, unknown>).sessionId === sessionId);
  if (value === undefined) return undefined;
  const target = value as Record<string, unknown>;
  return typeof target.target === "string" && typeof target.createdAt === "string"
    ? { sessionId, target: target.target, createdAt: target.createdAt }
    : undefined;
}

export default { name: "tmux-session-feature", inject: ["application", "tmux", "sessions", "agents", "workspace"], apply(ctx: Context) {
  registerManagedSessionFeature(ctx, "tmux", createTmuxSessionFeature({
    tmux: ctx.tmux,
    agentId: ctx.agents.agentId,
    getSession: sessionId => ctx.sessions.manager.get({ sessionId }),
    resolveWorkspaceRoot: async scope => (await ctx.workspace.resolve({ root: scope })).root,
  }), { codeReload: true });
} };
