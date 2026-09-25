import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { ManagedPluginControl } from "../../../boot/plugin-control/managed-control.js";
import type { PluginLifecycleInspection, PluginSelection } from "../../../boot/plugin-control/management-types.js";
import type { CredentialsPort } from "../../../credentials/types.js";
import type { SettingsPort } from "../../../settings/types.js";

export type WebRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export interface WebSurfaceRegistration { release(): void }
export interface WebManagementHost {
  readonly url: string;
  /** Root owns the listener. A business generation owns only this handler. */
  register(handler: WebRequestHandler): WebSurfaceRegistration;
  close(): Promise<void>;
}
declare module "@deepseek-ai/cordis" { interface Context { webManagementHost: WebManagementHost } }

class ManagementHttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

/** Loopback-only control plane. No Application, run state, business module or arbitrary RPC. */
export async function startWebManagementHost(options: {
  readonly root: Context;
  readonly control: ManagedPluginControl;
  readonly lifecycle: PluginLifecycleInspection;
  readonly settings: SettingsPort;
  readonly credentials: CredentialsPort;
  readonly port: number;
  readonly assets?: WebRequestHandler;
}): Promise<WebManagementHost> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid management port");
  let handler: WebRequestHandler | undefined;
  let closed = false, closing: Promise<void> | undefined;
  const clients = new Set<ServerResponse>();
  const token = randomBytes(32).toString("hex");
  let url = "", revision = 0;
  const server = createServer((request, response) => {
    void route(request, response).catch(error => {
      if (response.headersSent) { response.end(); return; }
      const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code) ? error.code : "management_request_failed";
      const status = error instanceof ManagementHttpError ? error.status : /conflict|busy|recovery|changed|unsettled|read_only/u.test(code) ? 409 : /invalid|validation/u.test(code) ? 400 : /missing/u.test(code) ? 404 : 503;
      json(response, status, { error: { code } });
    });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Management listener has no address");
  url = `http://127.0.0.1:${address.port}`;
  const notify = () => {
    revision++;
    const data = `event: invalidated\nid: ${revision}\ndata: ${JSON.stringify({ revision })}\n\n`;
    for (const client of clients) if (!client.write(data)) { clients.delete(client); client.end(); }
  };
  const removeControl = options.control.subscribe(notify), removeSettings = options.settings.subscribe(notify),
    removeCredentials = options.credentials.subscribe(notify);
  // Cordis events are invalidations only. Consumers re-read authoritative snapshots.
  const removeLoader = options.root.on("loader/partial-dispose", notify, { global: true });
  const heartbeat = setInterval(() => { for (const client of clients) if (!client.write(": heartbeat\n\n")) { clients.delete(client); client.end(); } }, 15000);
  heartbeat.unref(); options.control.setRecoveryAvailable(true);
  const host: WebManagementHost = Object.freeze({
    url,
    register(next: WebRequestHandler) {
      if (closed || handler) throw new Error("Business WebUI handler is unavailable or already registered");
      handler = next; notify(); let released = false;
      return { release: () => { if (!released && handler === next) { handler = undefined; notify(); } released = true; } };
    },
    close() {
      if (closing) return closing;
      closed = true; options.control.setRecoveryAvailable(false); handler = undefined;
      clearInterval(heartbeat); removeControl(); removeSettings(); removeCredentials(); removeLoader();
      for (const client of clients) client.end(); clients.clear();
      return closing = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
      });
    },
  });
  return host;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    const host = new URL(url).host;
    // No wildcard Host, forwarded origin, CORS or non-loopback deployment fallback.
    if (request.headers.host !== host) throw new ManagementHttpError(403, "management_host_denied");
    if (request.headers.origin !== undefined && request.headers.origin !== url) throw new ManagementHttpError(403, "management_origin_denied");
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") throw new ManagementHttpError(403, "management_origin_denied");
    if (closed) throw new ManagementHttpError(503, "management_closed");
    const path = new URL(request.url ?? "/", url).pathname;
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const received = request.headers["x-wish-management-token"];
      if (typeof received !== "string" || !/^[a-f0-9]{64}$/u.test(received) || !timingSafeEqual(Buffer.from(received), Buffer.from(token))) {
        throw new ManagementHttpError(403, "management_token_required");
      }
    }
    if (path.startsWith("/api/management/")) {
      if (method === "GET" && path === "/api/management/bootstrap") {
        json(response, 200, { token, instanceId: options.control.snapshot().inspection.instanceId, businessAvailable: !!handler }); return;
      }
      if (method === "GET" && path === "/api/management/plugins") { json(response, 200, options.control.snapshot()); return; }
      if (method === "GET" && path.startsWith("/api/management/plugins/operations/")) {
        const operationId = decodeURIComponent(path.slice("/api/management/plugins/operations/".length));
        if (!operationId || operationId.includes("/")) throw new ManagementHttpError(400, "management_invalid_request");
        const operation = options.control.operation(operationId);
        if (!operation) throw new ManagementHttpError(404, "management_operation_missing");
        json(response, 200, { operation, receipt: options.control.receipt(operation.requestId) ?? null }); return;
      }
      if (method === "GET" && path === "/api/management/settings") { json(response, 200, options.settings.describe()); return; }
      if (method === "GET" && path === "/api/management/events") {
        if (clients.size >= 16) throw new ManagementHttpError(429, "management_stream_limit");
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
        // Always reset on reconnect. IDs are advisory, not an event-replay promise.
        response.write(`event: reset\ndata: ${JSON.stringify({ revision })}\n\n`);
        clients.add(response); response.on("close", () => clients.delete(response)); return;
      }
      if (method === "POST" && path === "/api/management/plugins/preview") {
        const value = await body(request); only(value, ["instanceId", "entryIds"]);
        const selection = value as unknown as PluginSelection;
        json(response, 200, await options.lifecycle.collect(selection)); return;
      }
      if (method === "POST" && path === "/api/management/plugins/change") {
        json(response, 202, { operation: await options.control.submit(await body(request) as never) }); return;
      }
      if (method === "POST" && path === "/api/management/plugins/cancel") {
        const value = await body(request); only(value, ["operationId"]);
        if (typeof value.operationId !== "string") throw new ManagementHttpError(400, "management_invalid_request");
        json(response, 200, { cancelled: options.control.cancel(value.operationId) }); return;
      }
      if (method === "POST" && path === "/api/management/plugins/recover-disabled") {
        const value = await body(request); only(value, ["revision"]);
        if (typeof value.revision !== "string") throw new ManagementHttpError(400, "management_invalid_request");
        await options.control.recoverDisabled(value.revision); json(response, 200, options.control.snapshot()); return;
      }
      if (method === "POST" && path === "/api/management/settings/replace") {
        const value = await body(request); only(value, ["namespace", "revision", "user"]);
        if (typeof value.namespace !== "string" || typeof value.revision !== "string") throw new ManagementHttpError(400, "management_invalid_request");
        json(response, 200, await options.settings.replace(value as never)); return;
      }
      if (method === "POST" && path === "/api/management/credentials/describe") {
        const value = await body(request); only(value, ["references"]);
        if (!Array.isArray(value.references)) throw new ManagementHttpError(400, "management_invalid_request");
        json(response, 200, { credentials: options.credentials.describe(value.references as string[]) }); return;
      }
      if (method === "POST" && path === "/api/management/credentials/set") {
        const value = await body(request); only(value, ["reference", "value"]);
        if (typeof value.reference !== "string" || typeof value.value !== "string") throw new ManagementHttpError(400, "management_invalid_request");
        json(response, 200, { credential: await options.credentials.set(value.reference, value.value) }); return;
      }
      if (method === "POST" && path === "/api/management/credentials/delete") {
        const value = await body(request); only(value, ["reference"]);
        if (typeof value.reference !== "string") throw new ManagementHttpError(400, "management_invalid_request");
        json(response, 200, { credential: await options.credentials.delete(value.reference) }); return;
      }
      throw new ManagementHttpError(404, "management_route_missing");
    }
    if (!path.startsWith("/api/") && options.assets) { await options.assets(request, response); return; }
    if (handler) { await handler(request, response); return; }
    throw new ManagementHttpError(503, "business_unavailable");
  }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value));
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ManagementHttpError(400, "management_invalid_request");
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new ManagementHttpError(415, "management_json_required");
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > 262144) throw new ManagementHttpError(413, "management_body_too_large");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ManagementHttpError(400, "management_invalid_json"); }
}
