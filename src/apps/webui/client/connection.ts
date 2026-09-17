import { SnapshotStore, freezeWire } from "./model/store.js";

export interface ConnectionSnapshot { readonly online: boolean; readonly businessAvailable: boolean; readonly instanceId: string | null; readonly error: string | null }
export class ClientApiError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }

/** Owns transport, token and reconnect; not a Session, plugin or UI state store. */
export class ClientConnection extends SnapshotStore<ConnectionSnapshot> {
  private token: string | undefined;
  private bootstrap: Promise<void> | undefined;
  private bootstrapVersion = 0;
  private events: EventSource | undefined;
  private invalidations = new Set<() => void>();
  private requests = new Set<AbortController>();
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private removeConnectivity: (() => void) | undefined;
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly eventSource: (url: string) => EventSource = url => new EventSource(url)) {
    super(Object.freeze({ online: false, businessAvailable: false, instanceId: null, error: null }));
  }
  async start(): Promise<void> {
    if (this.closed) throw new ClientApiError("connection_closed", 503);
    if (!this.removeConnectivity && typeof window !== "undefined") {
      const offline = () => {
        this.events?.close(); this.events = undefined;
        if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
        this.bootstrapVersion++;
        this.publish({ ...this.getSnapshot(), online: false, error: "浏览器已离线，操作已暂停；草稿保留，恢复后会重新核对 Host 状态。" });
      };
      const online = () => { void this.start().catch(() => {}); };
      window.addEventListener("offline", offline); window.addEventListener("online", online);
      this.removeConnectivity = () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); };
    }
    try { await this.refreshBootstrap(); }
    catch (error) {
      if (!this.closed && !this.retry) this.retry = setTimeout(() => { this.retry = undefined; void this.start().catch(() => {}); }, 3000);
      throw error;
    }
    if (this.closed || this.events) return;
    const events = this.eventSource("/api/management/events"); this.events = events;
    const current = () => !this.closed && this.events === events;
    for (const name of ["reset", "invalidated"]) events.addEventListener(name, () => {
      if (!current()) return;
      void this.refreshBootstrap().then(() => { if (current()) for (const listener of this.invalidations) { try { listener(); } catch { /* Isolate client observers. */ } } }).catch(() => {});
    });
    events.onerror = () => { if (current()) this.publish({ ...this.getSnapshot(), online: false, error: "连接中断，正在重连；操作结果请以刷新后的 Host 状态为准。" }); };
  }
  onInvalidation(listener: () => void): () => void { this.invalidations.add(listener); return () => { this.invalidations.delete(listener); }; }
  async refreshBootstrap(): Promise<void> {
    this.bootstrapVersion++;
    return this.bootstrap ??= (async () => {
      try {
        let version: number;
        do {
        version = this.bootstrapVersion;
        const value = await this.raw<{ token: string; instanceId: string; businessAvailable: boolean }>("/api/management/bootstrap", "GET");
        if (!/^[a-f0-9]{64}$/u.test(value.token) || typeof value.instanceId !== "string" || typeof value.businessAvailable !== "boolean") throw new ClientApiError("invalid_bootstrap", 502);
        this.token = value.token;
        if (!this.closed && version === this.bootstrapVersion) this.publish({ online: true, businessAvailable: value.businessAvailable, instanceId: value.instanceId, error: null });
        } while (!this.closed && version !== this.bootstrapVersion);
      } catch (error) {
        if (!this.closed) this.publish({ ...this.getSnapshot(), online: false, error: "无法连接管理服务，请检查 Wish 是否已启动。" }); throw error;
      }
    })().finally(() => { this.bootstrap = undefined; });
  }
  async request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    if (!this.token) await this.refreshBootstrap();
    return this.raw<T>(path, method, body);
  }
  stream(path: string): EventSource {
    if (this.closed) throw new ClientApiError("connection_closed", 503);
    return this.eventSource(path);
  }
  close(): void {
    this.closed = true; this.events?.close(); this.invalidations.clear();
    this.removeConnectivity?.(); this.removeConnectivity = undefined;
    if (this.retry) clearTimeout(this.retry);
    for (const request of this.requests) request.abort(); this.requests.clear();
  }
  private async raw<T>(path: string, method: string, body?: unknown): Promise<T> {
    if (this.closed) throw new ClientApiError("connection_closed", 503);
    if (!path.startsWith("/api/") || path.startsWith("//")) throw new ClientApiError("invalid_api_path", 400);
    const abort = new AbortController(); this.requests.add(abort);
    const deadline = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await this.fetcher(path, { method, credentials: "same-origin", signal: abort.signal,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.token ? { "X-Wish-Management-Token": this.token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      if (this.closed) throw new ClientApiError("connection_closed", 503);
      if (!response.ok) throw new ClientApiError(typeof value?.error?.code === "string" ? value.error.code : "request_failed", response.status);
      return freezeWire(value) as T;
    } finally { clearTimeout(deadline); this.requests.delete(abort); }
  }
}
