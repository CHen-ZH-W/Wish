import type { Context, Fiber, FiberState } from "@deepseek-ai/cordis";
import type { ClientUiPlugin } from "./plugins.js";
import { SnapshotStore } from "./model/store.js";
import { parseUiModuleManifest, type UiModuleEntry } from "./module-manifest.js";

export interface UiModuleStatus { readonly refreshRequired: boolean; readonly errors: readonly string[] }
// Cordis publishes a const enum in declarations, not a runtime export for esbuild.
const ACTIVE: FiberState = 2;
interface Binding { entry: UiModuleEntry; desired: string; mounted?: { key: string; fork: Fiber; plugin: ClientUiPlugin }; error?: string }
export interface UiModuleLoaderOptions {
  readonly fetcher?: typeof fetch;
  readonly importer?: (url: string) => Promise<Record<string, unknown>>;
  readonly pollMs?: number;
}

/** Browser adapter only. It owns UI code lifetimes, never Session/Run/domain state. */
export class UiModuleLoader extends SnapshotStore<UiModuleStatus> {
  private bindings = new Map<string, Binding>();
  private tail = Promise.resolve();
  private closed = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: Promise<void> | undefined;
  private request: AbortController | undefined;
  private unsubscribers: (() => void)[] = [];
  private manifestError: string | undefined;
  private refreshRequired = false;
  private readonly fetcher: typeof fetch;
  private readonly importer: (url: string) => Promise<Record<string, unknown>>;
  constructor(private readonly root: Context, private readonly coreUrl: string, private readonly options: UiModuleLoaderOptions = {}) {
    super(Object.freeze({ refreshRequired: false, errors: Object.freeze([]) }));
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.importer = options.importer ?? (url => import(url));
  }
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribers = [this.root.get("wishConnection")!.subscribe(this.reconcile), this.root.get("wishManagement")!.subscribe(this.reconcile)];
    const poll = async () => {
      await this.refresh();
      if (!this.closed) this.timer = setTimeout(() => { void poll(); }, this.options.pollMs ?? 3000);
    };
    void poll();
  }
  refresh = (): Promise<void> => {
    if (this.closed) return Promise.resolve();
    return this.reading ??= this.read().finally(() => { this.reading = undefined; });
  };
  retry = async (): Promise<void> => {
    await this.refresh();
    for (const binding of this.bindings.values()) if (binding.error) { binding.desired = ""; delete binding.error; }
    this.reconcile();
  };
  private async read(): Promise<void> {
    const controller = new AbortController(); this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetcher("/assets/ui-modules.json", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error("ui_manifest_unavailable");
      const text = await response.text();
      if (text.length > 65536) throw new Error("ui_manifest_too_large");
      const manifest = parseUiModuleManifest(JSON.parse(text));
      if (this.closed) return;
      this.manifestError = undefined;
      this.refreshRequired = manifest.core !== this.coreUrl;
      if (!this.refreshRequired) {
        const wanted = new Set(manifest.modules.map(entry => entry.id));
        for (const [id, binding] of this.bindings) if (!wanted.has(id)) {
          binding.desired = ""; this.bindings.delete(id); this.enqueue(() => this.remove(binding));
        }
        for (const entry of manifest.modules) {
          const binding = this.bindings.get(entry.id);
          if (binding) binding.entry = entry;
          else this.bindings.set(entry.id, { entry, desired: "" });
        }
      }
      this.reconcile();
    } catch {
      if (!this.closed) { this.manifestError = "无法检查界面更新。已加载的界面仍可使用，请检查连接后重试。"; this.report(); }
    } finally { clearTimeout(timeout); if (this.request === controller) this.request = undefined; }
  }
  private key(binding: Binding): string {
    const online = this.root.get("wishConnection")!.getSnapshot(), data = this.root.get("wishManagement")!.getSnapshot().data;
    if (this.closed || this.bindings.get(binding.entry.id) !== binding || !online.online || !data || data.inspection.instanceId !== online.instanceId
      || !binding.entry.entryIds.every(id => data.inspection.entries.some(entry => entry.id === id && entry.enabled && entry.phase === "active"))) return "";
    return JSON.stringify([online.instanceId, binding.entry.url, binding.entry.exportName, binding.entry.entryIds]);
  }
  private reconcile = (): void => {
    for (const binding of this.bindings.values()) {
      const key = this.key(binding);
      if (key === binding.desired) continue;
      binding.desired = key; delete binding.error;
      if (!key) { this.enqueue(() => this.remove(binding)); continue; }
      if (binding.mounted?.key === key) continue;
      const entry = binding.entry;
      // Import outside the activation queue: capability loss never waits for a download.
      void this.importer(entry.url).then(module => {
        const plugin = module[entry.exportName] as ClientUiPlugin | undefined;
        if (!plugin || typeof plugin.name !== "string" || typeof plugin.apply !== "function") throw new Error("invalid_ui_plugin");
        this.enqueue(async () => {
          if (binding.desired !== key || this.key(binding) !== key || binding.mounted?.key === key) return;
          const slots = this.root.get("wishUiSlots")!;
          await slots.batch(async () => {
            const previous = binding.mounted;
            await this.remove(binding);
            if (binding.desired !== key || this.key(binding) !== key) return;
            let fork: Fiber | undefined;
            try {
              fork = this.root.plugin({ ...plugin, ...(plugin.inject ? { inject: [...plugin.inject] } : {}) });
              await fork;
              if (fork.state !== ACTIVE) throw new Error("ui_dependencies_unavailable");
              if (binding.desired !== key || this.key(binding) !== key) { await fork.dispose(); return; }
              binding.mounted = { key, fork, plugin }; delete binding.error;
            } catch {
              await fork?.dispose();
              // Only restore presentation while the same Host capability is still enabled.
              if (previous && binding.desired === key && this.key(binding) === key) {
                const restored = this.root.plugin({ ...previous.plugin, ...(previous.plugin.inject ? { inject: [...previous.plugin.inject] } : {}) });
                try {
                  await restored;
                  if (restored.state !== ACTIVE) throw new Error("ui_dependencies_unavailable");
                  if (binding.desired === key && this.key(binding) === key) binding.mounted = { ...previous, fork: restored };
                  else await restored.dispose();
                }
                catch { await restored.dispose(); }
              }
              this.failure(binding, key);
            }
          });
          this.report();
        });
      }).catch(() => { this.failure(binding, key); });
    }
    this.report();
  };
  private failure(binding: Binding, key: string): void {
    if (this.closed || binding.desired !== key || this.key(binding) !== key) return;
    binding.error = `${binding.entry.id} 界面更新失败。${binding.mounted ? "暂时保留原界面。" : "此界面暂不可用，其他功能不受影响。"}请重试；若仍失败，请修正该模块后重新构建。`;
    this.report();
  }
  private async remove(binding: Binding): Promise<void> {
    const mounted = binding.mounted; delete binding.mounted; await mounted?.fork.dispose();
  }
  private enqueue(action: () => Promise<void>): void {
    this.tail = this.tail.then(action).catch(() => {
      if (!this.closed) { this.manifestError = "界面模块清理失败。请保存草稿后刷新页面；插件管理仍可操作。"; this.report(); }
    });
  }
  private report(): void {
    const errors = [...(this.manifestError ? [this.manifestError] : []), ...[...this.bindings.values()].flatMap(binding => binding.error ? [binding.error] : [])];
    if (this.getSnapshot().refreshRequired === this.refreshRequired && JSON.stringify(this.getSnapshot().errors) === JSON.stringify(errors)) return;
    this.publish({ refreshRequired: this.refreshRequired, errors: Object.freeze(errors) });
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); this.request?.abort();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const binding of this.bindings.values()) { binding.desired = ""; this.enqueue(() => this.remove(binding)); }
    this.bindings.clear(); await this.tail;
  }
}
