import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { RefreshQueue, SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { PermissionProfile } from "../../types.js";
import type { SessionPermissionProfileView } from "../../session-profiles.js";

export interface PermissionProfileClientSnapshot {
  readonly sessionId: string | null;
  readonly view: SessionPermissionProfileView | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly status: string | null;
}

/** Permissions-owned Session projection; the composer only renders its registered seat. */
export class PermissionProfileClientModel extends SnapshotStore<PermissionProfileClientSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private observedKey = "";
  private closed = false;

  constructor(private readonly connection: ClientConnection, private readonly sessions: SessionClientModel) {
    super(Object.freeze({ sessionId: null, view: null, loading: false, pending: false, error: null, status: null }));
    this.queue = new RefreshQueue(async (current) => {
      const state = this.getSnapshot();
      const sessionId = state.sessionId;
      if (!sessionId || !this.available() || state.pending) return;
      try {
        const response = await this.connection.request<{ value: SessionPermissionProfileView }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/controls/permission-profile`,
        );
        if (current() && this.getSnapshot().sessionId === sessionId && !this.getSnapshot().pending) {
          this.publish({ ...this.getSnapshot(), view: response.value, loading: false, error: null });
        }
      } catch (error) {
        if (current() && this.getSnapshot().sessionId === sessionId) {
          this.publish({ ...this.getSnapshot(), loading: false, error: error instanceof Error ? error.message : "权限设置读取失败" });
        }
      }
    });
    this.removers.push(
      sessions.subscribe(this.sync),
      connection.subscribe(this.sync),
      connection.onInvalidation(() => { void this.refresh(); }),
    );
    this.timer = setInterval(() => { if (this.getSnapshot().sessionId) void this.refresh(); }, 15_000);
    this.sync();
  }

  readonly refresh = (): Promise<void> => this.queue.request();

  readonly select = async (profile: PermissionProfile): Promise<void> => {
    const state = this.getSnapshot();
    if (!this.available() || !state.sessionId || !state.view || state.pending || !state.view.availableProfiles.includes(profile)) {
      throw new Error("当前会话不能使用该权限");
    }
    this.publish({ ...state, pending: true, error: null, status: "正在设置…" });
    try {
      const response = await this.connection.request<{ value: SessionPermissionProfileView }>(
        `/api/sessions/${encodeURIComponent(state.sessionId)}/controls/permission-profile`,
        { profile },
      );
      if (!this.closed && this.getSnapshot().sessionId === state.sessionId) {
        this.publish({ ...this.getSnapshot(), view: response.value, pending: false, status: "下次新运行生效" });
      }
    } catch (error) {
      if (!this.closed && this.getSnapshot().sessionId === state.sessionId) {
        this.publish({
          ...this.getSnapshot(),
          pending: false,
          status: null,
          error: error instanceof Error ? error.message : "权限设置失败",
        });
        void this.refresh();
      }
      throw error;
    }
  };

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.queue.close();
    for (const remove of this.removers.splice(0)) remove();
  }

  private readonly sync = (): void => {
    if (this.closed) return;
    const session = this.sessions.getSnapshot();
    const connection = this.connection.getSnapshot();
    const active = connection.online && connection.businessAvailable;
    const selectedId = active ? session.selectedId : null;
    const key = `${connection.instanceId ?? ""}:${active}:${selectedId ?? ""}`;
    if (key === this.observedKey) return;
    this.observedKey = key;
    this.publish({ sessionId: selectedId, view: null, loading: !!selectedId, pending: false, error: null, status: null });
    if (selectedId) void this.refresh();
  };

  private available(): boolean {
    const state = this.connection.getSnapshot();
    return !this.closed && state.online && state.businessAvailable;
  }
}
