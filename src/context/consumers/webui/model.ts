import { ClientApiError, type ClientConnection } from "../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { RefreshQueue, SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { SessionContextOccupancyView } from "../webui-types.js";

export interface ContextOccupancyClientSnapshot {
  readonly sessionId: string | null;
  readonly view: SessionContextOccupancyView | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Observes Host-computed Context occupancy without counting tokens in the browser. */
export class ContextOccupancyClientModel extends SnapshotStore<ContextOccupancyClientSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private observedKey = "";
  private observedInstance: string | null = null;
  private observedRun: string | null = null;
  private observedSequence = 0;
  private refreshSequence = 0;
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
        const response = await connection.request<{ value: SessionContextOccupancyView }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/controls/context-occupancy`,
        );
        if (response.value.schemaVersion !== 1 || response.value.sessionId !== sessionId) {
          throw new Error("上下文占用响应与当前会话不匹配");
        }
        if (current() && this.available() && this.getSnapshot().sessionId === sessionId) {
          this.publish({ sessionId, view: response.value, loading: false, error: null });
        }
      } catch (error) {
        if (current() && this.available() && this.getSnapshot().sessionId === sessionId) {
          const revoked = error instanceof ClientApiError && (error.status === 401 || error.status === 403 ||
            ["control_not_found", "session_not_found", "business_unavailable", "management_closed", "connection_closed"].includes(error.code));
          this.publish({ sessionId, view: revoked ? null : this.getSnapshot().view, loading: false,
            error: error instanceof Error ? error.message : "上下文占用读取失败" });
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
    const connection = this.connection.getSnapshot(), sessions = this.sessions.getSnapshot();
    const run = this.sessions.run.getSnapshot();
    const active = connection.online && connection.businessAvailable;
    const sessionId = active ? sessions.selectedId : null;
    const changedInstance = this.observedInstance !== connection.instanceId;
    this.observedInstance = connection.instanceId;
    if (this.observedRun !== run.runId) {
      this.observedRun = run.runId;
      this.observedSequence = 0;
      this.refreshSequence = 0;
    }
    // Inspect only newly received events; streamed text never causes an HTTP read.
    for (let index = run.events.length - 1; index >= 0; index--) {
      const event = run.events[index]!;
      if (event.sequence <= this.observedSequence) break;
      if (event.type === "model.stream" && ["start", "done", "error"].includes(event.payload.type) ||
        event.type === "runtime.transition" && ["step.started", "step.completed", "step.failed", "step.aborted",
          "run.completed", "run.failed", "run.aborted"].includes(event.payload.type)) {
        this.refreshSequence = Math.max(this.refreshSequence, event.sequence);
      }
    }
    this.observedSequence = run.events.at(-1)?.sequence ?? this.observedSequence;
    const historyRevision = sessions.sessions.find(session => session.sessionId === sessionId)?.historyRevision ?? "";
    const key = `${connection.instanceId ?? ""}:${active}:${sessionId ?? ""}:${historyRevision}:${run.runId ?? ""}:${this.refreshSequence}`;
    if (key === this.observedKey) return;
    this.observedKey = key;
    const reset = changedInstance || sessionId !== this.getSnapshot().sessionId;
    this.publish({ sessionId, view: reset ? null : this.getSnapshot().view,
      loading: !!sessionId && (reset || this.getSnapshot().view === null), error: null });
    // Invalidate an in-flight response even when the current Session disappears.
    void this.refresh();
  };

  private available(): boolean {
    const state = this.connection.getSnapshot();
    return !this.closed && state.online && state.businessAvailable;
  }
}
