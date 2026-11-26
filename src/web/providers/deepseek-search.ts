import { createHash } from "node:crypto";
import { WebExecutionFailedError, WebInvalidRequestError, WebUnavailableError, WebUnsupportedContentError } from "../errors.js";
import type { ResolveWebSearchRequest, RunWebSearchRequest, WebSearch, WebSearchPolicy, WebSearchResult, WebSearchSource, WebSearchSpec } from "../types.js";
import { assertSearchAuthority, readSearchResponse } from "./search-io.js";

export const DEEPSEEK_SEARCH_CREDENTIAL = "WISH_DEEPSEEK_SEARCH_API_KEY";
const endpoint = "https://api.deepseek.com/v1/tools/search";

export interface DeepseekSearchOptions {
  readonly credential: () => string | undefined;
  readonly maxResults?: number;
  readonly timeoutSeconds?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class DeepseekSearchBackend implements WebSearch {
  readonly policy: WebSearchPolicy;
  private readonly issued = new WeakSet<WebSearchSpec>();
  constructor(private readonly options: DeepseekSearchOptions) {
    const values = { schemaVersion: 1 as const, providerId: "deepseek", endpoint, maxQueryLength: 128,
      maxResults: options.maxResults ?? 10, timeoutSeconds: options.timeoutSeconds ?? 20, maxResponseBytes: options.maxResponseBytes ?? 2000000 };
    if (!Number.isSafeInteger(values.maxResults) || values.maxResults < 1 || values.maxResults > 50 ||
      !Number.isFinite(values.timeoutSeconds) || values.timeoutSeconds <= 0 ||
      !Number.isSafeInteger(values.maxResponseBytes) || values.maxResponseBytes < 1) {
      throw new WebInvalidRequestError("DeepSeek Search limits are invalid");
    }
    this.policy = Object.freeze({ ...values, version: `sha256:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}` });
  }

  async resolve(request: ResolveWebSearchRequest): Promise<WebSearchSpec> {
    request.signal?.throwIfAborted();
    const count = request.maxResults ?? this.policy.maxResults;
    if (typeof request.query !== "string" || !request.query || request.query !== request.query.trim() || request.query.includes("\0") ||
      [...request.query].length > 128 || !Number.isSafeInteger(count) || count < 1 || count > this.policy.maxResults) {
      throw new WebInvalidRequestError("DeepSeek Search requires a query of 1–128 characters and a result count within the configured limit");
    }
    if (!this.options.credential()) throw new WebUnavailableError("DeepSeek Search API key is not configured", false);
    const spec = Object.freeze({ schemaVersion: 1 as const, providerId: this.policy.providerId, policyVersion: this.policy.version,
      query: request.query, maxResults: count });
    this.issued.add(spec);
    return spec;
  }

  async search(request: RunWebSearchRequest): Promise<WebSearchResult> {
    request.signal?.throwIfAborted();
    assertSearchAuthority(request, this.policy, this.issued);
    const key = this.options.credential();
    if (!key) throw new WebUnavailableError("DeepSeek Search API key is not configured", false);
    const timeout = AbortSignal.timeout(Math.ceil(this.policy.timeoutSeconds * 1000));
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: request.spec.query, count: request.spec.maxResults, need_content: false }),
      });
    } catch {
      request.signal?.throwIfAborted();
      throw new WebExecutionFailedError(timeout.aborted ? "DeepSeek Search request timed out" : "DeepSeek Search request failed");
    }
    // Never propagate an upstream response body or transport error containing credentials.
    if (!response.ok) {
      await response.body?.cancel();
      throw new WebUnavailableError(`DeepSeek Search API error (HTTP ${response.status})`, response.status === 408 || response.status === 429 || response.status >= 500);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/iu.test(contentType)) {
      await response.body?.cancel();
      throw new WebUnsupportedContentError("Expected JSON");
    }
    const text = await readSearchResponse(response, this.policy.maxResponseBytes, signal);
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new WebExecutionFailedError("DeepSeek Search response is not valid JSON"); }
    if (!isRecord(payload) || !Array.isArray(payload.results)) throw new WebExecutionFailedError("DeepSeek Search response has no results array");
    const sources: WebSearchSource[] = [], seen = new Set<string>();
    for (const item of payload.results) {
      if (!isRecord(item) || typeof item.url !== "string") continue;
      let url: URL;
      try { url = new URL(item.url); } catch { continue; }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href);
      if (sources.length >= request.spec.maxResults) continue;
      const title = typeof item.title === "string" ? item.title : undefined;
      const snippet = typeof item.summary === "string" && item.summary ? item.summary : typeof item.snippet === "string" ? item.snippet : undefined;
      const publishedAt = typeof item.date === "string" ? item.date : undefined;
      sources.push(Object.freeze({ url: url.href, ...(title === undefined ? {} : { title }), ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }) }));
    }
    return Object.freeze({ providerId: "deepseek", query: request.spec.query, sources: Object.freeze(sources), truncated: seen.size > sources.length });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
