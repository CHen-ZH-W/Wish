import { readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";

import { EventCursorExpiredError } from "../../core/events/event.js";
import type { ModelRef } from "../../core/model/model.js";
import {
  RunGenerationRetiredError,
  type RunGenerationDrainTimeoutError,
} from "../../core/runtime/generation.js";
import { ModelsConfigurationError } from "../../models/config.js";
import {
  SessionAlreadyExistsError,
  SessionArchivedError,
  SessionCorruptionError,
  SessionIdempotencyConflictError,
  SessionInvalidTranscriptError,
  SessionNotFoundError,
  SessionRevisionConflictError,
} from "../../sessions/index.js";
import type {
  WishApplication,
  WishOutputEvent,
  WishRunControl,
} from "../types.js";
import type { WebToolApprovalBroker } from "./approval.js";
import type {
  WishWebApprovalEvent,
  WishWebRunView,
} from "./types.js";
import { wishWebRunAccepted } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_RETAINED_RUNS = 100;

const WEB_ASSETS = new Map<string, {
  readonly file: string;
  readonly contentType: string;
}>([
  ["/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/assets/app.css", { file: "app.css", contentType: "text/css; charset=utf-8" }],
  ["/assets/app.js", { file: "app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/favicon.svg", { file: "favicon.svg", contentType: "image/svg+xml" }],
]);

const WEB_ASSET_ROOT = new URL("./public/", import.meta.url);
const WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface WishWebUiServerOptions {
  readonly application: WishApplication;
  readonly approvals: WebToolApprovalBroker;
  /** New Sessions use this root unless the request explicitly supplies one. */
  readonly workspaceRoot: string;
  readonly host?: string;
  /** Port 0 is accepted for an ephemeral test/integration listener. */
  readonly port?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxJsonBodyBytes?: number;
  /** Bounded process-local query projection; Runtime events remain authoritative. */
  readonly maxRetainedRuns?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly onRunGenerationDrainTimeout?: (
    error: RunGenerationDrainTimeoutError,
  ) => void;
}

export interface StartedWishWebUiServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

interface WebServerState {
  readonly application: WishApplication;
  readonly approvals: WebToolApprovalBroker;
  readonly workspaceRoot: string;
  readonly heartbeatIntervalMs: number;
  readonly maxJsonBodyBytes: number;
  readonly maxRetainedRuns: number;
  readonly now: () => Date;
  readonly runs: Map<string, WishWebRunView>;
  /** Completion barriers for Runs started by this server generation. */
  readonly runCompletions: Map<string, Promise<void>>;
  readonly shutdownAbortedRuns: Set<string>;
  readonly shutdown: AbortController;
  readonly onRunGenerationDrainTimeout: (
    error: RunGenerationDrainTimeoutError,
  ) => void;
}

class WishWebApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "WishWebApiError";
  }
}

/** Start the transport adapter only; all Agent behavior stays in WishApplication. */
export async function startWishWebUiServer(
  options: WishWebUiServerOptions,
): Promise<StartedWishWebUiServer> {
  requireServerOptions(options);
  const host = requireText(options.host ?? DEFAULT_HOST, "WebUI host");
  const port = portNumber(options.port ?? DEFAULT_PORT, true);
  const workspaceRoot = await requireDirectory(options.workspaceRoot);
  const state: WebServerState = {
    application: options.application,
    approvals: options.approvals,
    workspaceRoot,
    heartbeatIntervalMs: positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "WebUI heartbeat interval",
    ),
    maxJsonBodyBytes: positiveInteger(
      options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES,
      "WebUI JSON body limit",
    ),
    maxRetainedRuns: positiveInteger(
      options.maxRetainedRuns ?? DEFAULT_MAX_RETAINED_RUNS,
      "WebUI retained Run limit",
    ),
    now: options.now ?? (() => new Date()),
    runs: new Map(),
    runCompletions: new Map(),
    shutdownAbortedRuns: new Set(),
    shutdown: new AbortController(),
    onRunGenerationDrainTimeout: options.onRunGenerationDrainTimeout ??
      (() => {}),
  };
  const server = createServer((request, response) => {
    void routeRequest(state, request, response).catch((error: unknown) => {
      options.onError?.(error);
      sendError(response, error);
    });
  });

  await new Promise<void>((accept, reject) => {
    const error = (cause: Error) => reject(cause);
    server.once("error", error);
    server.listen(port, host, () => {
      server.off("error", error);
      accept();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Wish WebUI server did not expose a TCP address");
  }
  const url = browserUrl(address.address, address.port);
  let closing: Promise<void> | undefined;
  return Object.freeze({
    server,
    url,
    close(): Promise<void> {
      closing ??= closeServer(server, state);
      return closing;
    },
  });
}

async function routeRequest(
  state: WebServerState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://wish.local");
  const operation = new AbortController();
  const abort = () => operation.abort("HTTP request was disconnected");
  const shutdown = () => operation.abort(state.shutdown.signal.reason);
  request.once("aborted", abort);
  state.shutdown.signal.addEventListener("abort", shutdown, { once: true });
  try {
    requireServing(state);
    const asset = WEB_ASSETS.get(url.pathname);
    if ((method === "GET" || method === "HEAD") && asset !== undefined) {
      await sendWebAsset(response, asset, method === "HEAD");
      return;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        status: "ok",
        agentId: state.application.agentId,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/sessions") {
      const status = sessionStatus(url.searchParams.get("status"));
      const sessions = await state.application.listSessions({
        ...(status === undefined ? {} : { status }),
        signal: operation.signal,
      });
      sendJson(response, 200, { sessions });
      return;
    }

    if (method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJsonObject(request, state.maxJsonBodyBytes);
      requireOnlyKeys(body, ["sessionId", "workspaceRoot", "title"]);
      const requestedWorkspace = optionalString(body, "workspaceRoot");
      const workspaceRoot = requestedWorkspace === undefined
        ? state.workspaceRoot
        : await requireDirectory(requestedWorkspace);
      const session = await state.application.createSession({
        workspaceRoot,
        ...optionalStringProperty(body, "sessionId"),
        ...optionalStringProperty(body, "title"),
        signal: operation.signal,
      });
      sendJson(response, 201, { session });
      return;
    }

    const sessionHistory = matchRoute(
      url.pathname,
      /^\/api\/sessions\/([^/]+)\/history$/u,
    );
    if (method === "GET" && sessionHistory !== undefined) {
      const history = await state.application.readSessionHistory({
        sessionId: sessionHistory,
        signal: operation.signal,
      });
      sendJson(response, 200, { history });
      return;
    }

    const sessionArchive = matchRoute(
      url.pathname,
      /^\/api\/sessions\/([^/]+)\/archive$/u,
    );
    if (method === "POST" && sessionArchive !== undefined) {
      const body = await readJsonObject(request, state.maxJsonBodyBytes);
      requireOnlyKeys(body, []);
      const session = await state.application.archiveSession({
        sessionId: sessionArchive,
        signal: operation.signal,
      });
      sendJson(response, 200, { session });
      return;
    }

    const sessionRuns = matchRoute(
      url.pathname,
      /^\/api\/sessions\/([^/]+)\/runs$/u,
    );
    if (method === "GET" && sessionRuns !== undefined) {
      await state.application.getSession({
        sessionId: sessionRuns,
        signal: operation.signal,
      });
      sendJson(response, 200, {
        runs: [...state.runs.values()].filter((run) =>
          run.sessionId === sessionRuns
        ),
      });
      return;
    }
    if (method === "POST" && sessionRuns !== undefined) {
      const body = await readJsonObject(request, state.maxJsonBodyBytes);
      requireOnlyKeys(body, ["text", "model"]);
      requireServing(state);
      const handle = await state.application.startRun({
        sessionId: sessionRuns,
        payload: {
          text: stringField(body, "text", false),
          ...optionalModelProperty(body, "model"),
        },
        metadata: Object.freeze({ source: "wish-webui" }),
        signal: operation.signal,
      });
      const accepted = wishWebRunAccepted(
        handle,
        validDate(state.now(), "WebUI clock").toISOString(),
      );
      state.runs.set(handle.runId, accepted.run);
      const completion = handle.completion.then(
        (completion) => {
          state.runs.set(handle.runId, Object.freeze({
            ...accepted.run,
            status: completion.status,
            completion,
          }));
          pruneRuns(state);
        },
        () => {
          state.runs.delete(handle.runId);
        },
      ).finally(() => {
        state.runCompletions.delete(handle.runId);
      });
      state.runCompletions.set(handle.runId, completion);
      void completion.catch(() => {
        // Both branches above settle normally; retain a final safety handler.
      });
      sendJson(response, 202, accepted);
      return;
    }

    const sessionMatch = matchRoute(
      url.pathname,
      /^\/api\/sessions\/([^/]+)$/u,
    );
    if (method === "GET" && sessionMatch !== undefined) {
      const session = await state.application.getSession({
        sessionId: sessionMatch,
        signal: operation.signal,
      });
      sendJson(response, 200, { session });
      return;
    }
    if (method === "PATCH" && sessionMatch !== undefined) {
      const body = await readJsonObject(request, state.maxJsonBodyBytes);
      requireOnlyKeys(body, ["title"]);
      if (!("title" in body)) {
        throw apiError(400, "invalid_request", "title is required");
      }
      const session = await state.application.updateSessionMetadata({
        sessionId: sessionMatch,
        title: nullableString(body, "title"),
        signal: operation.signal,
      });
      sendJson(response, 200, { session });
      return;
    }

    const runEvents = matchRoute(
      url.pathname,
      /^\/api\/runs\/([^/]+)\/events$/u,
    );
    if (method === "GET" && runEvents !== undefined) {
      await streamRunEvents(state, request, response, runEvents, url);
      return;
    }

    const runMatch = matchRoute(url.pathname, /^\/api\/runs\/([^/]+)$/u);
    if (method === "GET" && runMatch !== undefined) {
      const run = state.runs.get(runMatch);
      if (run === undefined) {
        throw apiError(404, "run_not_found", `Unknown WebUI Run: ${runMatch}`);
      }
      sendJson(response, 200, { run });
      return;
    }

    const runControls = matchRoute(
      url.pathname,
      /^\/api\/runs\/([^/]+)\/controls$/u,
    );
    if (method === "POST" && runControls !== undefined) {
      const body = await readJsonObject(request, state.maxJsonBodyBytes);
      const receipt = state.application.controlRun(
        runControls,
        webRunControl(body),
      );
      sendJson(response, 200, { receipt });
      return;
    }

    if (method === "GET" && url.pathname === "/api/approvals") {
      const requestedRunId = url.searchParams.get("runId");
      const runId = requestedRunId === null
        ? undefined
        : apiIdentifier(requestedRunId, "runId");
      sendJson(response, 200, {
        approvals: state.approvals.listPending(runId),
      });
      return;
    }

    const approvalMatch = matchRoute(
      url.pathname,
      /^\/api\/approvals\/([^/]+)$/u,
    );
    if (method === "POST" && approvalMatch !== undefined) {
      const body = await readJsonObject(request, state.maxJsonBodyBytes);
      requireOnlyKeys(body, ["approved"]);
      const approval = state.approvals.decide(
        approvalMatch,
        booleanField(body, "approved"),
      );
      if (approval === undefined) {
        throw apiError(
          404,
          "approval_not_found",
          "Approval is unknown or already resolved",
        );
      }
      sendJson(response, 200, { approval });
      return;
    }

    throw apiError(404, "not_found", "API route was not found");
  } finally {
    request.off("aborted", abort);
    state.shutdown.signal.removeEventListener("abort", shutdown);
  }
}

async function streamRunEvents(
  state: WebServerState,
  request: IncomingMessage,
  response: ServerResponse,
  runId: string,
  url: URL,
): Promise<void> {
  const afterSequence = eventCursor(request.headers, url.searchParams.get("after"));
  const observer = new AbortController();
  const stop = () => observer.abort("SSE observer disconnected");
  const shutdown = () => observer.abort(state.shutdown.signal.reason);
  request.once("aborted", stop);
  response.once("close", stop);
  state.shutdown.signal.addEventListener("abort", shutdown, { once: true });
  let events: AsyncIterable<WishOutputEvent>;
  try {
    events = state.application.observeRun(runId, {
      afterSequence,
      signal: observer.signal,
    });
  } catch (error: unknown) {
    cleanup();
    throw error;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  request.socket.setKeepAlive(true);
  const writer = new SseWriter(response);
  await writer.write(": connected\n\n");
  await writer.write(sseEvent(
    "stream.ready",
    { runId, afterSequence },
  ));
  const unsubscribe = state.approvals.subscribe(runId, (event) => {
    void writer.write(approvalSseEvent(event)).catch(() => {});
  });
  await writer.write(sseEvent("approval.snapshot", {
    approvals: state.approvals.listPending(runId),
  }));
  const heartbeat = setInterval(() => {
    void writer.write(`: heartbeat ${Date.now()}\n\n`).catch(() => {});
  }, state.heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    for await (const event of events) {
      await writer.write(sseEvent(event.type, event, String(event.sequence)));
    }
  } catch (error: unknown) {
    if (!observer.signal.aborted && !response.destroyed) {
      await writer.write(streamErrorEvent(error));
    }
  } finally {
    clearInterval(heartbeat);
    unsubscribe();
    cleanup();
    await writer.idle().catch(() => {});
    if (!response.destroyed && !response.writableEnded) response.end();
  }

  function cleanup(): void {
    request.off("aborted", stop);
    response.off("close", stop);
    state.shutdown.signal.removeEventListener("abort", shutdown);
  }
}

class SseWriter {
  private tail = Promise.resolve();

  constructor(private readonly response: ServerResponse) {}

  write(text: string): Promise<void> {
    const next = this.tail.then(() => writeResponse(this.response, text));
    this.tail = next.catch(() => {});
    return next;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

function approvalSseEvent(event: WishWebApprovalEvent): string {
  return sseEvent(event.type, { approval: event.approval });
}

function streamErrorEvent(error: unknown): string {
  if (error instanceof EventCursorExpiredError) {
    return sseEvent("stream.error", {
      error: {
        code: "event_cursor_expired",
        message: error.message,
        requestedAfter: error.requestedAfter,
        earliestAvailable: error.earliestAvailable,
      },
    });
  }
  return sseEvent("stream.error", {
    error: {
      code: "event_stream_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function sseEvent(event: string, data: unknown, id?: string): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function webRunControl(body: Readonly<Record<string, unknown>>): WishRunControl {
  const type = stringField(body, "type");
  if (type === "steer") {
    requireOnlyKeys(body, ["type", "id", "text"]);
    return Object.freeze({
      type,
      text: stringField(body, "text", false),
      source: "wish-webui",
      ...optionalStringProperty(body, "id"),
    });
  }
  if (type === "follow_up") {
    requireOnlyKeys(body, ["type", "id", "text"]);
    const text = stringField(body, "text", false);
    return Object.freeze({
      type,
      text,
      payload: Object.freeze({ text }),
      source: "wish-webui",
      ...optionalStringProperty(body, "id"),
    });
  }
  if (type === "abort") {
    requireOnlyKeys(body, ["type", "id", "reason"]);
    return Object.freeze({
      type,
      source: "wish-webui",
      ...optionalStringProperty(body, "id"),
      ...optionalStringProperty(body, "reason"),
    });
  }
  throw apiError(
    400,
    "invalid_request",
    "type must be steer, follow_up, or abort",
  );
}

function optionalModelProperty(
  body: Readonly<Record<string, unknown>>,
  field: string,
): { readonly model?: ModelRef } {
  const value = body[field];
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    throw apiError(400, "invalid_request", `${field} must be an object`);
  }
  requireOnlyKeys(value, ["provider", "model"]);
  return {
    model: Object.freeze({
      provider: stringField(value, "provider"),
      model: stringField(value, "model"),
    }),
  };
}

function sessionStatus(value: string | null): "active" | "archived" | undefined {
  if (value === null) return undefined;
  if (value === "active" || value === "archived") return value;
  throw apiError(400, "invalid_request", "status must be active or archived");
}

function eventCursor(
  headers: IncomingHttpHeaders,
  query: string | null,
): number {
  const rawHeader = headers["last-event-id"];
  const raw = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader) ?? query;
  if (raw === null || raw === undefined || raw.length === 0) return 0;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw apiError(
      400,
      "invalid_event_cursor",
      "Event cursor must be a non-negative integer",
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw apiError(
      400,
      "invalid_event_cursor",
      "Event cursor must be a non-negative safe integer",
    );
  }
  return value;
}

async function readJsonObject(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Readonly<Record<string, unknown>>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]
    ?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw apiError(
      415,
      "unsupported_media_type",
      "Mutating API requests require Content-Type: application/json",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw apiError(413, "request_too_large", "JSON request body is too large");
    }
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw apiError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!isPlainRecord(value)) {
    throw apiError(400, "invalid_request", "Request body must be a JSON object");
  }
  return value;
}

function requireOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw apiError(
      400,
      "invalid_request",
      `Unexpected field: ${unexpected}`,
    );
  }
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  field: string,
  trim = true,
): string {
  const item = value[field];
  if (typeof item !== "string" || item.trim().length === 0) {
    throw apiError(400, "invalid_request", `${field} must not be empty`);
  }
  if (trim && item !== item.trim()) {
    throw apiError(
      400,
      "invalid_request",
      `${field} must not have leading or trailing whitespace`,
    );
  }
  return item;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  return value[field] === undefined ? undefined : stringField(value, field);
}

function optionalStringProperty(
  value: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, string>> {
  const item = optionalString(value, field);
  return item === undefined ? {} : { [field]: item };
}

function nullableString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  return value[field] === null ? null : stringField(value, field);
}

function booleanField(
  value: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  const item = value[field];
  if (typeof item !== "boolean") {
    throw apiError(400, "invalid_request", `${field} must be boolean`);
  }
  return item;
}

function matchRoute(path: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(path)?.[1];
  if (value === undefined) return undefined;
  try {
    return requireText(decodeURIComponent(value), "Route id");
  } catch (error: unknown) {
    throw apiError(400, "invalid_route_id", "Route id is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function sendWebAsset(
  response: ServerResponse,
  asset: { readonly file: string; readonly contentType: string },
  headOnly: boolean,
): Promise<void> {
  const body = await readFile(new URL(asset.file, WEB_ASSET_ROOT));
  response.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": String(body.byteLength),
    "cache-control": "no-cache",
    "content-security-policy": WEB_CONTENT_SECURITY_POLICY,
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(headOnly ? undefined : body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    if (!response.destroyed) response.destroy();
    return;
  }
  const mapped = mapError(error);
  sendJson(response, mapped.status, {
    error: {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details === undefined ? {} : { details: mapped.details }),
    },
  });
}

function mapError(error: unknown): WishWebApiError {
  if (error instanceof WishWebApiError) return error;
  if (error instanceof SessionNotFoundError) {
    return apiError(404, error.code, error.message);
  }
  if (error instanceof SessionAlreadyExistsError) {
    return apiError(409, error.code, error.message);
  }
  if (
    error instanceof SessionArchivedError ||
    error instanceof SessionRevisionConflictError ||
    error instanceof SessionIdempotencyConflictError
  ) {
    return apiError(409, error.code, error.message);
  }
  if (
    error instanceof SessionCorruptionError ||
    error instanceof SessionInvalidTranscriptError
  ) {
    return apiError(500, error.code, error.message);
  }
  if (error instanceof ModelsConfigurationError) {
    return apiError(400, "invalid_model", error.message);
  }
  if (error instanceof RunGenerationRetiredError) {
    return apiError(503, error.code, error.message);
  }
  if (error instanceof Error && /already has an active Run/u.test(error.message)) {
    return apiError(409, "session_run_active", error.message);
  }
  if (error instanceof Error && /Run .* is not registered/u.test(error.message)) {
    return apiError(404, "run_not_found", error.message);
  }
  return apiError(500, "internal_error", "Internal WebUI server error");
}

function apiError(
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): WishWebApiError {
  return new WishWebApiError(status, code, message, details);
}

function writeResponse(response: ServerResponse, text: string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return Promise.reject(new Error("SSE response is closed"));
  }
  return new Promise((accept, reject) => {
    response.write(text, (error: Error | null | undefined) => {
      if (error === null || error === undefined) accept();
      else reject(error);
    });
  });
}

async function closeServer(server: Server, state: WebServerState): Promise<void> {
  state.shutdown.abort("Wish WebUI server is closing");
  state.approvals.close();
  const generationRetirement = state.application.runGeneration?.retire({
    reason: "Wish WebUI server is closing",
    onDrainTimeout: state.onRunGenerationDrainTimeout,
  });
  if (generationRetirement === undefined) abortRunningRuns(state);
  await new Promise<void>((accept, reject) => {
    server.close((error) => {
      if (error === undefined) accept();
      else reject(error);
    });
  });
  if (generationRetirement === undefined) abortRunningRuns(state);
  while (state.runCompletions.size > 0) {
    await Promise.all([...state.runCompletions.values()]);
  }
  await generationRetirement;
}

function abortRunningRuns(state: WebServerState): void {
  for (const run of state.runs.values()) {
    if (
      run.status !== "running" ||
      state.shutdownAbortedRuns.has(run.runId)
    ) continue;
    state.shutdownAbortedRuns.add(run.runId);
    try {
      state.application.controlRun(run.runId, {
        type: "abort",
        source: "wish-webui-shutdown",
        reason: "Wish WebUI server is closing",
      });
    } catch {
      // A terminal/pruned Run needs no shutdown action.
    }
  }
}

function requireServing(state: WebServerState): void {
  if (state.shutdown.signal.aborted) {
    throw apiError(
      503,
      "server_shutting_down",
      "Wish WebUI server is shutting down",
    );
  }
}

function pruneRuns(state: WebServerState): void {
  if (state.runs.size <= state.maxRetainedRuns) return;
  for (const [runId, run] of state.runs) {
    if (state.runs.size <= state.maxRetainedRuns) return;
    if (run.status !== "running") state.runs.delete(runId);
  }
}

async function requireDirectory(path: string): Promise<string> {
  const resolved = resolve(requireText(path, "WebUI workspace root"));
  let information;
  try {
    information = await stat(resolved);
  } catch (error: unknown) {
    throw apiError(400, "invalid_workspace", `Workspace cannot be read: ${resolved}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!information.isDirectory()) {
    throw apiError(400, "invalid_workspace", `Workspace is not a directory: ${resolved}`);
  }
  return realpath(resolved);
}

function requireServerOptions(options: WishWebUiServerOptions): void {
  if (
    options === null || typeof options !== "object" ||
    options.application === null || typeof options.application !== "object" ||
    options.approvals === null || typeof options.approvals !== "object"
  ) {
    throw new Error("Wish WebUI server requires Application and approvals");
  }
}

function browserUrl(host: string, port: number): string {
  const visibleHost = host === "0.0.0.0" || host === "::"
    ? "127.0.0.1"
    : host.includes(":") ? `[${host}]` : host;
  return `http://${visibleHost}:${port}`;
}

function portNumber(value: number, allowZero: boolean): number {
  if (
    !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) ||
    value > 65_535
  ) {
    throw new Error("WebUI port must be an integer from 0 to 65535");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must return a valid Date`);
  }
  return value;
}

function requireText(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function apiIdentifier(value: string, label: string): string {
  try {
    return requireText(value, label);
  } catch {
    throw apiError(
      400,
      "invalid_request",
      `${label} must be a non-empty trimmed string`,
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
