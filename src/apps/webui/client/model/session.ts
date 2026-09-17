import type { Session, SessionHistorySnapshot, SessionStatus } from "../../../../sessions/types.js";
import type { WishWebRunAccepted, WishWebRunView } from "../../types.js";
import type { RuntimeControlReceipt } from "../../../../core/runtime/control.js";
import type { ClientConnection } from "../connection.js";
import { RunClientModel } from "./run.js";
import { RefreshQueue, SnapshotStore } from "./store.js";

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
  private readonly selections: Record<SessionStatus, string | null> = { active: null, archived: null };
  constructor(private readonly connection: ClientConnection) {
    super({ filter: "active", creating: false, sessions: [], selectedId: null, history: null, runs: [], loading: true, working: false, available: false, error: null });
    this.run = new RunClientModel(connection, () => { void this.refresh(); });
    this.queue = new RefreshQueue(async current => {
      if (!this.getSnapshot().available) return;
      const version = this.mutationVersion;
      const fresh = () => current() && version === this.mutationVersion && !this.getSnapshot().working;
      try {
        const { sessions } = await connection.request<{ sessions: readonly Session[] }>("/api/sessions");
        if (!fresh()) return;
        this.replaceSessions(sessions, this.getSnapshot().selectedId, this.getSnapshot().creating);
        const selectedId = this.getSnapshot().selectedId;
        if (!selectedId) { this.publish({ ...this.getSnapshot(), loading: false, history: null, runs: [], error: null }); return; }
        const path = `/api/sessions/${encodeURIComponent(selectedId)}`;
        const [history, runs] = await Promise.all([
          connection.request<{ history: SessionHistorySnapshot }>(`${path}/history`), connection.request<{ runs: readonly WishWebRunView[] }>(`${path}/runs`),
        ]);
        if (!fresh() || selectedId !== this.getSnapshot().selectedId) return;
        const previous = this.getSnapshot().history;
        this.publish({ ...this.getSnapshot(), history: previous?.sessionId === history.history.sessionId && previous.historyRevision === history.history.historyRevision ? previous : history.history, runs: runs.runs, loading: false, error: null });
        const active = runs.runs.find(item => item.status === "running");
        if (active) this.run.observe(active.runId);
      } catch (error) { if (fresh()) this.publish({ ...this.getSnapshot(), loading: false, error: error instanceof Error ? error.message : "会话读取失败" }); }
    });
    const update = () => {
      const state = connection.getSnapshot(), available = state.online && state.businessAvailable;
      if (this.generation !== state.instanceId) { this.generation = state.instanceId; this.mutationVersion++; this.run.clear(); this.publish({ ...this.getSnapshot(), runs: [] }); }
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
    this.publish({ ...state, filter, creating: false, selectedId, history: null, runs: [], loading: !!selectedId, error: null });
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
    this.run.clear(); this.publish({ ...this.getSnapshot(), creating: false, selectedId: sessionId, history: null, runs: [], loading: true, error: null }); void this.refresh();
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
      if (current()) this.replaceSessions(this.getSnapshot().sessions.filter(item => item.sessionId !== sessionId));
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
    const { filter } = this.getSnapshot();
    selectedId = creating && filter === "active" ? null : this.resolveSelection(sessions, filter, selectedId);
    this.selections[filter] = selectedId;
    const changed = selectedId !== this.getSnapshot().selectedId;
    if (changed) this.run.clear();
    this.publish({ ...this.getSnapshot(), creating, sessions, selectedId, ...(changed ? { history: null, runs: [], loading: !!selectedId } : {}) });
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
    await this.mutate(async () => { const { receipt } = await this.connection.request<{ receipt: RuntimeControlReceipt }>(`/api/runs/${encodeURIComponent(run.runId)}/controls`, { type: "abort", reason: "User requested stop from WebUI" });
      if (!receipt.accepted) throw new Error(`停止请求未接收：${receipt.reason ?? "状态已变化"}`); });
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
