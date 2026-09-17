import type { WishWebApproval } from "../../../apps/webui/types.js";
import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { SnapshotStore, RefreshQueue } from "../../../apps/webui/client/model/store.js";
import type { ApprovalRuleScope } from "../../../permissions/rules/types.js";

export class ApprovalClientModel extends SnapshotStore<{ readonly approvals: readonly WishWebApproval[]; readonly available: boolean; readonly pending: boolean; readonly error: string | null }> {
  private readonly queue: RefreshQueue; private readonly timer: ReturnType<typeof setInterval>; private readonly remove: () => void;
  private closed = false;
  constructor(private readonly connection: ClientConnection, private readonly sessions: SessionClientModel) {
    super({ approvals: [], available: false, pending: false, error: null });
    this.queue = new RefreshQueue(async current => {
      const state = sessions.getSnapshot(), run = state.runs.find(item => item.status === "running");
      if (!state.available || !run) { if (current()) this.publish({ ...this.getSnapshot(), approvals: [], available: false }); return; }
      try { const { approvals } = await connection.request<{ approvals: readonly WishWebApproval[] }>(`/api/approvals?runId=${encodeURIComponent(run.runId)}`);
        if (current()) this.publish({ ...this.getSnapshot(), approvals, available: true, error: null });
      } catch { if (current()) this.publish({ ...this.getSnapshot(), available: false, error: "无法读取审批状态，请检查业务服务。" }); }
    });
    this.remove = sessions.subscribe(() => { void this.refresh(); }); this.timer = setInterval(() => { void this.refresh(); }, 1000); void this.refresh();
  }
  refresh = (): Promise<void> => this.queue.request();
  decide = async (view: WishWebApproval, approved: boolean, scope: ApprovalRuleScope): Promise<void> => {
    const state = this.getSnapshot(), session = this.sessions.getSnapshot();
    if (this.closed || !state.available || state.pending || !session.available || view.scope.runId !== session.runs.find(item => item.status === "running")?.runId || !state.approvals.some(item => item.approvalId === view.approvalId)) throw new Error("审批或会话状态已变化，请刷新核对");
    this.publish({ ...state, pending: true });
    try { await this.connection.request(`/api/approvals/${encodeURIComponent(view.approvalId)}`, { approved, scope }); }
    finally { this.publish({ ...this.getSnapshot(), pending: false }); await this.refresh(); }
  };
  close(): void { this.closed = true; clearInterval(this.timer); this.remove(); this.queue.close(); }
}
