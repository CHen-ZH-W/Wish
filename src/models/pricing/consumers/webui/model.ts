import type { ClientConnection } from "../../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../../apps/webui/client/model/session.js";
import { RefreshQueue, SnapshotStore } from "../../../../apps/webui/client/model/store.js";
import type { SessionModelUsageView } from "../webui-types.js";

export interface ModelUsageClientSnapshot {
  readonly sessionId: string | null;
  readonly view: SessionModelUsageView | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Models-owned observer of durable usage; it never controls a Run or Session. */
export class ModelUsageClientModel extends SnapshotStore<ModelUsageClientSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private observedKey = "";
  private closed = false;

  constructor(
    private readonly connection: ClientConnection,
    private readonly sessions: SessionClientModel,
  ) {
    super(Object.freeze({ sessionId: null, view: null, loading: false, error: null }));
    this.queue = new RefreshQueue(async current => {
      const sessionId = this.getSnapshot().sessionId;
      if (!sessionId || !this.available()) return;
      try {
        const response = await connection.request<{ value: SessionModelUsageView }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/controls/model-usage`,
        );
        if (response.value.sessionId !== sessionId || response.value.scope !== "session" || response.value.schemaVersion !== 1) {
          throw new Error("模型用量响应与当前会话不匹配");
        }
        if (current() && this.getSnapshot().sessionId === sessionId) {
          this.publish({ sessionId, view: response.value, loading: false, error: null });
        }
      } catch (error) {
        if (current() && this.getSnapshot().sessionId === sessionId) {
          this.publish({ ...this.getSnapshot(), loading: false,
            error: error instanceof Error ? error.message : "模型用量读取失败" });
        }
      }
    });
    this.removers.push(
      sessions.subscribe(this.sync),
      sessions.run.subscribe(this.sync),
      connection.subscribe(this.sync),
      connection.onInvalidation(() => { void this.refresh(); }),
    );
    this.sync();
  }

  readonly refresh = (): Promise<void> => this.queue.request();

  close(): void {
    this.closed = true;
    this.queue.close();
    for (const remove of this.removers.splice(0)) remove();
  }

  private readonly sync = (): void => {
    if (this.closed) return;
    const connection = this.connection.getSnapshot();
    const sessions = this.sessions.getSnapshot();
    const run = this.sessions.run.getSnapshot();
    const active = connection.online && connection.businessAvailable;
    const sessionId = active ? sessions.selectedId : null;
    const terminalModelEvents = run.events.filter(event => event.type === "model.stream" &&
      (event.payload.type === "done" || event.payload.type === "error")).length;
    const key = `${connection.instanceId ?? ""}:${active}:${sessionId ?? ""}:${run.runId ?? ""}:${terminalModelEvents}:${run.terminal}`;
    if (key === this.observedKey) return;
    const changedSession = sessionId !== this.getSnapshot().sessionId;
    this.observedKey = key;
    this.publish({
      sessionId,
      view: changedSession ? null : this.getSnapshot().view,
      loading: !!sessionId && (changedSession || this.getSnapshot().view === null),
      error: null,
    });
    if (sessionId) void this.refresh();
  };

  private available(): boolean {
    const state = this.connection.getSnapshot();
    return !this.closed && state.online && state.businessAvailable;
  }
}
