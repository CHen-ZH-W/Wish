import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";

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
  WebUnsupportedContentError,
} from "../errors.js";
import { WebFetchService } from "../fetch-service.js";
import type {
  ResolveWebFetchRequest,
  RunWebFetchRequest,
  WebFetch,
  WebFetchAddress,
  WebFetchPolicy,
  WebFetchResult,
  WebFetchSpec,
} from "../types.js";
import { WebOwnerLifecycle } from "../lifecycle.js";

export const HTTP_WEB_FETCH_PROVIDER_ID = "http-public";
export const DEFAULT_WEB_FETCH_MAX_REDIRECTS = 5;
export const DEFAULT_WEB_FETCH_MAX_URL_LENGTH = 8_192;
export const DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES = 2_000_000;
export const DEFAULT_WEB_FETCH_TIMEOUT_SECONDS = 20;

export interface Config {
  readonly maxRedirects?: number;
  readonly maxUrlLength?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutSeconds?: number;
}

export const Config: s<Config> = s.object({
  maxRedirects: s.number().step(1).min(0),
  maxUrlLength: s.number().step(1).min(1),
  maxResponseBytes: s.number().step(1).min(1),
  timeoutSeconds: s.number().min(0.001),
});

export interface WebAddressResolver {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly WebFetchAddress[]>;
}

export interface RawWebResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Uint8Array;
}

export interface WebFetchTransport {
  request(input: {
    readonly url: string;
    readonly address: WebFetchAddress;
    readonly maxBytes: number;
    readonly timeoutSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<RawWebResponse>;
}

export interface HttpWebFetchBackendOptions extends Config {
  readonly resolver?: WebAddressResolver;
  readonly transport?: WebFetchTransport;
}

/** Public-network-only HTTP implementation reusable by tests and Cordis. */
export class HttpWebFetchBackend implements WebFetch {
  readonly policy: WebFetchPolicy;
  private readonly issued = new WeakSet<WebFetchSpec>();
  private readonly resolver: WebAddressResolver;
  private readonly transport: WebFetchTransport;

  constructor(options: HttpWebFetchBackendOptions = {}) {
    const values = {
      schemaVersion: 1 as const,
      providerId: HTTP_WEB_FETCH_PROVIDER_ID,
      protocols: Object.freeze(["http:", "https:"] as const),
      redirects: "same-origin" as const,
      maxRedirects: nonNegativeSafeInteger(
        options.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS,
        "Web Fetch maxRedirects",
      ),
      maxUrlLength: positiveSafeInteger(
        options.maxUrlLength ?? DEFAULT_WEB_FETCH_MAX_URL_LENGTH,
        "Web Fetch maxUrlLength",
      ),
      maxResponseBytes: positiveSafeInteger(
        options.maxResponseBytes ?? DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES,
        "Web Fetch maxResponseBytes",
      ),
      timeoutSeconds: positiveFiniteNumber(
        options.timeoutSeconds ?? DEFAULT_WEB_FETCH_TIMEOUT_SECONDS,
        "Web Fetch timeoutSeconds",
      ),
    };
    this.policy = Object.freeze({
      ...values,
      version: identity(values),
    });
    this.resolver = options.resolver ?? NODE_ADDRESS_RESOLVER;
    this.transport = options.transport ?? NODE_WEB_FETCH_TRANSPORT;
  }

  async resolve(request: ResolveWebFetchRequest): Promise<WebFetchSpec> {
    validateResolveRequest(request);
    throwIfAborted(request.signal);
    const url = normalizePublicUrl(request.url, this.policy.maxUrlLength);
    const addresses = await this.resolver.resolve(
      hostnameWithoutBrackets(url.hostname),
      request.signal,
    );
    throwIfAborted(request.signal);
    const publicAddresses = normalizePublicAddresses(addresses);
    const spec = Object.freeze({
      schemaVersion: 1 as const,
      providerId: this.policy.providerId,
      policyVersion: this.policy.version,
      requestedUrl: url.href,
      origin: url.origin,
      hostname: hostnameWithoutBrackets(url.hostname),
      port: resolvedPort(url),
      addresses: publicAddresses,
    });
    this.issued.add(spec);
    return spec;
  }

  async fetch(request: RunWebFetchRequest): Promise<WebFetchResult> {
    validateRunRequest(request);
    throwIfAborted(request.signal);
    this.assertAuthority(request);

    let current = await this.resolve({
      url: request.spec.requestedUrl,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (current.origin !== request.spec.origin) {
      throw new WebPolicyMismatchError("Web Fetch origin changed after approval");
    }

    for (let redirects = 0;; redirects += 1) {
      this.assertAuthority({ ...request, spec: current });
      const response = await this.request(current, request.signal);
      const location = headerValue(response.headers, "location");
      if (isRedirect(response.statusCode) && location !== undefined) {
        if (redirects >= this.policy.maxRedirects) {
          throw new WebAccessDeniedError(
            `Web Fetch exceeds ${this.policy.maxRedirects} redirects`,
          );
        }
        let target: URL;
        try {
          target = new URL(location, current.requestedUrl);
        } catch (cause: unknown) {
          throw new WebInvalidRequestError(
            "Web Fetch redirect location is invalid",
            { cause },
          );
        }
        if (target.origin !== request.spec.origin) {
          throw new WebAccessDeniedError(
            `Web Fetch cross-origin redirect is denied: ${target.origin}`,
          );
        }
        current = await this.resolve({
          url: target.href,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        continue;
      }
      return createResult(
        this.policy.providerId,
        request.spec.requestedUrl,
        current.requestedUrl,
        response,
        this.policy.maxResponseBytes,
      );
    }
  }

  private assertAuthority(request: RunWebFetchRequest): void {
    const { context, grant, spec } = request;
    if (!this.issued.has(spec)) {
      throw new WebPolicyMismatchError(
        "Web Fetch spec was not issued by this Provider",
      );
    }
    if (
      spec.providerId !== this.policy.providerId ||
      spec.policyVersion !== this.policy.version
    ) {
      throw new WebPolicyMismatchError("Web Fetch Provider policy changed");
    }
    if (
      context.permissions.workspace.fingerprint !== context.workspace.fingerprint ||
      context.permissions.workspace.revision !== context.workspace.revision
    ) {
      throw new WebPolicyMismatchError(
        "Permission Snapshot belongs to another Workspace Snapshot",
      );
    }
    if (!context.permissions.ceiling.allowedCapabilities.includes("web.fetch")) {
      throw new WebAccessDeniedError("Permission ceiling excludes web.fetch");
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
      requirement.capability === "web.fetch" &&
      requirement.providers.includes(this.policy.providerId) &&
      requirement.origins.includes(spec.origin)
    );
    if (!permitted) {
      throw new WebAccessDeniedError(
        `Grant does not include web.fetch for ${spec.origin}`,
      );
    }
  }

  private async request(
    spec: WebFetchSpec,
    signal?: AbortSignal,
  ): Promise<RawWebResponse> {
    const address = preferredAddress(spec.addresses);
    try {
      return await this.transport.request({
        url: spec.requestedUrl,
        address,
        maxBytes: this.policy.maxResponseBytes,
        timeoutSeconds: this.policy.timeoutSeconds,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (signal?.aborted === true) throw abortReason(signal);
      if (error instanceof WebError) throw error;
      throw new WebExecutionFailedError(
        `Web Fetch request failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

/** Cordis Provider for public, grant-scoped HTTP reads. */
export class HttpWebFetch extends WebFetchService {
  static readonly Config = Config;

  readonly policy: WebFetchPolicy;
  private readonly backend: HttpWebFetchBackend;
  private readonly lifecycle: WebOwnerLifecycle;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.backend = new HttpWebFetchBackend(config);
    this.policy = this.backend.policy;
    this.lifecycle = new WebOwnerLifecycle(ctx, "web_fetch_provider");
  }

  resolve(request: ResolveWebFetchRequest): Promise<WebFetchSpec> {
    return this.lifecycle.run(() => this.backend.resolve(request));
  }

  fetch(request: RunWebFetchRequest): Promise<WebFetchResult> {
    return this.lifecycle.run(() => this.backend.fetch(request));
  }
}

const NODE_ADDRESS_RESOLVER: WebAddressResolver = Object.freeze({
  async resolve(
    hostname: string,
    signal?: AbortSignal,
  ): Promise<readonly WebFetchAddress[]> {
    throwIfAborted(signal);
    const family = isIP(hostname);
    if (family === 4 || family === 6) {
      return Object.freeze([Object.freeze({ address: hostname, family })]);
    }
    try {
      const addresses = await lookup(hostname, {
        all: true,
        verbatim: true,
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);
      return Object.freeze(addresses.map((address) => Object.freeze({
        address: address.address,
        family: address.family as 4 | 6,
      })));
    } catch (cause: unknown) {
      if (signal?.aborted === true) throw abortReason(signal);
      throw new WebExecutionFailedError(
        `Web Fetch DNS resolution failed for ${hostname}: ${errorMessage(cause)}`,
        { cause },
      );
    }
  },
});

const NODE_WEB_FETCH_TRANSPORT: WebFetchTransport = Object.freeze({
  request(input: Parameters<WebFetchTransport["request"]>[0]) {
    return new Promise<RawWebResponse>((resolve, reject) => {
      const url = new URL(input.url);
      const request = url.protocol === "https:" ? requestHttps : requestHttp;
      const headers = {
        accept: "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
        "accept-encoding": "identity",
        host: url.host,
        "user-agent": "wish-web-fetch/1",
      };
      const req = request({
        protocol: url.protocol,
        hostname: input.address.address,
        port: resolvedPort(url),
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        ...(url.protocol === "https:" && isIP(hostnameWithoutBrackets(url.hostname)) === 0
          ? { servername: hostnameWithoutBrackets(url.hostname) }
          : {}),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const declaredLength = numberHeader(response.headers["content-length"]);
        if (declaredLength !== undefined && declaredLength > input.maxBytes) {
          response.destroy();
          reject(new WebResponseTooLargeError(input.maxBytes));
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          size += value.byteLength;
          if (size > input.maxBytes) {
            response.destroy(new WebResponseTooLargeError(input.maxBytes));
            return;
          }
          chunks.push(value);
        });
        response.once("error", reject);
        response.once("end", () => {
          const normalizedHeaders = Object.freeze(Object.fromEntries(
            Object.entries(response.headers).map(([name, value]) => [
              name.toLowerCase(),
              Array.isArray(value) ? Object.freeze([...value]) : value,
            ]),
          ));
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 0,
            headers: normalizedHeaders,
            body: new Uint8Array(Buffer.concat(chunks, size)),
          }));
        });
      });
      req.setTimeout(Math.ceil(input.timeoutSeconds * 1_000), () => {
        req.destroy(new WebExecutionFailedError("Web Fetch request timed out"));
      });
      req.once("error", reject);
      req.end();
    });
  },
});

const NON_PUBLIC_IPV4_ADDRESSES = createNonPublicIpv4BlockList();
const NON_PUBLIC_IPV6_ADDRESSES = createNonPublicIpv6BlockList();

function createNonPublicIpv4BlockList(): BlockList {
  const block = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) block.addSubnet(network, prefix, "ipv4");
  return block;
}

function createNonPublicIpv6BlockList(): BlockList {
  const block = new BlockList();
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) block.addSubnet(network, prefix, "ipv6");
  return block;
}

function normalizePublicUrl(value: string, maxLength: number): URL {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new WebInvalidRequestError(
      "Web Fetch URL must be a non-empty trimmed string without null bytes",
    );
  }
  if (value.length > maxLength) {
    throw new WebInvalidRequestError(
      `Web Fetch URL exceeds the ${maxLength} character limit`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause: unknown) {
    throw new WebInvalidRequestError("Web Fetch URL is invalid", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebAccessDeniedError("Web Fetch permits only HTTP and HTTPS URLs");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebAccessDeniedError("Web Fetch URL credentials are not allowed");
  }
  if (url.hash.length > 0) {
    throw new WebInvalidRequestError("Web Fetch URL fragments are not allowed");
  }
  const hostname = hostnameWithoutBrackets(url.hostname).toLowerCase();
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    hostname === "home.arpa" || hostname.endsWith(".home.arpa") ||
    (isIP(hostname) === 0 && !hostname.includes("."))
  ) {
    throw new WebAccessDeniedError(`Web Fetch hostname is not public: ${hostname}`);
  }
  return url;
}

function normalizePublicAddresses(
  addresses: readonly WebFetchAddress[],
): readonly WebFetchAddress[] {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new WebExecutionFailedError("Web Fetch hostname resolved to no addresses");
  }
  const unique = new Map<string, WebFetchAddress>();
  for (const item of addresses) {
    if (item === null || typeof item !== "object") {
      throw new WebExecutionFailedError("Web Fetch resolver returned an invalid address");
    }
    const family = isIP(item.address);
    if (family !== item.family || (family !== 4 && family !== 6)) {
      throw new WebExecutionFailedError(
        `Web Fetch resolver returned an invalid address: ${String(item.address)}`,
      );
    }
    const familyName = family === 4 ? "ipv4" : "ipv6";
    const nonPublic = family === 4
      ? NON_PUBLIC_IPV4_ADDRESSES.check(item.address, familyName)
      : NON_PUBLIC_IPV6_ADDRESSES.check(item.address, familyName);
    if (nonPublic) {
      throw new WebAccessDeniedError(
        `Web Fetch resolved to a non-public address: ${item.address}`,
      );
    }
    unique.set(`${family}:${item.address}`, Object.freeze({
      address: item.address,
      family,
    }));
  }
  return Object.freeze([...unique.values()]);
}

function preferredAddress(addresses: readonly WebFetchAddress[]): WebFetchAddress {
  const address = addresses.find((item) => item.family === 4) ?? addresses[0];
  if (address === undefined) {
    throw new WebExecutionFailedError("Web Fetch has no resolved address");
  }
  return address;
}

function createResult(
  providerId: string,
  requestedUrl: string,
  finalUrl: string,
  response: RawWebResponse,
  maxResponseBytes: number,
): WebFetchResult {
  if (!Number.isSafeInteger(response.statusCode) || response.statusCode < 100) {
    throw new WebExecutionFailedError("Web Fetch response has no valid status code");
  }
  if (!(response.body instanceof Uint8Array)) {
    throw new WebExecutionFailedError("Web Fetch response body is invalid");
  }
  if (response.body.byteLength > maxResponseBytes) {
    throw new WebResponseTooLargeError(maxResponseBytes);
  }
  const encoding = headerValue(response.headers, "content-encoding")
    ?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "identity") {
    throw new WebUnsupportedContentError(`content-encoding:${encoding}`);
  }
  const contentType = headerValue(response.headers, "content-type") ?? "";
  const { kind, mimeType } = classifyContentType(contentType);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  } catch (cause: unknown) {
    throw new WebUnsupportedContentError(
      `${mimeType}; charset must be UTF-8`,
    );
  }
  return Object.freeze({
    providerId,
    requestedUrl,
    finalUrl,
    statusCode: response.statusCode,
    contentType: mimeType,
    sha256: `sha256:${createHash("sha256").update(response.body).digest("hex")}`,
    size: response.body.byteLength,
    content: Object.freeze({ kind, text }),
    truncated: false,
  });
}

function classifyContentType(value: string): {
  readonly kind: "html" | "text";
  readonly mimeType: string;
} {
  const [rawMime = "", ...parameters] = value.split(";");
  const mimeType = rawMime.trim().toLowerCase();
  const charset = parameters.map((item) => item.trim().toLowerCase())
    .find((item) => item.startsWith("charset="))?.slice("charset=".length)
    .replace(/^"|"$/gu, "");
  if (charset !== undefined && charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii") {
    throw new WebUnsupportedContentError(`${mimeType}; charset=${charset}`);
  }
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
    return { kind: "html", mimeType };
  }
  if (
    mimeType.startsWith("text/") || mimeType === "application/json" ||
    mimeType.endsWith("+json") || mimeType === "application/xml" ||
    mimeType.endsWith("+xml")
  ) return { kind: "text", mimeType };
  throw new WebUnsupportedContentError(mimeType);
}

function validateResolveRequest(request: ResolveWebFetchRequest): void {
  if (request === null || typeof request !== "object") {
    throw new WebInvalidRequestError("Web Fetch resolve request must be an object");
  }
}

function validateRunRequest(request: RunWebFetchRequest): void {
  if (
    request === null || typeof request !== "object" ||
    request.spec === null || typeof request.spec !== "object" ||
    request.context === null || typeof request.context !== "object"
  ) throw new WebInvalidRequestError("Web Fetch run request is invalid");
}

function resolvedPort(url: URL): number {
  if (url.port.length > 0) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function headerValue(
  headers: RawWebResponse["headers"],
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : value?.[0];
}

function numberHeader(value: string | readonly string[] | undefined): number | undefined {
  const text = typeof value === "string" ? value : value?.[0];
  if (text === undefined || !/^\d+$/u.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : undefined;
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 ||
    statusCode === 307 || statusCode === 308;
}

function identity(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WebInvalidRequestError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WebInvalidRequestError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WebInvalidRequestError(`${label} must be a positive finite number`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Web Fetch was aborted", { cause: signal.reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default HttpWebFetch;
