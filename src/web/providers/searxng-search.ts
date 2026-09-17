import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { assertActiveCapabilityAuthorizationGrant } from
  "../../permissions/authorization.js";
import {
  WebAccessDeniedError,
  WebError,
  WebExecutionFailedError,
  WebInvalidRequestError,
  WebPolicyMismatchError,
  WebResponseTooLargeError,
  WebUnavailableError,
  WebUnsupportedContentError,
} from "../errors.js";
import { WebSearchService } from "../search-service.js";
import type {
  ResolveWebSearchRequest,
  RunWebSearchRequest,
  WebSearch,
  WebSearchPolicy,
  WebSearchResult,
  WebSearchSource,
  WebSearchSpec,
} from "../types.js";
import { WebOwnerLifecycle } from "../lifecycle.js";

export const SEARXNG_SEARCH_PROVIDER_ID = "searxng";
export const DEFAULT_SEARXNG_LANGUAGE = "all";
export const DEFAULT_SEARXNG_CATEGORIES = "general";
export const DEFAULT_SEARXNG_SAFE_SEARCH = 1;
export const DEFAULT_SEARXNG_MAX_QUERY_LENGTH = 4_000;
export const DEFAULT_SEARXNG_MAX_RESULTS = 10;
export const DEFAULT_SEARXNG_MAX_RESPONSE_BYTES = 2_000_000;
export const DEFAULT_SEARXNG_TIMEOUT_SECONDS = 20;

export interface Config {
  readonly baseUrl?: string;
  readonly language?: string;
  readonly categories?: string;
  readonly safeSearch?: 0 | 1 | 2;
  readonly maxQueryLength?: number;
  readonly maxResults?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutSeconds?: number;
}

export const Config: s<Config> = s.object({
  baseUrl: s.string(),
  language: s.string(),
  categories: s.string(),
  safeSearch: s.union([s.const(0), s.const(1), s.const(2)]),
  maxQueryLength: s.number().step(1).min(1),
  maxResults: s.number().step(1).min(1),
  maxResponseBytes: s.number().step(1).min(1),
  timeoutSeconds: s.number().min(0.001),
});

export interface SearxngSearchPolicy extends WebSearchPolicy {
  readonly endpoint: string;
  readonly language: string;
  readonly categories: string;
  readonly safeSearch: 0 | 1 | 2;
}

export interface SearxngSearchBackendOptions extends Omit<Config, "baseUrl"> {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Direct search-engine aggregation through one explicitly configured SearXNG instance. */
export class SearxngSearchBackend implements WebSearch {
  readonly policy: SearxngSearchPolicy;
  private readonly issued = new WeakSet<WebSearchSpec>();
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: SearxngSearchBackendOptions) {
    const values = {
      schemaVersion: 1 as const,
      providerId: SEARXNG_SEARCH_PROVIDER_ID,
      endpoint: searchEndpoint(options.baseUrl),
      language: requireIdentifier(
        options.language ?? DEFAULT_SEARXNG_LANGUAGE,
        "SearXNG language",
      ),
      categories: requireIdentifier(
        options.categories ?? DEFAULT_SEARXNG_CATEGORIES,
        "SearXNG categories",
      ),
      safeSearch: safeSearchLevel(
        options.safeSearch ?? DEFAULT_SEARXNG_SAFE_SEARCH,
      ),
      maxQueryLength: positiveSafeInteger(
        options.maxQueryLength ?? DEFAULT_SEARXNG_MAX_QUERY_LENGTH,
        "SearXNG maxQueryLength",
      ),
      maxResults: positiveSafeInteger(
        options.maxResults ?? DEFAULT_SEARXNG_MAX_RESULTS,
        "SearXNG maxResults",
      ),
      maxResponseBytes: positiveSafeInteger(
        options.maxResponseBytes ?? DEFAULT_SEARXNG_MAX_RESPONSE_BYTES,
        "SearXNG maxResponseBytes",
      ),
      timeoutSeconds: positiveFiniteNumber(
        options.timeoutSeconds ?? DEFAULT_SEARXNG_TIMEOUT_SECONDS,
        "SearXNG timeoutSeconds",
      ),
    };
    this.policy = Object.freeze({
      ...values,
      version: identity(values),
    });
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async resolve(request: ResolveWebSearchRequest): Promise<WebSearchSpec> {
    validateResolveRequest(request);
    throwIfAborted(request.signal);
    const query = requireQuery(request.query, this.policy.maxQueryLength);
    const maxResults = request.maxResults ?? this.policy.maxResults;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
      throw new WebInvalidRequestError(
        "Web Search maxResults must be a positive safe integer",
      );
    }
    if (maxResults > this.policy.maxResults) {
      throw new WebInvalidRequestError(
        `Web Search maxResults must not exceed ${this.policy.maxResults}`,
      );
    }
    const spec = Object.freeze({
      schemaVersion: 1 as const,
      providerId: this.policy.providerId,
      policyVersion: this.policy.version,
      query,
      maxResults,
    });
    this.issued.add(spec);
    return spec;
  }

  async search(request: RunWebSearchRequest): Promise<WebSearchResult> {
    validateRunRequest(request);
    throwIfAborted(request.signal);
    this.assertAuthority(request);
    const url = new URL(this.policy.endpoint);
    url.searchParams.set("q", request.spec.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", this.policy.language);
    url.searchParams.set("categories", this.policy.categories);
    url.searchParams.set("safesearch", String(this.policy.safeSearch));

    const timeoutSignal = AbortSignal.timeout(
      Math.ceil(this.policy.timeoutSeconds * 1_000),
    );
    const signal = request.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([request.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "user-agent": "wish-web-search/1",
        },
        signal,
      });
    } catch (cause: unknown) {
      if (request.signal?.aborted === true) throw abortReason(request.signal);
      if (timeoutSignal.aborted) {
        throw new WebExecutionFailedError("SearXNG Search request timed out", {
          cause,
        });
      }
      throw new WebExecutionFailedError(
        `SearXNG Search request failed: ${errorMessage(cause)}`,
        { cause },
      );
    }

    const text = await readResponse(
      response,
      this.policy.maxResponseBytes,
      request.signal,
    );
    if (!response.ok) {
      throw new WebUnavailableError(
        `SearXNG Search API error (HTTP ${response.status}): ${bounded(text)}`,
        retryableStatus(response.status),
      );
    }
    requireJsonContentType(response.headers.get("content-type") ?? "");
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch (cause: unknown) {
      throw new WebExecutionFailedError(
        "SearXNG Search response is not valid JSON",
        { cause },
      );
    }
    return mapSearxngSearchResponse(payload, request.spec);
  }

  private assertAuthority(request: RunWebSearchRequest): void {
    const { context, grant, spec } = request;
    if (!this.issued.has(spec)) {
      throw new WebPolicyMismatchError(
        "Web Search spec was not issued by this Provider",
      );
    }
    if (
      spec.providerId !== this.policy.providerId ||
      spec.policyVersion !== this.policy.version
    ) throw new WebPolicyMismatchError("Web Search Provider policy changed");
    if (
      context.permissions.workspace.fingerprint !== context.workspace.fingerprint ||
      context.permissions.workspace.revision !== context.workspace.revision
    ) {
      throw new WebPolicyMismatchError(
        "Permission Snapshot belongs to another Workspace Snapshot",
      );
    }
    if (!context.permissions.ceiling.allowedCapabilities.includes("web.search")) {
      throw new WebAccessDeniedError("Permission ceiling excludes web.search");
    }
    try {
      assertActiveCapabilityAuthorizationGrant(grant, {
        policyVersion: context.permissions.policyVersion,
        authorityVersion: context.permissions.authorityVersion,
      });
    } catch (cause: unknown) {
      throw new WebAccessDeniedError(errorMessage(cause), { cause });
    }
    const permitted = grant.capabilities.requirements.some((requirement) =>
      requirement.capability === "web.search" &&
      requirement.providers.includes(this.policy.providerId)
    );
    if (!permitted) {
      throw new WebAccessDeniedError(
        `Grant does not include web.search for ${this.policy.providerId}`,
      );
    }
  }
}

/** Cordis Provider for one host-configured SearXNG instance. */
export class SearxngSearch extends WebSearchService {
  static readonly Config = Config;

  readonly policy: SearxngSearchPolicy;
  private readonly backend: SearxngSearchBackend;
  private readonly lifecycle: WebOwnerLifecycle;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    if (config.baseUrl === undefined) {
      throw new WebInvalidRequestError(
        "SearXNG baseUrl is required when the Provider is enabled",
      );
    }
    this.backend = new SearxngSearchBackend({
      baseUrl: config.baseUrl,
      ...(config.language === undefined ? {} : { language: config.language }),
      ...(config.categories === undefined ? {} : { categories: config.categories }),
      ...(config.safeSearch === undefined ? {} : { safeSearch: config.safeSearch }),
      ...(config.maxQueryLength === undefined
        ? {}
        : { maxQueryLength: config.maxQueryLength }),
      ...(config.maxResults === undefined ? {} : { maxResults: config.maxResults }),
      ...(config.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: config.maxResponseBytes }),
      ...(config.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: config.timeoutSeconds }),
    });
    this.policy = this.backend.policy;
    this.lifecycle = new WebOwnerLifecycle(ctx, "web_search_provider");
  }

  resolve(request: ResolveWebSearchRequest): Promise<WebSearchSpec> {
    return this.lifecycle.run(() => this.backend.resolve(request));
  }

  search(request: RunWebSearchRequest): Promise<WebSearchResult> {
    return this.lifecycle.run(() => this.backend.search(request));
  }
}

export function mapSearxngSearchResponse(
  payload: unknown,
  spec: WebSearchSpec,
): WebSearchResult {
  const root = record(payload, "SearXNG Search response");
  if (!Array.isArray(root.results)) {
    throw new WebExecutionFailedError(
      "SearXNG Search response results must be an array",
    );
  }
  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  let totalSources = 0;
  for (const raw of root.results) {
    if (!isRecord(raw)) continue;
    const url = publicResultUrl(raw.url);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    totalSources += 1;
    if (sources.length >= spec.maxResults) continue;
    const title = optionalString(raw.title);
    const snippet = optionalString(raw.content);
    const publishedAt = optionalString(raw.publishedDate) ??
      optionalString(raw.pubdate);
    sources.push(Object.freeze({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    }));
  }
  return Object.freeze({
    providerId: spec.providerId,
    query: spec.query,
    sources: Object.freeze(sources),
    truncated: totalSources > sources.length,
  });
}

async function readResponse(
  response: Response,
  maxBytes: number,
  callerSignal?: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new WebResponseTooLargeError(maxBytes);
  }
  if (response.body === null) {
    throw new WebExecutionFailedError("SearXNG Search response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new WebResponseTooLargeError(maxBytes);
      }
      chunks.push(item.value);
    }
  } catch (cause: unknown) {
    if (callerSignal?.aborted === true) throw abortReason(callerSignal);
    if (cause instanceof WebError) throw cause;
    throw new WebExecutionFailedError(
      `SearXNG Search response read failed: ${errorMessage(cause)}`,
      { cause },
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new WebExecutionFailedError(
      "SearXNG Search response is not valid UTF-8",
      { cause },
    );
  }
}

function searchEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause: unknown) {
    throw new WebInvalidRequestError("SearXNG baseUrl is invalid", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebInvalidRequestError("SearXNG baseUrl must use HTTP or HTTPS");
  }
  if (
    url.username.length > 0 || url.password.length > 0 ||
    url.search.length > 0 || url.hash.length > 0
  ) {
    throw new WebInvalidRequestError(
      "SearXNG baseUrl must not contain credentials, query, or fragment",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL("search", url).href;
}

function requireJsonContentType(value: string): void {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType !== "application/json" && !mimeType.endsWith("+json")) {
    throw new WebUnsupportedContentError(mimeType);
  }
}

function publicResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 || url.password.length > 0
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function validateResolveRequest(request: ResolveWebSearchRequest): void {
  if (request === null || typeof request !== "object") {
    throw new WebInvalidRequestError("Web Search resolve request must be an object");
  }
}

function validateRunRequest(request: RunWebSearchRequest): void {
  if (
    request === null || typeof request !== "object" ||
    request.spec === null || typeof request.spec !== "object" ||
    request.context === null || typeof request.context !== "object"
  ) throw new WebInvalidRequestError("Web Search run request is invalid");
}

function requireQuery(value: string, maxLength: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new WebInvalidRequestError(
      "Web Search query must be a non-empty trimmed string without null bytes",
    );
  }
  if (value.length > maxLength) {
    throw new WebInvalidRequestError(
      `Web Search query exceeds the ${maxLength} character limit`,
    );
  }
  return value;
}

function safeSearchLevel(value: number): 0 | 1 | 2 {
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new WebInvalidRequestError("SearXNG safeSearch must be 0, 1, or 2");
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new WebInvalidRequestError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WebInvalidRequestError(`${label} must be a positive safe integer`);
  }
  return value;
}

function positiveFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WebInvalidRequestError(`${label} must be a positive finite number`);
  }
  return value;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new WebExecutionFailedError(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function identity(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function bounded(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return "empty response";
  return normalized.length <= 1_000
    ? normalized
    : `${normalized.slice(0, 1_000)}…`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Web Search was aborted", { cause: signal.reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default SearxngSearch;
