import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../credentials/service.js";
import type {} from "../settings.js";
import { WebSearchService } from "../search-service.js";
import { WebOwnerLifecycle } from "../lifecycle.js";
import { searchProvider, type SearchProviderId } from "../search-providers.js";
import type { ResolveWebSearchRequest, RunWebSearchRequest, WebSearch, WebSearchPolicy, WebSearchResult, WebSearchSpec } from "../types.js";
import { DeepseekSearchBackend, type DeepseekSearchOptions } from "./deepseek-search.js";

const backends: Readonly<Record<SearchProviderId, (options: DeepseekSearchOptions) => WebSearch>> = {
  deepseek: options => new DeepseekSearchBackend(options),
};

/** Stable Cordis plugin identity; the selected API owns its wire protocol and authorization identity. */
export class ApiWebSearch extends WebSearchService {
  static readonly inject = ["webSearchSettings", "launch"];
  private readonly lifecycle: WebOwnerLifecycle;
  private backend: WebSearch | undefined;
  private signature = "";
  constructor(ctx: Context) { super(ctx); this.lifecycle = new WebOwnerLifecycle(ctx, "web_search_provider"); }
  get policy(): WebSearchPolicy { return this.current().policy; }
  private current(): WebSearch {
    const options = this.ctx.webSearchSettings.current(), signature = JSON.stringify(options);
    if (!this.backend || signature !== this.signature) {
      const reference = searchProvider(options.provider)!.credentialReference;
      this.backend = backends[options.provider]({ ...options,
        credential: () => this.ctx.get("credentials")?.resolve(reference) ?? this.ctx.launch.environment[reference] });
      this.signature = signature;
    }
    return this.backend;
  }
  resolve(request: ResolveWebSearchRequest): Promise<WebSearchSpec> { return this.lifecycle.run(() => this.current().resolve(request)); }
  search(request: RunWebSearchRequest): Promise<WebSearchResult> { return this.lifecycle.run(() => this.current().search(request)); }
}

export default ApiWebSearch;
