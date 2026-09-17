import type { ManagedPluginReceipt, ManagedPluginSnapshot } from "../../../../boot/plugin-control/managed-types.js";
import type { PluginLifecycleCollection, PluginPreference } from "../../../../boot/plugin-control/management-types.js";
import type { ClientConnection } from "../connection.js";
import { RefreshQueue, SnapshotStore } from "./store.js";

export interface ManagementSnapshot { readonly data: ManagedPluginSnapshot | null; readonly loading: boolean; readonly error: string | null; readonly pending: boolean }
export class PluginManagementModel extends SnapshotStore<ManagementSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly unsubscribe: () => void;
  private closed = false;
  constructor(private readonly connection: ClientConnection) {
    super(Object.freeze({ data: null, loading: true, error: null, pending: false }));
    this.queue = new RefreshQueue(async current => {
      try {
        const data = await connection.request<ManagedPluginSnapshot>("/api/management/plugins");
        if (!data || !Array.isArray(data.inspection?.entries) || typeof data.revision !== "string" || !["ready", "working", "recovery-required"].includes(data.status)) throw new Error("invalid_management_snapshot");
        if (current()) this.publish({ ...this.getSnapshot(), data, loading: false, error: null });
      } catch (error) { if (current()) this.publish({ ...this.getSnapshot(), loading: false, error: message(error) }); }
    });
    this.unsubscribe = connection.onInvalidation(() => { void this.refresh(); });
  }
  refresh = (): Promise<void> => this.queue.request();
  preview = (entryIds: readonly string[]): Promise<PluginLifecycleCollection> => {
    const data = this.getSnapshot().data;
    if (this.closed || !data) return Promise.reject(new Error("尚未获得插件状态"));
    return this.connection.request("/api/management/plugins/preview", { instanceId: data.inspection.instanceId, entryIds });
  };
  change = async (entryIds: readonly string[], preference: PluginPreference, expected: { revision: string; instanceId: string }): Promise<ManagedPluginReceipt> => {
    const state = this.getSnapshot();
    if (this.closed || !state.data || state.pending || !this.connection.getSnapshot().online) throw new Error("管理状态不可用，连接恢复后会自动同步");
    if (state.data.revision !== expected.revision || state.data.inspection.instanceId !== expected.instanceId) throw new Error("management_revision_conflict");
    this.publish({ ...state, pending: true, error: null });
    try {
      const receipt = await this.connection.request<ManagedPluginReceipt>("/api/management/plugins/change", {
        requestId: crypto.randomUUID(), revision: state.data.revision, selection: { instanceId: state.data.inspection.instanceId, entryIds }, preference,
      });
      if (receipt.status !== "succeeded") throw new Error(receipt.code);
      return receipt;
    } catch (error) { if (!this.closed) this.publish({ ...this.getSnapshot(), error: message(error) }); throw error; }
    finally { if (!this.closed) { this.publish({ ...this.getSnapshot(), pending: false }); await this.refresh(); } }
  };
  recover = async (): Promise<void> => {
    const state = this.getSnapshot(); if (this.closed || !state.data || state.pending) return;
    this.publish({ ...state, pending: true });
    try { await this.connection.request("/api/management/plugins/recover-disabled", { revision: state.data.revision }); }
    catch (error) { if (!this.closed) this.publish({ ...this.getSnapshot(), error: message(error) }); throw error; }
    finally { if (!this.closed) { this.publish({ ...this.getSnapshot(), pending: false }); await this.refresh(); } }
  };
  close(): void { this.closed = true; this.queue.close(); this.unsubscribe(); }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，状态会自动重新同步";
}
