import { ClientApiError, type ClientConnection } from "../../../apps/webui/client/connection.js";
import { SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { UserTerminalFrame, UserTerminalShellChoice, UserTerminalView } from "../../types.js";

export interface TerminalRenderFrame {
  readonly revision: number;
  readonly frame: Extract<UserTerminalFrame, { readonly type: "snapshot" | "output" }>;
}

export interface UserTerminalClientSnapshot {
  readonly sessionId: string | null;
  readonly authority: "host-user" | null;
  readonly terminals: readonly UserTerminalView[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly observedTerminalId: string | null;
  readonly streamPhase: "idle" | "connecting" | "connected" | "disconnected" | "failed";
  readonly writable: boolean;
  readonly render: TerminalRenderFrame | undefined;
}

const empty = (): UserTerminalClientSnapshot => Object.freeze({
  sessionId: null, authority: null, terminals: Object.freeze([]), pending: false, error: null,
  observedTerminalId: null, streamPhase: "idle", writable: false, render: undefined,
});

/** Roster queries are snapshots; screen bytes use one detachable SSE stream. */
export class UserTerminalClientModel extends SnapshotStore<UserTerminalClientSnapshot> {
  private closed = false;
  private generation = 0;
  private refreshing: Promise<void> | undefined;
  private source: EventSource | undefined;
  private attachmentId: string | undefined;
  private streamGeneration = 0;
  private sequence = 0;
  private writes = Promise.resolve();
  private revision = 0;
  private pendingRevision: number | undefined;
  private readonly renderQueue: Extract<UserTerminalFrame, { readonly type: "snapshot" | "output" }>[] = [];
  private queuedBytes = 0;

  constructor(private readonly connection: ClientConnection) { super(empty()); }

  refresh(sessionId: string, foreground = false): Promise<void> {
    if (this.refreshing && this.getSnapshot().sessionId === sessionId) return this.refreshing;
    const generation = ++this.generation;
    const previous = this.getSnapshot();
    if (foreground || previous.sessionId !== sessionId) this.publish({ ...previous, sessionId, pending: true, error: null });
    this.refreshing = (async () => {
      try {
        const response = await this.connection.request<{ value: { schemaVersion: 2; sessionId: string; authority: "host-user"; terminals: readonly UserTerminalView[] } }>(`/api/sessions/${encodeURIComponent(sessionId)}/controls/user-terminal`);
        if (!this.closed && generation === this.generation && response.value.sessionId === sessionId) {
          const current = this.getSnapshot();
          if (current.observedTerminalId !== null && !response.value.terminals.some(item => item.id === current.observedTerminalId)) this.disconnect();
          if (current.authority !== response.value.authority || current.pending || current.error || !sameTerminals(current.terminals, response.value.terminals)) {
            this.publish({ ...this.getSnapshot(), sessionId, authority: response.value.authority, terminals: response.value.terminals, pending: false, error: null });
          }
        }
      } catch (cause) {
        if (!this.closed && generation === this.generation) this.publish({ ...this.getSnapshot(), pending: false, error: errorCode(cause) });
      } finally { if (generation === this.generation) this.refreshing = undefined; }
    })();
    return this.refreshing;
  }

  observe(sessionId: string, terminalId: string): void {
    if (this.closed || (this.source && this.getSnapshot().sessionId === sessionId && this.getSnapshot().observedTerminalId === terminalId)) return;
    this.disconnect();
    const generation = ++this.streamGeneration;
    const attachmentId = browserId(); this.attachmentId = attachmentId; this.sequence = 0;
    this.publish({ ...this.getSnapshot(), sessionId, observedTerminalId: terminalId, streamPhase: "connecting", writable: false, error: null, render: undefined });
    const source = this.connection.stream(`/api/sessions/${encodeURIComponent(sessionId)}/streams/user-terminal?terminalId=${encodeURIComponent(terminalId)}&attachmentId=${encodeURIComponent(attachmentId)}`);
    this.source = source;
    const current = () => !this.closed && this.source === source && this.streamGeneration === generation;
    source.addEventListener("terminal.snapshot", event => {
      if (!current()) return;
      try {
        const frame = terminalFrame(event, "snapshot"); this.sequence = frame.sequence; this.clearRenderQueue();
        this.applyTerminal(frame.terminal, frame.writable); this.enqueueRender(frame);
      } catch (cause) { this.failStream(source, cause); }
    });
    source.addEventListener("terminal.output", event => {
      if (!current()) return;
      try {
        const frame = terminalFrame(event, "output");
        if (frame.sequence !== this.sequence + 1) throw new Error("Terminal output sequence has a gap");
        this.sequence = frame.sequence; this.enqueueRender(frame);
      } catch (cause) { this.failStream(source, cause); }
    });
    source.addEventListener("terminal.state", event => {
      if (!current()) return;
      try { const frame = terminalFrame(event, "state"); this.applyTerminal(frame.terminal, frame.writable); }
      catch (cause) { this.failStream(source, cause); }
    });
    source.addEventListener("stream.error", event => { if (current()) this.failStream(source, messageError(event)); });
    source.onerror = () => {
      if (current()) this.publish({ ...this.getSnapshot(), streamPhase: "disconnected", writable: false, error: "终端连接已断开，正在重连。" });
    };
  }

  acknowledge(revision: number): void {
    if (this.pendingRevision !== revision) return;
    this.pendingRevision = undefined; this.deliverNext();
  }

  suspend(): void { this.disconnect(); }

  async listShells(sessionId: string): Promise<readonly UserTerminalShellChoice[]> {
    const response = await this.connection.request<{ value: { readonly shells: readonly UserTerminalShellChoice[] } }>(`/api/sessions/${encodeURIComponent(sessionId)}/controls/user-terminal`, { action: "shells" });
    return response.value.shells;
  }

  async create(sessionId: string, shellPath?: string): Promise<UserTerminalView> {
    this.publish({ ...this.getSnapshot(), sessionId, pending: true, error: null });
    try {
      const response = await this.connection.request<{ value: UserTerminalView }>(`/api/sessions/${encodeURIComponent(sessionId)}/controls/user-terminal`, { action: "create", ...(shellPath === undefined ? {} : { shellPath }) });
      if (!this.closed) {
        const current = this.getSnapshot();
        this.publish({ ...current, sessionId, terminals: Object.freeze([...current.terminals.filter(item => item.id !== response.value.id), response.value]), pending: false, error: null });
      }
      return response.value;
    } catch (cause) {
      if (!this.closed) this.publish({ ...this.getSnapshot(), pending: false, error: errorCode(cause) });
      throw cause;
    }
  }

  writeRaw(sessionId: string, terminalId: string, text: string): void {
    const attachmentId = this.attachmentId;
    if (!text || this.closed || !attachmentId || !this.getSnapshot().writable || this.getSnapshot().observedTerminalId !== terminalId) return;
    this.writes = this.writes.then(async () => {
      if (this.attachmentId !== attachmentId || !this.getSnapshot().writable) return;
      await this.connection.request(`/api/sessions/${encodeURIComponent(sessionId)}/controls/user-terminal`, { action: "write", terminalId, attachmentId, text });
    }).catch(cause => { if (!this.closed && this.attachmentId === attachmentId) this.publish({ ...this.getSnapshot(), error: errorCode(cause) }); });
  }

  resize(sessionId: string, terminalId: string, columns: number, rows: number): void {
    const attachmentId = this.attachmentId;
    if (!attachmentId || !this.getSnapshot().writable || this.getSnapshot().observedTerminalId !== terminalId) return;
    this.writes = this.writes.then(async () => {
      if (this.attachmentId !== attachmentId || !this.getSnapshot().writable) return;
      await this.connection.request(`/api/sessions/${encodeURIComponent(sessionId)}/controls/user-terminal`, { action: "resize", terminalId, attachmentId, columns, rows });
    }).catch(cause => { if (!this.closed && this.attachmentId === attachmentId) this.publish({ ...this.getSnapshot(), error: errorCode(cause) }); });
  }

  async closeTerminal(sessionId: string, terminalId: string): Promise<void> {
    if (this.getSnapshot().observedTerminalId === terminalId) this.disconnect();
    await this.mutate(sessionId, { action: "close", terminalId });
  }

  close(): void { this.closed = true; this.generation++; this.disconnect(); this.clearRenderQueue(); }

  private async mutate(sessionId: string, body: unknown): Promise<void> {
    this.publish({ ...this.getSnapshot(), pending: true, error: null });
    try { await this.connection.request(`/api/sessions/${encodeURIComponent(sessionId)}/controls/user-terminal`, body); await this.refresh(sessionId); }
    catch (cause) { if (!this.closed) this.publish({ ...this.getSnapshot(), pending: false, error: errorCode(cause) }); throw cause; }
  }

  private applyTerminal(terminal: UserTerminalView, writable: boolean): void {
    const current = this.getSnapshot();
    const terminals = current.terminals.some(item => item.id === terminal.id)
      ? current.terminals.map(item => item.id === terminal.id ? terminal : item)
      : [...current.terminals, terminal];
    this.publish({ ...current, terminals: Object.freeze(terminals), streamPhase: "connected", writable, error: null });
  }

  private enqueueRender(frame: Extract<UserTerminalFrame, { readonly type: "snapshot" | "output" }>): void {
    const bytes = frame.type === "output"
      ? new TextEncoder().encode(frame.data).byteLength
      : new TextEncoder().encode(frame.screen).byteLength + 256;
    if (this.queuedBytes + bytes > 2 * 1024 * 1024) { this.failStream(this.source, new Error("终端输出积压过多，请重新连接。")); return; }
    this.renderQueue.push(frame); this.queuedBytes += bytes; this.deliverNext();
  }

  private deliverNext(): void {
    if (this.pendingRevision !== undefined) return;
    const frame = this.renderQueue.shift(); if (frame === undefined) return;
    this.queuedBytes -= frame.type === "output"
      ? new TextEncoder().encode(frame.data).byteLength
      : new TextEncoder().encode(frame.screen).byteLength + 256;
    const revision = ++this.revision; this.pendingRevision = revision;
    this.publish({ ...this.getSnapshot(), render: Object.freeze({ revision, frame }) });
  }

  private clearRenderQueue(): void { this.renderQueue.length = 0; this.queuedBytes = 0; this.pendingRevision = undefined; }

  private failStream(source: EventSource | undefined, cause: unknown): void {
    if (source && this.source !== source) return;
    source?.close(); if (this.source === source) this.source = undefined;
    this.attachmentId = undefined; this.clearRenderQueue();
    if (!this.closed) this.publish({ ...this.getSnapshot(), streamPhase: "failed", writable: false, error: errorCode(cause) });
  }

  private disconnect(): void {
    this.streamGeneration++; this.source?.close(); this.source = undefined; this.attachmentId = undefined;
    this.clearRenderQueue();
    if (!this.closed) this.publish({ ...this.getSnapshot(), observedTerminalId: null, streamPhase: "idle", writable: false, render: undefined });
  }
}

function sameTerminals(left: readonly UserTerminalView[], right: readonly UserTerminalView[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.id === other.id && item.label === other.label && item.createdAt === other.createdAt
      && item.active === other.active && item.authority === other.authority && item.shell === other.shell && item.exitCode === other.exitCode
      && item.columns === other.columns && item.rows === other.rows;
  });
}

function terminalFrame<T extends UserTerminalFrame["type"]>(event: Event, type: T): Extract<UserTerminalFrame, { readonly type: T }> {
  const value: unknown = JSON.parse((event as MessageEvent).data);
  if (!value || typeof value !== "object" || (value as UserTerminalFrame).type !== type) throw new Error("Terminal stream returned an invalid frame");
  return value as Extract<UserTerminalFrame, { readonly type: T }>;
}
function messageError(event: Event): Error { try { const value = JSON.parse((event as MessageEvent).data); return new Error(value?.error?.message ?? "Terminal stream failed"); } catch { return new Error("Terminal stream failed"); } }
function errorCode(cause: unknown): string { return cause instanceof ClientApiError ? cause.message : cause instanceof Error ? cause.message : "terminal_unavailable"; }
function browserId(): string { return globalThis.crypto?.randomUUID?.() ?? `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
