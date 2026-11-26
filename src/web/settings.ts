import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../settings/service.js";
import type { SettingsScope } from "../settings/types.js";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { SEARCH_PROVIDERS, searchProvider, type SearchProviderId } from "./search-providers.js";

/** Configuration stays available while the network providers are stopped. */
export class WebSearchSettings extends Service {
  static readonly inject = ["launch"];
  private readonly selection?: SettingsScope;
  private readonly scopes = new Map<SearchProviderId, SettingsScope>();
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context) {
    super(ctx, "webSearchSettings");
    this.work = new PluginWorkOwner(ctx, { code: "web_search_settings", codeReload: true });
    const settings = ctx.get("settings");
    if (!settings) return;
    this.selection = settings.register(ctx, {
      namespace: "web-search", title: "搜索服务", applies: "next-request",
      fields: [{ key: "provider", label: "服务提供方", type: "enum", hidden: true, default: "deepseek",
        options: SEARCH_PROVIDERS.map(provider => ({ value: provider.id, label: provider.label })) }],
      base: ctx.launch.environment.WISH_WEB_SEARCH_PROVIDER ? { provider: ctx.launch.environment.WISH_WEB_SEARCH_PROVIDER } : {},
    });
    for (const provider of SEARCH_PROVIDERS) this.scopes.set(provider.id, settings.register(ctx, {
      namespace: `web-search-${provider.id}`, title: provider.label, applies: "next-request",
      fields: [
        { key: "max-results", label: "最多返回结果数", type: "number", default: 10, min: 1, max: provider.maxResults, integer: true },
        { key: "timeout-seconds", label: "请求超时（秒）", type: "number", default: 20, min: 1, max: 300 },
        { key: "max-response-bytes", label: "响应大小上限（字节）", type: "number", default: 2000000, min: 1, max: 20000000, integer: true },
      ],
    }));
  }

  current(): { provider: SearchProviderId; maxResults: number; timeoutSeconds: number; maxResponseBytes: number } {
    this.work.assertAttached();
    const provider = searchProvider(this.selection?.get().provider ?? (this.ctx.launch.environment.WISH_WEB_SEARCH_PROVIDER || "deepseek"));
    if (!provider) throw new Error("Unknown search service");
    const value = this.scopes.get(provider.id)?.get();
    return { provider: provider.id, maxResults: Number(value?.["max-results"] ?? 10), timeoutSeconds: Number(value?.["timeout-seconds"] ?? 20),
      maxResponseBytes: Number(value?.["max-response-bytes"] ?? 2000000) };
  }
}

declare module "@deepseek-ai/cordis" { interface Context { webSearchSettings: WebSearchSettings } }
export default WebSearchSettings;
