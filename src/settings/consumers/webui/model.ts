import type { SettingsPort, SettingsSection, SettingsView } from "../../types.js";
import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import { SnapshotStore, RefreshQueue } from "../../../apps/webui/client/model/store.js";

export interface SettingsClientSnapshot { readonly sections: readonly SettingsView[]; readonly writable: boolean; readonly error: string | null; readonly pending: boolean }
/** Shared settings mirror, independent of React and the settings-page layout. */
export class SettingsClientModel extends SnapshotStore<SettingsClientSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly unsubscribe: () => void;
  private closed = false;
  constructor(private readonly connection: ClientConnection) {
    super(Object.freeze({ sections: Object.freeze([]), writable: false, error: null, pending: false }));
    this.queue = new RefreshQueue(async current => {
      try {
        const value = await connection.request<ReturnType<SettingsPort["describe"]>>("/api/management/settings");
        if (!Array.isArray(value.sections) || typeof value.writable !== "boolean") throw new Error("invalid_settings_snapshot");
        if (current()) this.publish({ sections: value.sections, writable: value.writable, error: null, pending: this.getSnapshot().pending });
      } catch { if (current()) this.publish({ ...this.getSnapshot(), writable: false, error: "设置读取失败，连接恢复后会自动重试。" }); }
    });
    this.unsubscribe = connection.onInvalidation(() => { void this.refresh(); });
  }
  refresh = (): Promise<void> => this.queue.request();
  save = async (view: SettingsView, user: SettingsSection): Promise<SettingsView> => {
    if (this.closed || this.getSnapshot().pending || !this.getSnapshot().writable || !this.connection.getSnapshot().online) throw new Error("设置当前不可写");
    this.publish({ ...this.getSnapshot(), pending: true, error: null });
    try { return await this.connection.request<SettingsView>("/api/management/settings/replace", { namespace: view.namespace, revision: view.revision, user }); }
    catch (error) { if (!this.closed) this.publish({ ...this.getSnapshot(), error: error instanceof Error ? error.message : "设置修改失败" }); throw error; }
    finally { if (!this.closed) { this.publish({ ...this.getSnapshot(), pending: false }); await this.refresh(); } }
  };
  close(): void { this.closed = true; this.queue.close(); this.unsubscribe(); }
}
