import type { SessionFeatureView } from "../../../session-features.js";
import type { ClientConnection } from "../connection.js";
import type { SessionClientModel } from "./session.js";
import { RefreshQueue, SnapshotStore } from "./store.js";

export interface FeaturesSnapshot { readonly sessionId: string | null; readonly views: readonly SessionFeatureView[]; readonly error: string | null; readonly available: boolean; readonly pending: boolean }
/** Generic human-feature transport mirror. No module names or domain mutations. */
export class FeaturesClientModel extends SnapshotStore<FeaturesSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly remove: () => void;
  private closed = false;
  constructor(private readonly connection: ClientConnection, private readonly sessions: SessionClientModel) {
    super({ sessionId: null, views: [], error: null, available: false, pending: false });
    this.queue = new RefreshQueue(async current => {
      const selected = sessions.getSnapshot();
      if (!selected.available || !selected.selectedId) { if (current()) this.publish({ ...this.getSnapshot(), sessionId: selected.selectedId, available: false, views: [] }); return; }
      // Session mutation may remove the selected resource. Its completion will
      // refresh the authoritative selection before another feature read.
      if (selected.working) return;
      try {
        const { features } = await connection.request<{ features: readonly SessionFeatureView[] }>(`/api/sessions/${encodeURIComponent(selected.selectedId)}/features`);
        const archived = selected.sessions.find(item => item.sessionId === selected.selectedId)?.status === "archived";
        if (current()) this.publish({ ...this.getSnapshot(), sessionId: selected.selectedId, views: archived ? features.map(view => ({ ...view, actions: [] })) : features, available: true, error: null });
      } catch (error) { if (current()) this.publish({ ...this.getSnapshot(), available: false, error: error instanceof Error ? error.message : "模块信息读取失败" }); }
    });
    this.remove = sessions.subscribe(() => { const state = sessions.getSnapshot();
      if (state.selectedId !== this.getSnapshot().sessionId || !state.available) this.publish({ ...this.getSnapshot(), sessionId: state.selectedId, views: [], available: false });
      void this.refresh(); });
    void this.refresh();
  }
  refresh = (): Promise<void> => this.queue.request();
  act = async (sessionId: string, view: SessionFeatureView, action: string, feedback: string): Promise<void> => {
    const state = this.getSnapshot();
    if (this.closed || !state.available || state.pending || state.sessionId !== sessionId || this.sessions.getSnapshot().selectedId !== sessionId || !this.sessions.getSnapshot().available || this.sessions.getSnapshot().working) throw new Error("会话或能力已变化，请重新检查");
    if (this.sessions.getSnapshot().sessions.find(item => item.sessionId === sessionId)?.status === "archived") throw new Error("会话已归档，请先取消归档");
    if (!state.views.some(item => item.key === view.key) || !view.actions.some(item => item.name === action)) throw new Error("操作已不可用");
    this.publish({ ...state, pending: true });
    try { await this.connection.request(`/api/sessions/${encodeURIComponent(sessionId)}/features/${encodeURIComponent(view.key)}`, { action, token: view.token, ...(feedback ? { feedback } : {}) }); }
    finally { this.publish({ ...this.getSnapshot(), pending: false }); await this.refresh(); }
  };
  close(): void { this.closed = true; this.queue.close(); this.remove(); }
}
