import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import type { PluginManagementModel } from "../../../apps/webui/client/model/management.js";
import { RefreshQueue, SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { CredentialStatus } from "../../../credentials/types.js";
import type { SettingsClientModel } from "../../../settings/consumers/webui/model.js";

const credentialReference = "WISH_DEEPSEEK_SEARCH_API_KEY";
const provider = "include:web-search";
const tool = "include:tool-web-search";
interface SearchSettingsSnapshot { readonly credential: CredentialStatus | null; readonly pending: boolean; readonly error: string | null }

/** Configuration writes and lifecycle commands keep their existing Host owners. */
export class WebSearchSettingsModel extends SnapshotStore<SearchSettingsSnapshot> {
  private readonly refreshQueue: RefreshQueue;
  private readonly unsubscribe: () => void;
  private closed = false;
  constructor(readonly settings: SettingsClientModel, readonly management: PluginManagementModel, readonly connection: ClientConnection) {
    super({ credential: null, pending: false, error: null });
    this.refreshQueue = new RefreshQueue(async current => {
      try {
        const result = await connection.request<{ credentials: CredentialStatus[] }>("/api/management/credentials/describe", { references: [credentialReference] });
        if (current()) this.publish({ ...this.getSnapshot(), credential: result.credentials[0] ?? null });
      } catch (error) {
        if (current()) this.publish({ ...this.getSnapshot(), credential: null, error: message(error) });
      }
    });
    this.unsubscribe = connection.onInvalidation(() => { void this.refreshQueue.request(); });
    void this.refreshQueue.request();
  }

  credential = (value: string | null): Promise<void> => this.run(async () => {
    const result = await this.connection.request<{ credential: CredentialStatus }>(
      `/api/management/credentials/${value === null ? "delete" : "set"}`,
      { reference: credentialReference, ...(value === null ? {} : { value }) });
    if (!this.closed) this.publish({ ...this.getSnapshot(), credential: result.credential });
  });

  enable = (): Promise<void> => this.run(async () => {
    const section = this.settings.getSnapshot().sections.find(view => view.namespace === "web-search-deepseek");
    if (!section) throw new Error("搜索配置当前不可用");
    await this.refreshQueue.request();
    if (!this.getSnapshot().credential?.configured) throw new Error("请先配置 DeepSeek 搜索 API 密钥");
    await this.management.refresh();
    const missing = this.entries().filter(entry => [provider, tool].includes(entry.id) && entry.enabled !== true).map(entry => entry.id);
    if (missing.length) await this.change(missing, "enabled");
    const entries = this.entries();
    if (![provider, tool].every(target => entries.some(entry => entry.id === target && entry.phase === "active"))) {
      throw new Error("搜索尚未运行，请查看插件状态");
    }
  });

  disable = (): Promise<void> => this.run(async () => {
    await this.management.refresh();
    const ids = this.entries().filter(entry => [provider, tool].includes(entry.id) && entry.enabled === true).map(entry => entry.id);
    if (ids.length) await this.change(ids, "disabled");
  });

  private entries() { return this.management.getSnapshot().data?.inspection.entries ?? []; }
  private async change(ids: readonly string[], preference: "enabled" | "disabled"): Promise<void> {
    const data = this.management.getSnapshot().data;
    if (this.closed || !data) throw new Error("management_unavailable");
    await this.management.change([...ids].sort(), preference, { revision: data.revision, instanceId: data.inspection.instanceId });
  }
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.closed || this.getSnapshot().pending || this.settings.getSnapshot().pending || !this.connection.getSnapshot().online) throw new Error("搜索设置当前不可写");
    this.publish({ ...this.getSnapshot(), pending: true, error: null });
    try { await action(); }
    catch (error) { if (!this.closed) this.publish({ ...this.getSnapshot(), error: message(error) }); throw error; }
    finally { if (!this.closed) this.publish({ ...this.getSnapshot(), pending: false }); }
  }
  close(): void { this.closed = true; this.refreshQueue.close(); this.unsubscribe(); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : "搜索设置修改失败"; }
