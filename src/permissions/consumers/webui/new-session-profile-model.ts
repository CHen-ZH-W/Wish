import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import { RefreshQueue, SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { SettingsClientModel } from "../../../settings/consumers/webui/model.js";
import type { PermissionProfile } from "../../types.js";
import type { SessionPermissionProfileView } from "../../session-profiles.js";

export interface NewSessionPermissionProfileSnapshot {
  readonly view: SessionPermissionProfileView | null;
  readonly selected: PermissionProfile | null;
  readonly customized: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Browser-only pre-Session choice, persisted before the first Run is sent. */
export class NewSessionPermissionProfileClientModel extends SnapshotStore<NewSessionPermissionProfileSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private instanceId: string | null = null;
  private closed = false;

  constructor(private readonly connection: ClientConnection, settings: SettingsClientModel) {
    super(Object.freeze({ view: null, selected: null, customized: false, loading: false, error: null }));
    this.queue = new RefreshQueue(async (current) => {
      if (!this.available()) return;
      try {
        const response = await this.connection.request<{ value: SessionPermissionProfileView }>("/api/controls/permission-profile/default");
        if (!current() || !this.available()) return;
        const before = this.getSnapshot();
        const selected = before.customized && before.selected !== null && response.value.availableProfiles.includes(before.selected)
          ? before.selected
          : response.value.selected;
        this.publish({ view: response.value, selected, customized: before.customized && selected === before.selected, loading: false, error: null });
      } catch (error) {
        if (current()) this.publish({ ...this.getSnapshot(), loading: false, error: error instanceof Error ? error.message : "权限选项读取失败" });
      }
    });
    this.removers.push(
      connection.subscribe(this.sync),
      connection.onInvalidation(() => { void this.refresh(); }),
      settings.subscribe(() => { void this.refresh(); }),
    );
    this.timer = setInterval(() => { if (this.available()) void this.refresh(); }, 15_000);
    this.sync();
  }

  readonly refresh = (): Promise<void> => this.queue.request();

  select(profile: PermissionProfile): void {
    const state = this.getSnapshot();
    if (!this.available() || !state.view?.availableProfiles.includes(profile)) {
      this.publish({ ...state, error: "当前 Shell 不能使用该权限" });
      return;
    }
    this.publish({ ...state, selected: profile, customized: profile !== state.view.selected, error: null });
  }

  reset(): void {
    const state = this.getSnapshot();
    this.publish({ ...state, selected: state.view?.selected ?? null, customized: false, error: null });
    void this.refresh();
  }

  capture(): (sessionId: string) => Promise<void> {
    const state = this.getSnapshot();
    if (!this.available() || !state.view || state.selected === null || !state.view.availableProfiles.includes(state.selected)) {
      throw new Error("权限选项暂不可用，请稍后重试");
    }
    const profile = state.selected;
    return async (sessionId) => {
      await this.connection.request(`/api/sessions/${encodeURIComponent(sessionId)}/controls/permission-profile`, { profile });
    };
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.queue.close();
    for (const remove of this.removers.splice(0)) remove();
  }

  private readonly sync = (): void => {
    if (this.closed) return;
    const state = this.connection.getSnapshot();
    if (!state.online || !state.businessAvailable) {
      this.instanceId = null;
      this.publish({ ...this.getSnapshot(), loading: false });
      return;
    }
    if (state.instanceId !== this.instanceId) {
      this.instanceId = state.instanceId;
      this.publish({ ...this.getSnapshot(), loading: true });
      void this.refresh();
    }
  };

  private available(): boolean {
    const state = this.connection.getSnapshot();
    return !this.closed && state.online && state.businessAvailable;
  }
}
