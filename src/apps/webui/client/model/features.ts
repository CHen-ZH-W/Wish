import type { SessionFeatureView } from "../../../session-features.js";
import { ClientApiError, type ClientConnection } from "../connection.js";
import type { SessionClientModel } from "./session.js";
import { RefreshQueue, SnapshotStore } from "./store.js";

export interface FeaturesSnapshot { readonly sessionId: string | null; readonly views: readonly SessionFeatureView[]; readonly error: string | null; readonly available: boolean; readonly pending: boolean }
/** Generic human-feature transport mirror. No module names or domain mutations. */
export class FeaturesClientModel extends SnapshotStore<FeaturesSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private scope = "";
  private instanceId: string | null = null;
  private epoch = 0;
  constructor(private readonly connection: ClientConnection, private readonly sessions: SessionClientModel) {
    super({ sessionId: null, views: [], error: null, available: false, pending: false });
    this.queue = new RefreshQueue(async current => {
      const selected = sessions.getSnapshot();
      const epoch = this.epoch;
      if (!this.connected() || !selected.available || !selected.selectedId) { if (current()) this.publish({ ...this.getSnapshot(), sessionId: selected.selectedId, available: false, views: [] }); return; }
      // Session mutation may remove the selected resource. Its completion will
      // refresh the authoritative selection before another feature read.
      if (selected.working || this.getSnapshot().pending) return;
      try {
        const { features } = await connection.request<{ features: readonly SessionFeatureView[] }>(`/api/sessions/${encodeURIComponent(selected.selectedId)}/features`);
        const archived = selected.sessions.find(item => item.sessionId === selected.selectedId)?.status === "archived";
        if (current() && epoch === this.epoch) {
          const views = archived ? features.map(view => ({ ...view, actions: [] })) : features;
          const previous = this.getSnapshot();
          this.publish({ ...previous, sessionId: selected.selectedId, views: JSON.stringify(previous.views) === JSON.stringify(views) ? previous.views : views, available: true, error: null });
        }
      } catch (error) { if (current() && epoch === this.epoch) this.publish({ ...this.getSnapshot(), ...(revoked(error) ? { views: [] } : {}), available: false, error: error instanceof Error ? error.message : "模块信息读取失败" }); }
    });
    this.removers.push(sessions.subscribe(this.sync));
    if (connection.subscribe) this.removers.push(connection.subscribe(this.sync));
    this.timer = setInterval(() => { void this.refresh(); }, 3000);
    this.sync();
  }
  refresh = (): Promise<void> => this.queue.request();
  act = async (sessionId: string, view: SessionFeatureView, action: string, feedback: string): Promise<void> => {
    const state = this.getSnapshot();
    if (this.closed || !this.connected() || !state.available || state.pending || state.sessionId !== sessionId || this.sessions.getSnapshot().selectedId !== sessionId || !this.sessions.getSnapshot().available || this.sessions.getSnapshot().working) throw new Error("会话或能力已变化，请重新检查");
    if (this.sessions.getSnapshot().sessions.find(item => item.sessionId === sessionId)?.status === "archived") throw new Error("会话已归档，请先取消归档");
    const currentView = state.views.find(item => item.key === view.key);
    if (!currentView?.actions.some(item => item.name === action) || JSON.stringify(currentView.token) !== JSON.stringify(view.token)) throw new Error("操作已不可用");
    const epoch = ++this.epoch;
    this.publish({ ...state, pending: true });
    try {
      const { features } = await this.connection.request<{ features: readonly SessionFeatureView[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/features/${encodeURIComponent(view.key)}`, { action, token: view.token, ...(feedback ? { feedback } : {}) });
      const selected = this.sessions.getSnapshot();
      if (!this.closed && epoch === this.epoch && this.connected() && selected.available && selected.selectedId === sessionId && !selected.working) {
        const archived = selected.sessions.find(item => item.sessionId === sessionId)?.status === "archived";
        this.publish({ ...this.getSnapshot(), sessionId, views: archived ? features.map(item => ({ ...item, actions: [] })) : features, available: true, pending: false, error: null });
      }
    } catch (error) {
      if (!this.closed && epoch === this.epoch) {
        const before = this.getSnapshot();
        const views = revoked(error) ? [] : error instanceof ClientApiError && error.status === 404 && error.code === "feature_not_found"
          ? before.views.filter(item => item.key !== view.key) : before.views;
        this.publish({ ...before, views, available: false, pending: false }); await this.refresh();
      }
      throw error;
    }
  };
  close(): void { this.closed = true; this.epoch++; clearInterval(this.timer); this.queue.close(); for (const remove of this.removers.splice(0)) remove(); this.publish({ sessionId: null, views: [], available: false, pending: false, error: null }); }
  private connected(): boolean { const state = this.connection.getSnapshot?.(); return !state || state.online && state.businessAvailable; }
  private readonly sync = (): void => {
    if (this.closed) return;
    const state = this.sessions.getSnapshot(), connection = this.connection.getSnapshot?.();
    const instanceId = connection?.instanceId ?? null;
    const scope = JSON.stringify([instanceId, this.connected(), state.available, state.selectedId, !!state.working]);
    if (scope !== this.scope) {
      const boundary = !this.scope || this.instanceId !== instanceId || state.selectedId !== this.getSnapshot().sessionId || !state.available || !this.connected();
      this.instanceId = instanceId;
      this.scope = scope; this.epoch++;
      this.publish({ ...this.getSnapshot(), sessionId: state.selectedId, ...(boundary ? { views: [] } : {}), available: false, pending: false, error: null });
    }
    void this.refresh();
  };
}

function revoked(error: unknown): boolean {
  return error instanceof ClientApiError && (error.status === 401 || error.status === 403 ||
    error.status === 404 && ["control_not_found", "session_not_found"].includes(error.code) ||
    ["management_closed", "connection_closed"].includes(error.code));
}
