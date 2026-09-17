import type { Fiber } from "@deepseek-ai/cordis";

import type {
  WebFetch,
  WebFetchResult,
  WebSearch,
  WebSearchResult,
} from "../src/web/index.js";
import HttpWebFetch, {
  Config as HttpWebFetchConfigSchema,
  HttpWebFetchBackend,
} from "../src/web/providers/http-fetch.js";
import SearxngSearch, {
  Config as SearxngSearchConfigSchema,
  SearxngSearchBackend,
} from "../src/web/providers/searxng-search.js";
import {
  WebFetchTool,
  WebSearchTool,
  createWebFetchTool,
  createWebSearchTool,
} from "../src/web/tools.js";

declare const fetch: WebFetch;
declare const search: WebSearch;

const fetchResult: Promise<WebFetchResult> = fetch.fetch({
  spec: await fetch.resolve({ url: "https://example.com/" }),
  context: null as never,
  grant: null as never,
});
const searchResult: Promise<WebSearchResult> = search.search({
  spec: await search.resolve({ query: "Wish agent" }),
  context: null as never,
  grant: null as never,
});
const backend: WebFetch = new HttpWebFetchBackend({ maxResponseBytes: 10_000 });
const config = HttpWebFetchConfigSchema({ timeoutSeconds: 10 });
const fetchTool = createWebFetchTool({ fetch });
const searchTool = createWebSearchTool({ search });
const fetchPlugin: object = WebFetchTool;
const searchPlugin: object = WebSearchTool;
declare const fiber: Fiber;
const providerFiber: Fiber = fiber.ctx.plugin(HttpWebFetch, config);
const searchBackend: WebSearch = new SearxngSearchBackend({
  baseUrl: "https://search.example/",
});
const searchConfig = SearxngSearchConfigSchema({
  baseUrl: "https://search.example/",
  maxResults: 10,
});
const searchProviderFiber: Fiber = fiber.ctx.plugin(SearxngSearch, searchConfig);

void fetchResult;
void searchResult;
void backend;
void fetchTool;
void searchTool;
void fetchPlugin;
void searchPlugin;
void providerFiber;
void searchBackend;
void searchProviderFiber;
