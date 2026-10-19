import type { Session, SessionHistorySnapshot, SessionStatus } from "../../../../sessions/types.js";
import type { WishWebRunAccepted, WishWebRunView } from "../../types.js";
import type { RuntimeControlReceipt } from "../../../../core/runtime/control.js";
import type { ClientConnection } from "../connection.js";
import { RunClientModel } from "./run.js";
import { RefreshQueue, SnapshotStore } from "./store.js";

const MAX_CACHED_HISTORIES = 6;

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
const attempt = async <T>(promise: Promise<T>): Promise<Attempt<T>> => promise.then(
  value => ({ ok: true as const, value }),
  error => ({ ok: false as const, error }),
);
function useAttempt<T>(result: Attempt<T> | null, fallback: () => Promise<T>): Promise<T> {
  if (result === null) return fallback();
  return result.ok ? Promise.resolve(result.value) : Promise.reject(result.error);
}

function sameSessions(left: readonly Session[], right: readonly Session[]): boolean {
  return left === right || left.length === right.length && left.every((item, index) => {
    const other = right[index];
    if (!other) return false;
    return item.schemaVersion === other.schemaVersion && item.sessionId === other.sessionId &&
      item.agentId === other.agentId && item.scope === other.scope && item.status === other.status &&
      item.createdAt === other.createdAt && item.updatedAt === other.updatedAt &&
      item.historyRevision === other.historyRevision && item.title === other.title;
  });
}

function sameRuns(left: readonly WishWebRunView[], right: readonly WishWebRunView[]): boolean {
  return left === right || left.length === right.length && left.every((item, index) => {
    const other = right[index];
    if (!other) return false;
    return item.schemaVersion === other.schemaVersion && item.agentId === other.agentId &&
      item.runId === other.runId && item.initialUserTurnId === other.initialUserTurnId &&
      item.sessionId === other.sessionId && item.status === other.status &&
      item.createdAt === other.createdAt &&
      JSON.stringify(item.completion) === JSON.stringify(other.completion) &&
      item.cleanupError === other.cleanupError;
  });
}

export interface SessionClientSnapshot {
  readonly filter: SessionStatus;
  readonly creating: boolean;
  readonly sessions: readonly Session[]; readonly selectedId: string | null; readonly history: SessionHistorySnapshot | null;
  readonly runs: readonly WishWebRunView[]; readonly loading: boolean; readonly working: boolean; readonly available: boolean; readonly error: string | null;
}
/** Host mirrors and selection; no React state, Tool dispatch or feature-specific code. */
export class SessionClientModel extends SnapshotStore<SessionClientSnapshot> {
  readonly run: RunClientModel;
  private readonly queue: RefreshQueue;
  private readonly removeConnection: () => void;
  private readonly removeInvalidation: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private generation: string | null = null;
  private mutationVersion = 0;
  private readonly histories = new Map<string, SessionHistorySnapshot>();
  private readonly selections: Record<SessionStatus, string | null> = { active: null, archived: null };
  constructor(private readonly connection: ClientConnection) {
    super({ filter: "active", creating: false, sessions: [], selectedId: null, history: null, runs: [], loading: true, working: false, available: false, error: null });
    this.run = new RunClientModel(connection, () => { void this.refresh(); });
    this.queue = new RefreshQueue(async current => {
      if (!this.getSnapshot().available) return;
      const version = this.mutationVersion;
      const fresh = () => current() && version === this.mutationVersion && !this.getSnapshot().working;
      try {
        const initial = this.getSnapshot(), initialSelectedId = initial.selectedId;
        const initialHistory = initialSelectedId
          ? initial.history?.sessionId === initialSelectedId ? initial.history : this.cachedHistory(initialSelectedId, initial.sessions)
          : null;
        const initialSession = initial.sessions.find(item => item.sessionId === initialSelectedId);
        const initialHistoryCurrent = initialHistory !== null && initialHistory.historyRevision === initialSession?.historyRevision;
        const initialPath = initialSelectedId ? `/api/sessions/${encodeURIComponent(initialSelectedId)}` : null;
        const [list, prefetchedHistory, prefetchedRuns] = await Promise.all([
          connection.request<{ sessions: readonly Session[] }>("/api/sessions"),
          initialPath && !initialHistoryCurrent
            ? attempt(connection.request<{ history: SessionHistorySnapshot }>(`${initialPath}/history`).then(result => result.history))
            : Promise.resolve(null),
          initialPath
            ? attempt(connection.request<{ runs: readonly WishWebRunView[] }>(`${initialPath}/runs`).then(result => result.runs))
            : Promise.resolve(null),
        ]);
        if (!fresh()) return;
        this.replaceSessions(list.sessions, this.getSnapshot().selectedId, this.getSnapshot().creating);
        const selectedId = this.getSnapshot().selectedId;
        if (!selectedId) { this.publish({ ...this.getSnapshot(), loading: false, history: null, runs: [], error: null }); return; }
        const path = `/api/sessions/${encodeURIComponent(selectedId)}`;
        const selected = this.getSnapshot().sessions.find(item => item.sessionId === selectedId);
        const selectedState = this.getSnapshot();
        const previous = selectedState.history?.sessionId === selectedId
          ? selectedState.history
          : this.cachedHistory(selectedId, selectedState.sessions);
        const historyCurrent = previous?.sessionId === selectedId &&
          typeof selected?.historyRevision === "string" &&
          previous.historyRevision === selected.historyRevision;
        const loadHistory = () => connection.request<{ history: SessionHistorySnapshot }>(`${path}/history`).then(result => result.history);
        const loadRuns = () => connection.request<{ runs: readonly WishWebRunView[] }>(`${path}/runs`).then(result => result.runs);
        const [history, runs] = await Promise.all([
          historyCurrent
            ? Promise.resolve(previous)
            : selectedId === initialSelectedId ? useAttempt(prefetchedHistory, loadHistory) : loadHistory(),
          selectedId === initialSelectedId ? useAttempt(prefetchedRuns, loadRuns) : loadRuns(),
        ]);
        if (!fresh() || selectedId !== this.getSnapshot().selectedId) return;
        this.rememberHistory(history);
        const currentHistory = this.getSnapshot().history;
        const currentState = this.getSnapshot();
        const nextHistory = currentHistory?.sessionId === history.sessionId && currentHistory.historyRevision === history.historyRevision ? currentHistory : history;
        const nextRuns = sameRuns(currentState.runs, runs) ? currentState.runs : runs;
        if (nextHistory !== currentState.history || nextRuns !== currentState.runs || currentState.loading || currentState.error !== null) {
          this.publish({ ...currentState, history: nextHistory, runs: nextRuns, loading: false, error: null });
        }
        const active = nextRuns.find(item => item.status === "running");
        if (active) this.run.observe(active.runId);
      } catch (error) { if (fresh()) this.publish({ ...this.getSnapshot(), loading: false, error: error instanceof Error ? error.message : "会话读取失败" }); }
    });
    const update = () => {
      const state = connection.getSnapshot(), available = state.online && state.businessAvailable;
      if (this.generation !== state.instanceId) { this.generation = state.instanceId; this.mutationVersion++; this.histories.clear(); this.run.clear(); this.publish({ ...this.getSnapshot(), history: null, runs: [] }); }
      const changed = available !== this.getSnapshot().available;
      this.publish({ ...this.getSnapshot(), available });
      if (!available) { this.mutationVersion++; this.run.suspend(); }
      if (changed && available) void this.refresh();
    };
    this.removeConnection = connection.subscribe(update); this.removeInvalidation = connection.onInvalidation(() => { void this.refresh(); });
    this.timer = setInterval(() => { void this.refresh(); }, 3000); update();
  }
  refresh = (): Promise<void> => this.queue.request();
  /** Browser-only list scope; this never archives, restores or stops a Host Run. */
  browse = (filter: SessionStatus): void => {
    const state = this.getSnapshot();
    if (this.closed || (filter === state.filter && !state.creating)) return;
    if (!state.creating) this.selections[state.filter] = state.selectedId;
    this.mutationVersion++;
    this.run.clear();
    const selectedId = this.resolveSelection(state.sessions, filter, this.selections[filter]);
    const history = selectedId ? this.cachedHistory(selectedId, state.sessions) : null;
    this.publish({ ...state, filter, creating: false, selectedId, history, runs: [], loading: !!selectedId && !history, error: null });
    void this.refresh();
  };
  /** Enter the browser-only creation flow. No Host Session exists until create() succeeds. */
  startCreate = (): void => {
    const state = this.getSnapshot();
    if (this.closed || state.creating) return;
    this.selections[state.filter] = state.selectedId;
    this.mutationVersion++;
    this.run.clear();
    this.publish({ ...state, filter: "active", creating: true, selectedId: null, history: null, runs: [], loading: false, error: null });
  };
  select = (sessionId: string): void => {
    const state = this.getSnapshot();
    if (this.closed || sessionId === state.selectedId || !state.sessions.some(item => item.sessionId === sessionId && item.status === state.filter)) return;
    this.selections[state.filter] = sessionId;
    const history = this.cachedHistory(sessionId, state.sessions);
    this.run.clear(); this.publish({ ...state, creating: false, selectedId: sessionId, history, runs: [], loading: !history, error: null }); void this.refresh();
  };
  create = async (workspaceRoot: string): Promise<string> => {
    const root = workspaceRoot.trim();
    if (!root) throw new Error("请先选择工作区");
    let createdId: string | null = null;
    await this.mutate(async current => { const { session } = await this.connection.request<{ session: Session }>("/api/sessions", { workspaceRoot: root });
      if (!current()) return;
      this.replaceSessions([...this.getSnapshot().sessions, session], session.sessionId, false); createdId = session.sessionId; });
    if (!createdId) throw new Error("连接状态已变化，请检查会话列表后重试");
    return createdId;
  };
  rename = async (sessionId: string, title: string): Promise<void> => {
    const value = title.trim();
    if (!value || value.length > 256) throw new Error("会话名应为 1–256 个字符");
    await this.changeSession(sessionId, "", { title: value }, "PATCH");
  };
  archive = (sessionId: string): Promise<void> => this.changeSession(sessionId, "/archive", {});
  restore = (sessionId: string): Promise<void> => this.changeSession(sessionId, "/restore", {});
  delete = async (sessionId: string): Promise<void> => {
    await this.mutate(async current => {
      await this.connection.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {}, "DELETE");
      if (current()) { this.histories.delete(sessionId); this.replaceSessions(this.getSnapshot().sessions.filter(item => item.sessionId !== sessionId)); }
    });
  };
  private async changeSession(sessionId: string, suffix: string, body: unknown, method = "POST"): Promise<void> {
    await this.mutate(async current => {
      const { session } = await this.connection.request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}${suffix}`, body, method);
      if (!current()) return;
      const sessions = this.getSnapshot().sessions.map(item => item.sessionId === sessionId ? session : item);
      this.replaceSessions(sessions);
    });
  }
  private replaceSessions(sessions: readonly Session[], selectedId = this.getSnapshot().selectedId, creating = this.getSnapshot().creating): void {
    const state = this.getSnapshot(), { filter } = state;
    selectedId = creating && filter === "active" ? null : this.resolveSelection(sessions, filter, selectedId);
    this.selections[filter] = selectedId;
    const changed = selectedId !== state.selectedId;
    if (changed) this.run.clear();
    const nextSessions = sameSessions(state.sessions, sessions) ? state.sessions : sessions;
    if (!changed && creating === state.creating && nextSessions === state.sessions) return;
    const history = changed && selectedId ? this.cachedHistory(selectedId, sessions) : null;
    this.publish({ ...state, creating, sessions: nextSessions, selectedId, ...(changed ? { history, runs: [], loading: !!selectedId && !history } : {}) });
  }
  private cachedHistory(sessionId: string, sessions: readonly Session[]): SessionHistorySnapshot | null {
    const revision = sessions.find(item => item.sessionId === sessionId)?.historyRevision;
    const history = this.histories.get(sessionId);
    if (!history || typeof revision !== "string" || history.historyRevision !== revision) return null;
    this.histories.delete(sessionId); this.histories.set(sessionId, history);
    return history;
  }
  private rememberHistory(history: SessionHistorySnapshot): void {
    this.histories.delete(history.sessionId); this.histories.set(history.sessionId, history);
    while (this.histories.size > MAX_CACHED_HISTORIES) this.histories.delete(this.histories.keys().next().value!);
  }
  private resolveSelection(sessions: readonly Session[], filter: SessionStatus, selectedId: string | null): string | null {
    return sessions.some(item => item.sessionId === selectedId && item.status === filter) ? selectedId : sessions.find(item => item.status === filter)?.sessionId ?? null;
  }
  send = async (text: string, mode: "queue" | "steer", expectedSessionId?: string): Promise<void> => {
    if (!text.trim()) throw new Error("请输入请求内容");
    const state = this.getSnapshot(), selectedId = state.selectedId;
    if (!selectedId) throw new Error("请先创建会话");
    if (expectedSessionId && selectedId !== expectedSessionId) throw new Error("会话已切换；首条消息没有发送，请打开新建的会话核对");
    if (state.sessions.find(item => item.sessionId === selectedId)?.status === "archived") throw new Error("会话已归档，请先取消归档");
    const active = state.runs.find(item => item.status === "running");
    await this.mutate(async () => {
      if (active) {
        const { receipt } = await this.connection.request<{ receipt: RuntimeControlReceipt }>(`/api/runs/${encodeURIComponent(active.runId)}/controls`, { type: mode === "queue" ? "follow_up" : "steer", id: crypto.randomUUID(), text });
        if (!receipt.accepted) throw new Error(`请求未接收：${receipt.reason ?? "状态已变化"}`);
        this.run.accepted(receipt, text, mode);
      } else {
        const accepted = await this.connection.request<WishWebRunAccepted>(`/api/sessions/${encodeURIComponent(selectedId)}/runs`, { text });
        if (this.getSnapshot().selectedId === selectedId) { this.publish({ ...this.getSnapshot(), runs: [...this.getSnapshot().runs, accepted.run] }); this.run.observe(accepted.run.runId); }
      }
    });
  };
  abort = async (): Promise<void> => {
    const run = this.getSnapshot().runs.find(item => item.status === "running"); if (!run) return;
    await this.mutate(async current => {
      const path = `/api/runs/${encodeURIComponent(run.runId)}`;
      const { receipt } = await this.connection.request<{ receipt: RuntimeControlReceipt }>(`${path}/controls`, { type: "abort", reason: "User requested stop from WebUI" });
      if (!receipt.accepted && receipt.reason !== "already_cancelled" && receipt.reason !== "run_already_terminal") {
        throw new Error(`停止请求未接收：${receipt.reason ?? "状态已变化"}`);
      }
      const deadline = Date.now() + 30_000;
      while (current()) {
        const { run: latest } = await this.connection.request<{ run: WishWebRunView }>(path);
        if (latest.status !== "running") return;
        if (Date.now() >= deadline) throw new Error("已请求停止，但运行仍在收尾；请稍后查看状态。");
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      throw new Error("连接状态已变化，请刷新后核对运行是否结束");
    });
  };
  close(): void { this.closed = true; clearInterval(this.timer); this.removeConnection(); this.removeInvalidation(); this.queue.close(); this.run.close(); }
  private async mutate(action: (current: () => boolean) => Promise<void>): Promise<void> {
    if (this.closed || !this.getSnapshot().available || this.getSnapshot().working) throw new Error("会话当前不可操作，请检查连接和插件状态");
    this.mutationVersion++;
    const generation = this.generation;
    this.publish({ ...this.getSnapshot(), working: true, error: null });
    try { await action(() => !this.closed && generation === this.generation); }
    finally { if (!this.closed) { this.publish({ ...this.getSnapshot(), working: false }); await this.refresh(); } }
  }
}
