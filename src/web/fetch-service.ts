import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ResolveWebFetchRequest,
  RunWebFetchRequest,
  WebFetch,
  WebFetchPolicy,
  WebFetchResult,
  WebFetchSpec,
} from "./types.js";

/** Service Definition implemented by one selected public-HTTP Provider. */
export abstract class WebFetchService extends Service implements WebFetch {
  abstract readonly policy: WebFetchPolicy;

  constructor(ctx: Context) {
    super(ctx, "webFetch");
  }

  abstract resolve(request: ResolveWebFetchRequest): Promise<WebFetchSpec>;

  abstract fetch(request: RunWebFetchRequest): Promise<WebFetchResult>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    webFetch: WebFetchService;
  }
}

export default WebFetchService;
