import type { WishWebApproval } from "../../../apps/webui/types.js";
import { ClientApiError, type ClientConnection } from "../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { SnapshotStore, RefreshQueue } from "../../../apps/webui/client/model/store.js";
import type { ApprovalRuleScope } from "../../../permissions/rules/types.js";

export class ApprovalClientModel extends SnapshotStore<{ readonly approvals: readonly WishWebApproval[]; readonly available: boolean; readonly pending: boolean; readonly error: string | null }> {
  private readonly queue: RefreshQueue; private readonly timer: ReturnType<typeof setInterval>; private readonly removers: Array<() => void> = [];
  private closed = false;
  private scope = "";
  private working = false;
  private epoch = 0;
  constructor(private readonly connection: ClientConnection, private readonly sessions: SessionClientModel) {
    super({ approvals: [], available: false, pending: false, error: null });
    this.queue = new RefreshQueue(async current => {
      const state = sessions.getSnapshot(), run = state.runs.find(item => item.status === "running");
      const epoch = this.epoch;
      if (!this.connected() || !state.available || !run) { if (current()) this.publish({ ...this.getSnapshot(), approvals: [], available: false }); return; }
      if (state.working || this.getSnapshot().pending) return;
      try { const { approvals } = await connection.request<{ approvals: readonly WishWebApproval[] }>(`/api/approvals?runId=${encodeURIComponent(run.runId)}`);
        if (current() && epoch === this.epoch) this.publish({ ...this.getSnapshot(), approvals, available: true, error: null });
      } catch (error) { if (current() && epoch === this.epoch) this.publish({ ...this.getSnapshot(), ...(revoked(error) ? { approvals: [] } : {}), available: false, error: "无法读取审批状态，请检查业务服务。" }); }
    });
    this.removers.push(sessions.subscribe(this.sync));
    if (connection.subscribe) this.removers.push(connection.subscribe(this.sync));
    this.timer = setInterval(() => { void this.refresh(); }, 1000); this.sync();
  }
  refresh = (): Promise<void> => this.queue.request();
  decide = async (view: WishWebApproval, approved: boolean, scope: ApprovalRuleScope): Promise<void> => {
    const state = this.getSnapshot(), session = this.sessions.getSnapshot();
    if (this.closed || !this.connected() || !state.available || state.pending || !session.available || session.working || view.scope.runId !== session.runs.find(item => item.status === "running")?.runId || !state.approvals.some(item => item.approvalId === view.approvalId)) throw new Error("审批或会话状态已变化，请刷新核对");
    const epoch = ++this.epoch;
    this.publish({ ...state, pending: true });
    try { await this.connection.request(`/api/approvals/${encodeURIComponent(view.approvalId)}`, { approved, scope }); }
    catch (error) {
      if (!this.closed && epoch === this.epoch) {
        const before = this.getSnapshot();
        const approvals = revoked(error) ? [] : error instanceof ClientApiError && error.status === 404 && error.code === "approval_not_found"
          ? before.approvals.filter(item => item.approvalId !== view.approvalId) : before.approvals;
        this.publish({ ...before, approvals, available: false });
      }
      throw error;
    }
    finally { if (!this.closed && epoch === this.epoch) { this.publish({ ...this.getSnapshot(), available: false, pending: false }); await this.refresh(); } }
  };
  close(): void { this.closed = true; this.epoch++; clearInterval(this.timer); for (const remove of this.removers.splice(0)) remove(); this.queue.close(); this.publish({ approvals: [], available: false, pending: false, error: null }); }
  private connected(): boolean { const state = this.connection.getSnapshot?.(); return !state || state.online && state.businessAvailable; }
  private readonly sync = (): void => {
    if (this.closed) return;
    const state = this.sessions.getSnapshot(), connection = this.connection.getSnapshot?.();
    const scope = JSON.stringify([connection?.instanceId ?? null, this.connected(), state.available, state.selectedId, state.runs.find(item => item.status === "running")?.runId ?? null]);
    const changed = scope !== this.scope, working = !!state.working;
    if (changed || working !== this.working) {
      this.scope = scope; this.working = working; this.epoch++;
      this.publish({ ...this.getSnapshot(), ...(changed ? { approvals: [] } : {}), available: false, pending: false, error: null });
    }
    void this.refresh();
  };
}

function revoked(error: unknown): boolean {
  return error instanceof ClientApiError && (error.status === 401 || error.status === 403 ||
    error.status === 404 && ["control_not_found", "session_not_found", "run_not_found"].includes(error.code) ||
    ["management_closed", "connection_closed"].includes(error.code));
}
