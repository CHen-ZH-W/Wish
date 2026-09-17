import type { CapabilityAuthorizationGrant } from
  "../permissions/authorization.js";
import type { PermissionSnapshot } from "../permissions/types.js";
import type { WorkspaceSnapshot } from "../workspace/types.js";

export interface WebExecutionContext {
  readonly workspace: WorkspaceSnapshot;
  readonly permissions: PermissionSnapshot;
}

export interface WebSearchPolicy {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly providerId: string;
  readonly maxQueryLength: number;
  readonly maxResults: number;
  readonly maxResponseBytes: number;
  readonly timeoutSeconds: number;
}

export interface ResolveWebSearchRequest {
  readonly query: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

/** Immutable Provider facts fixed before Tool approval starts. */
export interface WebSearchSpec {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly policyVersion: string;
  readonly query: string;
  readonly maxResults: number;
}

export interface RunWebSearchRequest {
  readonly spec: WebSearchSpec;
  readonly context: WebExecutionContext;
  readonly grant: CapabilityAuthorizationGrant;
  readonly signal?: AbortSignal;
}

export interface WebSearchSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
}

export interface WebSearchUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface WebSearchResult {
  readonly providerId: string;
  readonly query: string;
  readonly sources: readonly WebSearchSource[];
  readonly answer?: string;
  readonly usage?: WebSearchUsage;
  readonly truncated: boolean;
}

export interface WebSearch {
  readonly policy: WebSearchPolicy;

  resolve(request: ResolveWebSearchRequest): Promise<WebSearchSpec>;

  search(request: RunWebSearchRequest): Promise<WebSearchResult>;
}

export interface WebFetchPolicy {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly providerId: string;
  readonly protocols: readonly ["http:", "https:"];
  readonly redirects: "same-origin";
  readonly maxRedirects: number;
  readonly maxUrlLength: number;
  readonly maxResponseBytes: number;
  readonly timeoutSeconds: number;
}

export interface ResolveWebFetchRequest {
  readonly url: string;
  readonly signal?: AbortSignal;
}

export interface WebFetchAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Immutable public-network facts fixed before Tool approval starts. */
export interface WebFetchSpec {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly policyVersion: string;
  readonly requestedUrl: string;
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly addresses: readonly WebFetchAddress[];
}

export interface RunWebFetchRequest {
  readonly spec: WebFetchSpec;
  readonly context: WebExecutionContext;
  readonly grant: CapabilityAuthorizationGrant;
  readonly signal?: AbortSignal;
}

export interface WebFetchContent {
  readonly kind: "html" | "text";
  readonly text: string;
}

export interface WebFetchResult {
  readonly providerId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly statusCode: number;
  readonly contentType: string;
  readonly sha256: string;
  readonly size: number;
  readonly content: WebFetchContent;
  readonly truncated: boolean;
}

export interface WebFetch {
  readonly policy: WebFetchPolicy;

  resolve(request: ResolveWebFetchRequest): Promise<WebFetchSpec>;

  fetch(request: RunWebFetchRequest): Promise<WebFetchResult>;
}
