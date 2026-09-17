import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ResolveWebSearchRequest,
  RunWebSearchRequest,
  WebSearch,
  WebSearchPolicy,
  WebSearchResult,
  WebSearchSpec,
} from "./types.js";

/** Service Definition implemented by one selected hosted-search Provider. */
export abstract class WebSearchService extends Service implements WebSearch {
  abstract readonly policy: WebSearchPolicy;

  constructor(ctx: Context) {
    super(ctx, "webSearch");
  }

  abstract resolve(request: ResolveWebSearchRequest): Promise<WebSearchSpec>;

  abstract search(request: RunWebSearchRequest): Promise<WebSearchResult>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    webSearch: WebSearchService;
  }
}

export default WebSearchService;
