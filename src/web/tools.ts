import type { Context } from "@deepseek-ai/cordis";

import type { ModelMessage } from "../core/model/model.js";
import { ToolExecutionError } from "../core/tools/executor.js";
import type {
  ToolDefinition,
  ToolInputParseResult,
  ToolResult,
} from "../core/tools/tool.js";
import type { WishToolExecutionContext } from "../composition/tool-context.js";
import { renderBasicToolResult } from "../tools/presentation/result-renderer.js";
import { WebError } from "./errors.js";
import type {
  WebFetch,
  WebFetchResult,
  WebFetchSpec,
  WebSearch,
  WebSearchResult,
  WebSearchSpec,
} from "./types.js";
import { WebOwnerLifecycle } from "./lifecycle.js";

export interface WebSearchToolInput {
  readonly query: string;
  readonly maxResults?: number;
}

export interface WebFetchToolInput {
  readonly url: string;
}

export interface WebSearchToolOptions {
  readonly search: WebSearch;
}

export interface WebFetchToolOptions {
  readonly fetch: WebFetch;
}

const WEB_SEARCH_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description: "One web search query",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      description: "Optional maximum number of sources",
    },
  },
  required: ["query"],
  additionalProperties: false,
});

const WEB_FETCH_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    url: {
      type: "string",
      minLength: 1,
      description: "Absolute public HTTP or HTTPS URL to read",
    },
  },
  required: ["url"],
  additionalProperties: false,
});

export function createWebSearchTool(
  options: WebSearchToolOptions,
): ToolDefinition<
  "web_search",
  WebSearchToolInput,
  WebSearchResult,
  WishToolExecutionContext
> {
  const specs = new WeakMap<WebSearchToolInput, WebSearchSpec>();
  return {
    name: "web_search",
    description:
      "Search the public web through the configured search provider. Returns source URLs, titles, and snippets.",
    inputSchemaJson: WEB_SEARCH_INPUT_SCHEMA,
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse: parseWebSearchInput,
    async resolveCapabilities(input, _context, signal) {
      try {
        const spec = await options.search.resolve({
          query: input.query,
          ...(input.maxResults === undefined
            ? {}
            : { maxResults: input.maxResults }),
          ...(signal === undefined ? {} : { signal }),
        });
        specs.set(input, spec);
        return {
          requirements: [{
            capability: "web.search",
            providers: [spec.providerId],
          }],
          effects: { openWorld: true },
        };
      } catch (error: unknown) {
        throw toolError(error);
      }
    },
    async execute(input, context, grant, signal) {
      const spec = specs.get(input);
      if (spec === undefined) {
        throw new ToolExecutionError(
          "permission_denied",
          "Web Search has no approved Provider spec",
        );
      }
      try {
        return await options.search.search({
          spec,
          context,
          grant,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error: unknown) {
        throw toolError(error);
      }
    },
  };
}

export function createWebFetchTool(
  options: WebFetchToolOptions,
): ToolDefinition<
  "web_fetch",
  WebFetchToolInput,
  WebFetchResult,
  WishToolExecutionContext
> {
  const specs = new WeakMap<WebFetchToolInput, WebFetchSpec>();
  return {
    name: "web_fetch",
    description:
      "Read one public HTTP or HTTPS resource through the configured SSRF-resistant Web Fetch provider.",
    inputSchemaJson: WEB_FETCH_INPUT_SCHEMA,
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse: parseWebFetchInput,
    async resolveCapabilities(input, _context, signal) {
      try {
        const spec = await options.fetch.resolve({
          url: input.url,
          ...(signal === undefined ? {} : { signal }),
        });
        specs.set(input, spec);
        return {
          requirements: [{
            capability: "web.fetch",
            providers: [spec.providerId],
            origins: [spec.origin],
          }],
          effects: { openWorld: true },
        };
      } catch (error: unknown) {
        throw toolError(error);
      }
    },
    async execute(input, context, grant, signal) {
      const spec = specs.get(input);
      if (spec === undefined) {
        throw new ToolExecutionError(
          "permission_denied",
          "Web Fetch has no approved Provider spec",
        );
      }
      try {
        return await options.fetch.fetch({
          spec,
          context,
          grant,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error: unknown) {
        throw toolError(error);
      }
    },
  };
}

export const WebSearchTool = {
  name: "web-search-tool",
  inject: ["tools", "webSearch"],
  apply(ctx: Context): void {
    const lifecycle = new WebOwnerLifecycle(ctx, "web_search_tool");
    ctx.tools.register(
      createWebSearchTool({ search: {
        policy: ctx.webSearch.policy,
        resolve: request => lifecycle.run(() => ctx.webSearch.resolve(request)),
        search: request => lifecycle.run(() => ctx.webSearch.search(request)),
      } }),
      { render: ({ result }) => renderWebSearchToolResult(result) },
    );
  },
};

export const WebFetchTool = {
  name: "web-fetch-tool",
  inject: ["tools", "webFetch"],
  apply(ctx: Context): void {
    const lifecycle = new WebOwnerLifecycle(ctx, "web_fetch_tool");
    ctx.tools.register(
      createWebFetchTool({ fetch: {
        policy: ctx.webFetch.policy,
        resolve: request => lifecycle.run(() => ctx.webFetch.resolve(request)),
        fetch: request => lifecycle.run(() => ctx.webFetch.fetch(request)),
      } }),
      { render: ({ result }) => renderWebFetchToolResult(result) },
    );
  },
};

export function renderWebSearchToolResult(result: ToolResult): ModelMessage {
  if (!result.ok || !isWebSearchResult(result.output)) {
    return renderBasicToolResult(result);
  }
  const lines = [
    `Web search provider: ${result.output.providerId}`,
    `Query: ${result.output.query}`,
    "",
    "--- BEGIN UNTRUSTED WEB SEARCH RESULTS ---",
  ];
  if (result.output.answer !== undefined) {
    lines.push(
      result.output.answer,
      "",
    );
  }
  lines.push("Sources:");
  if (result.output.sources.length === 0) lines.push("(none)");
  result.output.sources.forEach((source, index) => {
    lines.push(`[${index + 1}] ${source.title ?? source.url}`, source.url);
    if (source.snippet !== undefined) lines.push(source.snippet);
    if (source.publishedAt !== undefined) lines.push(`Published: ${source.publishedAt}`);
  });
  lines.push("--- END UNTRUSTED WEB SEARCH RESULTS ---");
  return Object.freeze({
    role: "tool" as const,
    content: lines.join("\n"),
    toolCallId: result.callId,
  });
}

export function renderWebFetchToolResult(result: ToolResult): ModelMessage {
  if (!result.ok || !isWebFetchResult(result.output)) {
    return renderBasicToolResult(result);
  }
  const output = result.output;
  return Object.freeze({
    role: "tool" as const,
    content: [
      `Fetched: ${output.finalUrl}`,
      `Status: ${output.statusCode}`,
      `Content-Type: ${output.contentType}`,
      `Content-SHA256: ${output.sha256}`,
      "",
      "--- BEGIN UNTRUSTED WEB CONTENT ---",
      output.content.text,
      "--- END UNTRUSTED WEB CONTENT ---",
    ].join("\n"),
    toolCallId: result.callId,
  });
}

function parseWebSearchInput(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<WebSearchToolInput> {
  const unknown = unknownKeys(input, ["query", "maxResults"]);
  if (unknown !== undefined) return { ok: false, message: `Unknown field: ${unknown}` };
  if (typeof input.query !== "string" || input.query.length === 0 || input.query !== input.query.trim()) {
    return { ok: false, message: "query must be a non-empty trimmed string" };
  }
  if (
    input.maxResults !== undefined &&
    (!Number.isSafeInteger(input.maxResults) || (input.maxResults as number) < 1)
  ) return { ok: false, message: "maxResults must be a positive safe integer" };
  return {
    ok: true,
    input: Object.freeze({
      query: input.query,
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults as number }),
    }),
  };
}

function parseWebFetchInput(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<WebFetchToolInput> {
  const unknown = unknownKeys(input, ["url"]);
  if (unknown !== undefined) return { ok: false, message: `Unknown field: ${unknown}` };
  if (typeof input.url !== "string" || input.url.length === 0 || input.url !== input.url.trim()) {
    return { ok: false, message: "url must be a non-empty trimmed string" };
  }
  return { ok: true, input: Object.freeze({ url: input.url }) };
}

function toolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof WebError) {
    const code = error.code === "web_invalid_request"
      ? "invalid_input"
      : error.code === "web_access_denied" || error.code === "web_policy_mismatch"
        ? "permission_denied"
        : "execution_failed";
    return new ToolExecutionError(code, error.message, error.retryable, {
      webErrorCode: error.code,
    });
  }
  return new ToolExecutionError(
    "execution_failed",
    error instanceof Error ? error.message : "Unknown Web Tool failure",
  );
}

function isWebSearchResult(value: unknown): value is WebSearchResult {
  return isRecord(value) && typeof value.providerId === "string" &&
    typeof value.query === "string" && Array.isArray(value.sources) &&
    typeof value.truncated === "boolean";
}

function isWebFetchResult(value: unknown): value is WebFetchResult {
  return isRecord(value) && typeof value.providerId === "string" &&
    typeof value.finalUrl === "string" &&
    Number.isSafeInteger(value.statusCode) && typeof value.contentType === "string" &&
    typeof value.sha256 === "string" && isRecord(value.content) &&
    typeof value.content.text === "string";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): string | undefined {
  const keys = new Set(allowed);
  return Object.keys(input).find((key) => !keys.has(key));
}
