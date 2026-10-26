import { ClientApiError, type ClientConnection } from "../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { RefreshQueue, SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { ModelReasoningEffort } from "../../types.js";
import type { SessionReasoningView } from "../../session-reasoning.js";

export interface ReasoningClientSnapshot {
  readonly sessionId: string | null;
  readonly view: SessionReasoningView | null;
  readonly loading: boolean;
  readonly writable: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly status: string | null;
}

/** Models-owned Session projection; Conversation only renders an optional seat. */
export class ReasoningClientModel extends SnapshotStore<ReasoningClientSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private observedKey = "";
  private epoch = 0;
  private operable = false;
  private closed = false;

  constructor(private readonly connection: ClientConnection, private readonly sessions: SessionClientModel) {
    super(Object.freeze({ sessionId: null, view: null, loading: false, writable: false, pending: false, error: null, status: null }));
    this.queue = new RefreshQueue(async current => {
      const state = this.getSnapshot();
      const sessionId = state.sessionId;
      const epoch = this.epoch;
      if (!sessionId || !this.available() || state.pending) return;
      try {
        const response = await this.connection.request<{ value: SessionReasoningView }>(`/api/sessions/${encodeURIComponent(sessionId)}/controls/model-reasoning`);
        if (current() && epoch === this.epoch && this.available() && this.getSnapshot().sessionId === sessionId && !this.getSnapshot().pending) {
          this.publish({ ...this.getSnapshot(), view: response.value, loading: false, writable: true, error: null });
        }
      } catch (error) {
        if (current() && epoch === this.epoch && this.getSnapshot().sessionId === sessionId) {
          this.publish({ ...this.getSnapshot(), ...(revoked(error) ? { view: null } : {}), loading: false, writable: false, error: error instanceof Error ? error.message : "思考设置读取失败" });
        }
      }
    });
    this.removers.push(sessions.subscribe(this.sync), connection.subscribe(this.sync), connection.onInvalidation(() => { void this.refresh(); }));
    this.timer = setInterval(() => { if (this.getSnapshot().sessionId) void this.refresh(); }, 15_000);
    this.sync();
  }

  readonly refresh = (): Promise<void> => this.queue.request();

  readonly select = async (effort: ModelReasoningEffort): Promise<void> => {
    const state = this.getSnapshot();
    const control = state.view?.control;
    if (!this.available() || !state.writable || state.loading || !state.sessionId || this.sessions.getSnapshot().selectedId !== state.sessionId || !state.view || !control || state.pending || !control.efforts.includes(effort)) {
      throw new Error("当前会话不能修改思考强度");
    }
    const selected = effort === control.defaultEffort ? null : effort;
    const epoch = ++this.epoch;
    this.publish({ ...state, writable: false, pending: true, error: null, status: "正在设置…" });
    try {
      const response = await this.connection.request<{ value: SessionReasoningView }>(
        `/api/sessions/${encodeURIComponent(state.sessionId)}/controls/model-reasoning`,
        { model: state.view.model, effort: selected },
      );
      if (!this.closed && epoch === this.epoch && this.available() && this.getSnapshot().sessionId === state.sessionId) {
        this.publish({ ...this.getSnapshot(), view: response.value, writable: true, pending: false, status: "下次新运行生效" });
      }
    } catch (error) {
      if (!this.closed && epoch === this.epoch && this.getSnapshot().sessionId === state.sessionId) {
        this.publish({ ...this.getSnapshot(), ...(revoked(error) ? { view: null } : {}), writable: false, pending: false, status: null,
          error: error instanceof Error ? error.message : "思考强度设置失败" });
        void this.refresh();
      }
      throw error;
    }
  };

  close(): void {
    this.closed = true;
    this.epoch++;
    clearInterval(this.timer);
    this.queue.close();
    for (const remove of this.removers.splice(0)) remove();
    this.publish({ sessionId: null, view: null, loading: false, writable: false, pending: false, error: null, status: null });
  }

  private readonly sync = (): void => {
    if (this.closed) return;
    const session = this.sessions.getSnapshot();
    const connection = this.connection.getSnapshot();
    const active = connection.online && connection.businessAvailable;
    const selectedId = active ? session.selectedId : null;
    const key = `${connection.instanceId ?? ""}:${active}:${selectedId ?? ""}`;
    const operable = this.available();
    if (key === this.observedKey) {
      if (operable !== this.operable) {
        this.operable = operable; this.epoch++;
        this.publish({ ...this.getSnapshot(), writable: false, pending: false });
        if (operable && selectedId) void this.refresh();
      }
      return;
    }
    this.observedKey = key;
    this.operable = operable;
    this.epoch++;
    this.publish({ sessionId: selectedId, view: null, loading: !!selectedId, writable: false, pending: false, error: null, status: null });
    if (selectedId) void this.refresh();
  };

  private available(): boolean {
    const state = this.connection.getSnapshot();
    const selected = this.sessions.getSnapshot();
    return !this.closed && state.online && state.businessAvailable && selected.available !== false && !selected.working && selected.sessions?.find(session => session.sessionId === selected.selectedId)?.status !== "archived";
  }
}

function revoked(error: unknown): boolean {
  return error instanceof ClientApiError && (error.status === 401 || error.status === 403 ||
    error.status === 404 && ["control_not_found", "session_not_found"].includes(error.code) ||
    ["management_closed", "connection_closed"].includes(error.code));
}
